# Per-Building Parking Distribution — Implementation Spec

**For Claude Code. Read `SUMMARY.md` first to restore context.**

Build this in **two phases. Stop and let me test after each phase.** Phase 1 is a pure
scoring change (additive, low-risk). Phase 2 touches `buildCandidateSchema` — use **Plan Mode**.

---

## 0. Why this task

Big buildings demand large parking counts, and the current engine dumps **all** of those
stalls into lots anchored to **building A only**, then clips that oversized slab against
leftover free space — producing fragmented parking in unnatural pockets next to A while the
other buildings get none.

Two coupled defects cause this:

1. **Schema clusters all parking on the first child.** In `optimize.js buildCandidateSchema`,
   the multi-building branch sets `firstBuildingId = reqs.buildings[0].label` and emits one
   parking element per *face*, each carrying the **full** `reqs.parking_stalls`, all anchored
   to `firstBuildingId`. → all parking lands on A; the oversized rectangle fragments on clip.

2. **Scoring only sees one lot.** In `score.js`, both `parkingMet` and `parkingInFront` read
   `layout.parking_areas[0]` only. Any distributed layout would get credit for just one of its
   lots, so the optimizer **actively prefers** the clustered-on-A result. (This already silently
   under-scores today's `front+rear` option — only the front lot counts.)

There is also a secondary distortion: `bSetbackFt = setbackFt + parkDepthFt` computes
`parkDepthFt` from the **total** stall count over **A's** face width, shoving the whole row to
the rear to make room for parking depth only one building would ever hold.

The fix distributes parking per building, proportional to each building's GFA, anchored to each
child. The engine already supports this — `realizeParking` resolves any anchor via
`realized[anchorId]`, and group children are registered there, so **no `arrange.js` change is
needed.** Because the buildings sit adjacent in a strip, the per-building lots line up into one
continuous frontage lot — the natural row-of-stores look.

### Decisions baked in (confirmed — flip before starting if you disagree)

- **Split is proportional to building GFA** (sums exactly to `reqs.parking_stalls`; equal for
  equal buildings, correct for mixed sizes).
- **Driveway count stays tied to `reqs.driveways`.** One representative lane set per face,
  anchored to a representative lot — **not** one driveway per building (a strip has a shared
  entrance, not five curb cuts).
- **`bSetbackFt` derives from the max per-building front-parking depth**, not the summed total
  — buildings share the front face line, so the row is pushed back by the deepest lot only.

### Non-negotiables (do not violate)

- **Engine untouched.** `arrange.js` / `solver.js` / `regulatory.js` are not modified. This is a
  schema-generation change (`optimize.js`) plus a scoring-aggregation change (`score.js`).
- **`stall_count` stays the engine's locked source of truth.** Scoring sums the realized
  `stall_count` across lots; it never re-derives or recounts stalls.
- **Program is fixed input.** Total `reqs.parking_stalls` and building count are unchanged; we
  only decide how the stalls are *allocated and placed*, never invent or drop stalls from the
  program.
- **No new throws.** Degenerate inputs (tiny stall counts, zero-share buildings) must resolve to
  feasible/infeasible results, never exceptions.

---

## PHASE 1 — Aggregate parking across all lots (`score.js` only)

**Goal:** scoring counts every parking area, so a distributed layout scores correctly. Must land
**before** Phase 2 — otherwise distributed layouts score worse and never win the optimizer.

### 1a. `parkingMet` — sum stall_count across all areas

In `score.js score()`, replace:

```js
const reqStalls = reqs.parking_stalls ?? 0;
const gotStalls = layout.parking_areas[0]?.properties?.stall_count ?? 0;
add('parkingMet', reqStalls ? clamp01(gotStalls / reqStalls) : 1);
```

with:

```js
const reqStalls = reqs.parking_stalls ?? 0;
const gotStalls = layout.parking_areas.reduce(
  (s, p) => s + (p.properties?.stall_count ?? 0), 0);
add('parkingMet', reqStalls ? clamp01(gotStalls / reqStalls) : 1);
```

(Mirrors how `regulatory.js deriveContext` already sums stalls — bring scoring into line with it.)

### 1b. `parkingInFront` — stall-weighted mean across all lots

Replace:

```js
if (layout.parking_areas[0] && layout.buildings.length) {
  const pk = layout.parking_areas[0].properties;
  const dPark = depthFromFront({ x: pk.center_x_ft, y: pk.center_y_ft }, frontage, b);
  const dBldg = layout.buildings.reduce((s, bl) =>
    s + depthFromFront({ x: bl.center_x_ft, y: bl.center_y_ft }, frontage, b), 0)
    / layout.buildings.length;
  add('parkingInFront', clamp01(0.5 + (dBldg - dPark) / parcelDepth));
} else add('parkingInFront', 0.5);
```

with:

```js
if (layout.parking_areas.length && layout.buildings.length) {
  // Stall-weighted mean parking depth-from-front across all lots.
  // Falls back to an unweighted mean if every lot reports zero stalls.
  const totalStalls = layout.parking_areas.reduce(
    (s, p) => s + (p.properties?.stall_count ?? 0), 0);
  const dPark = totalStalls > 0
    ? layout.parking_areas.reduce((s, p) =>
        s + depthFromFront({ x: p.properties.center_x_ft, y: p.properties.center_y_ft }, frontage, b)
          * (p.properties.stall_count ?? 0), 0) / totalStalls
    : layout.parking_areas.reduce((s, p) =>
        s + depthFromFront({ x: p.properties.center_x_ft, y: p.properties.center_y_ft }, frontage, b), 0)
        / layout.parking_areas.length;
  const dBldg = layout.buildings.reduce((s, bl) =>
    s + depthFromFront({ x: bl.center_x_ft, y: bl.center_y_ft }, frontage, b), 0)
    / layout.buildings.length;
  add('parkingInFront', clamp01(0.5 + (dBldg - dPark) / parcelDepth));
} else add('parkingInFront', 0.5);
```

### STOP — test Phase 1

- **Single-building, single-lot layout:** `parkingMet` and `parkingInFront` raw values unchanged
  from before (one area → sum == [0]). No regression.
- **Existing `front+rear` multi-face layout:** `parkingMet` raw should now be **higher** than
  before, because both lots are counted instead of just the front one. Confirm via the score
  breakdown panel.
- No console errors; total score still computes.

Do not start Phase 2 until this is confirmed.

---

## PHASE 2 — Distribute parking per building (`optimize.js buildCandidateSchema`)

**Use Plan Mode.** Goal: each building gets its own lot per face, sized to its GFA share of the
stalls, anchored to that building. Driveways stay tied to `reqs.driveways`. `bSetbackFt` derives
from the max per-building depth.

### 2a. Add a module-scope helper near the top of `optimize.js`

```js
// Allocate `total` stalls across buildings proportional to GFA. Integer shares that
// sum EXACTLY to `total`; remainder goes to the largest fractional parts (largest
// buildings first on ties). Returns an array aligned to `buildings`.
function splitStallsByGFA(buildings, total) {
  if (total <= 0 || buildings.length === 0) return buildings.map(() => 0);
  const areas = buildings.map(b => b.length_ft * b.width_ft);
  const totalArea = areas.reduce((s, a) => s + a, 0) || 1;
  const raw = areas.map(a => total * a / totalArea);
  const shares = raw.map(Math.floor);
  let remainder = total - shares.reduce((s, v) => s + v, 0);
  const byFrac = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remainder > 0; k++, remainder--) shares[byFrac[k % byFrac.length].i]++;
  return shares;
}
```

### 2b. Replace the shared pre-compute block

In `buildCandidateSchema`, replace this block:

```js
// Pre-compute how deep front parking will be so the building can be pushed back
// exactly that far — mirrors buildTestSchema logic in main.js.
const firstB = reqs.buildings[0];
const firstArea = firstB.length_ft * firstB.width_ft;
const firstMaxDepth = Math.min(firstB.length_ft, firstB.width_ft);
const firstDepth = Math.min(firstMaxDepth, Math.sqrt(firstArea));
const firstFace = firstArea / firstDepth;
const stallsPerRow = Math.max(1, Math.floor(firstFace / 9));

const faces = parkingFaces.split('+');
const hasFrontParking = faces.includes('front') && reqs.parking_stalls > 0;
const parkRows = hasFrontParking ? Math.ceil(reqs.parking_stalls / stallsPerRow) : 0;
const parkDepthFt = parkRows * 30; // stallDepthFt(18) + aisleFt(24)/2 per row
const bSetbackFt = setbackFt + parkDepthFt;
```

with:

```js
// Constants mirror realizeParking in arrange.js (stallSpacingFt=9, row depth = 18 + 24/2).
// buildCandidateSchema has no profile param; these match the retail defaults. If the profile
// stall geometry ever changes, lift both into profile.stallWidthFt / a row-depth key and
// thread `profile` through this function's call sites (deferred — see follow-up note).
const STALL_WIDTH_FT = 9;
const ROW_DEPTH_FT = 30;

const faces = parkingFaces.split('+');
const hasFrontParking = faces.includes('front') && reqs.parking_stalls > 0;

// Per-building proportional stall shares (sum === reqs.parking_stalls).
const stallShares = splitStallsByGFA(reqs.buildings, reqs.parking_stalls);

// Each building's front-parking depth = ceil(share / its own stalls-per-row) * ROW_DEPTH_FT.
// Buildings share the front face line, so the row is pushed back by the MAX depth, not the sum.
let maxFrontDepthFt = 0;
if (hasFrontParking) {
  reqs.buildings.forEach((b, i) => {
    const area = b.length_ft * b.width_ft;
    const depth = Math.min(Math.min(b.length_ft, b.width_ft), Math.sqrt(area));
    const face = area / depth;
    const stallsPerRow = Math.max(1, Math.floor(face / STALL_WIDTH_FT));
    const rows = Math.ceil((stallShares[i] || 0) / stallsPerRow);
    maxFrontDepthFt = Math.max(maxFrontDepthFt, rows * ROW_DEPTH_FT);
  });
}
const bSetbackFt = setbackFt + maxFrontDepthFt;
```

### 2c. Capture building ids in both branches

The single- and multi-building branches already exist and assign `firstBuildingId`. Add an array
of **all** building ids alongside it, matching the ids each branch actually uses.

In the **single-building** branch, after `firstBuildingId = id;`:

```js
var buildingIds = [id]; // single building owns all the parking
```

In the **multi-building** branch, the children are created as `id: b.label || \`b${i}\``. After
the group element is pushed, add:

```js
var buildingIds = reqs.buildings.map((b, i) => b.label || `b${i}`);
```

(Keep `firstBuildingId` if anything else references it; the parking block below no longer needs it.)

### 2d. Replace the parking + driveway emission block

Replace the whole `if (reqs.parking_stalls > 0) { faces.forEach(...) }` block with:

```js
if (reqs.parking_stalls > 0) {
  faces.forEach((face, fi) => {
    // One lot per building on this face, sized to that building's GFA share.
    buildingIds.forEach((bId, bi) => {
      if ((stallShares[bi] || 0) <= 0) return; // skip buildings with no allocated stalls
      elements.push({
        id: `p${fi}_${bi}`,
        type: 'parking',
        size: { stalls: stallShares[bi] },
        place: { anchor: bId, face },
      });
    });

    // Driveways: count stays tied to reqs.driveways (left/right faces still use a single lane).
    // Anchor to a representative lot — the first building that actually has a lot on this face —
    // rather than spawning one driveway per building.
    const repBi = buildingIds.findIndex((_, bi) => (stallShares[bi] || 0) > 0);
    if (repBi >= 0) {
      const repParkId = `p${fi}_${repBi}`;
      const faceEntryUs = face === 'left' ? ['left']
                        : face === 'right' ? ['right']
                        : driveways;
      faceEntryUs.forEach((entryU, di) => {
        const dwSize = { widthFt: 24 };
        if (Number.isFinite(drivewayLengthFt)) dwSize.lengthFt = drivewayLengthFt;
        elements.push({
          id: `d${fi * 10 + di + 1}`,
          type: 'driveway',
          size: dwSize,
          place: { connects: 'parcelFrontage', to: repParkId, entryU },
        });
      });
    }
  });
}
```

### Notes on behavior (expected, not bugs)

- **Non-strip layouts** (`stacked` / `L` / `U`): front parking anchored to a rear-row building may
  overlap a front-row building and clip away (that lot drops, lowering `parkingMet`). These
  candidates simply rank lower — strip wins for frontage retail, which is correct. Do **not**
  special-case this.
- **Tiny stall counts** (fewer stalls than buildings): some buildings get a 0 share and are
  skipped; `repBi` still finds the first funded lot for the driveway. No crash.

### STOP — test Phase 2

- **5 × 500×500 strip, ~800 stalls:** five front lots, one per building, lining up into a
  continuous frontage band; buildings no longer shoved to the rear; `parkingMet` near full.
  This is the case from the bug report — verify visually on the canvas.
- **Single building:** identical result to before (one building, all stalls).
- **`front+rear`:** distributes lots on both faces, one per building per face.
- **Optimizer winner** for the multi-building case should now be a distributed strip, not the
  clustered-on-A layout.

---

## Follow-up (not in scope here)

- `STALL_WIDTH_FT`/`ROW_DEPTH_FT` are local constants matching `realizeParking`. Lifting them to
  `profile.stallWidthFt` (your previously-flagged addition) plus a row-depth key would require
  threading `profile` into `buildCandidateSchema` and its call sites — separate cleanup.
- Driveway realism (shared entrance + internal aisle vs. road→lot rectangle) remains the
  `driveway-spec.md` track; untouched here.

## After both phases

Update `SUMMARY.md`: note per-building proportional parking distribution in
`buildCandidateSchema`, and the `parkingMet`/`parkingInFront` aggregation fix in `score.js`.

---

## Handoff prompt for Claude Code

> Read `SUMMARY.md`, then `js/score.js` and `js/optimize.js`. Implement **Phase 1 only** from
> `parking-distribution-spec.md` (the two `score.js` edits). Do not touch `optimize.js` yet.
> Show me the diff and stop so I can test. We'll do Phase 2 in Plan Mode after I confirm.
