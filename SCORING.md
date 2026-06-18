# Site Planner — Task: Scoring Function (`score.js`)

## Goal & scope (read first)

Add a pure function that rates a finished layout with a single number, so the tool can later
*choose* between layouts. **This task is DISPLAY-ONLY — do NOT build an optimizer yet.**
Compute the score after each solve and show it (with a per-term breakdown) in the stats panel.
The breakdown is the whole point right now: it lets the user tune the weights against real
plans before any search loop trusts the number.

Rules:
- `score()` is **pure and deterministic** — no AI, no randomness, no state. Same layout in,
  same number out. It only *judges* a layout `solveLayout` already produced; it never creates geometry.
- Weights live in **profiles** keyed by use case. Start with `retail`. The AI's only future
  job here is picking the profile from intent ("shopping center" → `retail`) — not scoring.
- Every term is normalized to 0–1, then multiplied by its weight (penalties use negative
  weights). Normalizing first keeps weights comparable across square-feet vs. ratio units.

---

## New file: `js/score.js`

### Profile (retail, derived from industry guidance — tune against the firm's real plans)

```js
export const PROFILES = {
  retail: {
    buildingsPlaced: 1.0,   // dealbreaker: requested buildings actually placed
    parkingMet:      0.9,   // ~5 stalls / 1,000 sf; near-dealbreaker
    parkingInFront:  0.7,   // 4 of 5 spaces between road and storefront
    roadVisibility:  0.6,   // storefront within a sensible setback band of the road
    coverageTarget:  0.5,   // reward ~20–25% building coverage; penalize over/under
    accessQuality:  -0.25,  // PENALTY: convoluted/large driveway footprint
    basinAccuracy:   0.3,   // basin near its target size
    compactness:     0.15,  // minor tie-break
    openSpace:       0.0,   // irrelevant for retail
  },
  // multifamily / industrial / office: author later (same terms, different weights;
  // e.g. multifamily flips parkingInFront negative and raises openSpace)
};
```

### Signature & return shape

```js
// frontage = the resolved 'N'|'S'|'E'|'W' (pass the same value the solver used)
// parcelFt = [{x,y}] feet polygon (already in main.js state)
export function score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile) {
  const W = profile;
  const terms = {};                       // { name: {raw, weight, contribution} }
  const add = (name, raw) => {
    const w = W[name] ?? 0;
    terms[name] = { raw, weight: w, contribution: w * raw };
  };
  // ... compute each raw term (0–1) below, calling add(...) ...
  const total = Object.values(terms).reduce((s, t) => s + t.contribution, 0);
  return { total, terms };
}
```

Return the breakdown, not just the total — the UI shows it and tuning depends on it.

### Helpers

```js
const clamp01 = v => Math.max(0, Math.min(1, v));

// distance (ft) from a feet-point INTO the site from the frontage edge (0 = at the road)
function depthFromFront(pt, frontage, b) { // b = {minX,maxX,minY,maxY} of parcelFt
  switch (frontage) {
    case 'S': return pt.y - b.minY;
    case 'N': return b.maxY - pt.y;
    case 'W': return pt.x - b.minX;
    case 'E': return b.maxX - pt.x;
  }
}
function bounds(parcelFt) {
  const xs = parcelFt.map(p => p.x), ys = parcelFt.map(p => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs),
           minY: Math.min(...ys), maxY: Math.max(...ys) };
}
// plateau: 1 inside [lo,hi]; ramps up to lo; decays above hi over `falloff`
function plateau(v, lo, hi, falloff) {
  if (v >= lo && v <= hi) return 1;
  if (v < lo) return clamp01(v / lo);
  return clamp01(1 - (v - hi) / falloff);
}
```

### The terms (each produces a 0–1 raw value)

```js
const b = bounds(parcelFt);
const parcelDepth = (frontage === 'E' || frontage === 'W')
  ? (b.maxX - b.minX) : (b.maxY - b.minY);

// 1. buildingsPlaced — fraction of requested buildings that got placed
add('buildingsPlaced',
  reqs.buildings.length ? layout.buildings.length / reqs.buildings.length : 1);

// 2. parkingMet — achieved stalls / required (capped at 1 so over-parking doesn't over-reward)
const reqStalls = reqs.parking_stalls ?? 0;
const gotStalls = layout.parking_areas[0]?.properties?.stall_count ?? 0;
add('parkingMet', reqStalls ? clamp01(gotStalls / reqStalls) : 1);

// 3. parkingInFront — parking should sit between the road and the buildings
//    Compare depth-from-road of parking vs. mean building depth. Shallower parking = in front.
if (layout.parking_areas[0] && layout.buildings.length) {
  const pk = layout.parking_areas[0].properties;
  const dPark = depthFromFront({ x: pk.center_x_ft, y: pk.center_y_ft }, frontage, b);
  const dBldg = layout.buildings.reduce((s, bl) =>
      s + depthFromFront({ x: bl.center_x_ft, y: bl.center_y_ft }, frontage, b), 0)
    / layout.buildings.length;
  add('parkingInFront', clamp01(0.5 + (dBldg - dPark) / parcelDepth));
} else add('parkingInFront', 0.5); // neutral if no parking or no buildings

// 4. roadVisibility — buildings within a sensible setback band (room for 2–4 parking rows,
//    ~60–200 ft) read as visible storefronts; buried-deep buildings score low.
if (layout.buildings.length) {
  const meanSetback = layout.buildings.reduce((s, bl) =>
      s + depthFromFront({ x: bl.center_x_ft, y: bl.center_y_ft }, frontage, b), 0)
    / layout.buildings.length;
  add('roadVisibility', plateau(meanSetback, 60, 200, 250));
} else add('roadVisibility', 0);

// 5. coverageTarget — building footprint as a fraction of the parcel; ideal ~20–25%
const footprintSqFt = layout.buildings.reduce((s, bl) => s + bl.length_ft * bl.width_ft, 0);
add('coverageTarget', plateau(footprintSqFt / parcelAreaSqFt, 0.20, 0.25, 0.20));

// 6. accessQuality — PENALTY: driveway footprint as a fraction of site (5% → full penalty)
const dwSqFt = layout.driveways.reduce((s, d) => s + turf.area(d) * 10.7639, 0);
add('accessQuality', clamp01((dwSqFt / parcelAreaSqFt) / 0.05));

// 7. basinAccuracy — basin area vs. target; 0 if a basin was requested but absent
const target = (reqs.pondSqFt ?? (reqs.pondPct / 100) * parcelAreaSqFt) || 0;
if (target > 0) {
  const basinSqFt = layout.detention_pond ? turf.area(layout.detention_pond) * 10.7639 : 0;
  add('basinAccuracy', clamp01(1 - Math.abs(basinSqFt - target) / target));
} else add('basinAccuracy', 1);

// 8. compactness — tighter building cluster scores higher (minor)
if (layout.buildings.length > 1) {
  const cx = layout.buildings.map(bl => bl.center_x_ft);
  const cy = layout.buildings.map(bl => bl.center_y_ft);
  const spread = Math.hypot(Math.max(...cx) - Math.min(...cx),
                            Math.max(...cy) - Math.min(...cy));
  const parcelDiag = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
  add('compactness', clamp01(1 - spread / parcelDiag));
} else add('compactness', 1);

// 9. openSpace — weight is 0 for retail; include so the term exists for other profiles
add('openSpace', 0);
```

---

## Wiring into `main.js` (display only)

In `onSolve`, after `solveLayout`, compute and show the score. You already have `parcelFt`,
`centroid`, and the frontage value from `#input-frontage` (resolve 'auto'→'S' the same way
the solver does, or have the solver also return the resolved frontage in its output).

```js
import { score, PROFILES } from './score.js';
// ...
const frontage = ['N','S','E','W'].includes(hints.frontage) ? hints.frontage : 'S';
const parcelAreaSqFt = polygonAreaSqFt(parcelFt);
const result = score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, PROFILES.retail);
```

Show `result.total` as a new stat row, and render `result.terms` as a small breakdown
(name — raw value — weighted contribution) so the user can see *why* a layout scored what it
did. A simple list under the stats panel is enough.

---

## Tests
- Score is identical on repeated solves of the same inputs (pure function).
- A layout that places all buildings, meets parking, and keeps parking toward the road scores
  clearly higher than one that drops a building or buries buildings at the back.
- The breakdown sums to `total`.
- Run it on 2–3 of the firm's real retail plans (enter their actual program): the known-good
  plans should score **high**. If one scores low, a weight or a term proxy is wrong — adjust
  before trusting the number.

---

## Notes / honest caveats
- `parkingInFront` and `roadVisibility` are **geometric proxies**, not true sightline analysis.
  They're good enough to rank layouts but expect to tune the 60–200 ft band and the
  parcelDepth normalization against real plans.
- `coverageTarget`'s 20–25% band and `parkingMet`'s implied ~5 stalls/1,000 sf are industry
  typical; confirm against the firm's actual numbers (restaurant-heavy centers park nearer
  20/1,000, which raises the required stall count, not this formula).
- **Optimizer comes next, not now.** Once the weights feel right, the future search loop is:
  for each candidate parameter-set → `solveLayout` → `score` → keep the highest. `score()` is
  built to plug straight into that with no changes.
