# Driveway Length Knob → Driveway Scoring — Implementation Spec

**For Claude Code. Read `SUMMARY.md` first to restore context.**

Build this in **three phases. Stop and let me test after each phase.** Use Plan Mode for phases that touch existing functions; Phase 1 is mostly additive but still touches `realizeDriveway`, so plan it too.

---

## 0. Why this task

Two related defects, fixed together because they double-count if fixed apart:

1. **"Driveway always too short" is structural.** In `arrange.js realizeDriveway`, the lane's inner end is welded to the parking's *near* edge (`vTarget = max(targetBounds.vMin, vFront+1)`). It spans only the setback strip and never runs alongside the parking field. Fix: make driveway length a **knob**, not a weld.
2. **`accessQuality` (−0.25) is a crude proxy.** It penalizes driveway *area* / parcel area, which is just length × width with no notion of whether the lane actually *functions* (reaches the road, serves the parking). Replace it with two purpose-built terms and **retire `accessQuality`** so we don't penalize the same feet twice.

The prerequisite for term #1 below — a stored road object — now exists (`detectedRoad` in `main.js`, populated by `road.js`). This task is unblocked.

### Non-negotiables (do not violate)
- **Knob-not-weld.** Every new constant is an exposed profile parameter with a default. No magic numbers in `arrange.js` / `optimize.js` / `score.js`.
- **Frontage is never a search dimension.** Untouched here.
- **Program is fixed input.** Driveway *count* comes from `reqs.driveways`; we tune *length*, never invent lanes.
- **`realizeArrangement` never throws.** New code returns `{feasible:false, reason}` on failure, same as the rest of the file.
- **Turf is a CDN global on the main thread** (`turf.*`); only `optimizer-worker.js` uses the ESM import. Don't add ESM turf imports to `arrange.js`/`score.js`.

---

## 1. Two design decisions baked in (flip before starting if you disagree)

**Decision A — `drivewayLength` is refined in Phase 2, not enumerated in Phase 1.**
The Phase 1 grid is currently 288 candidates (`maxCandidates: 500`). Adding even 2 discrete length values makes it 576 and trips the cap, silently truncating the search. So driveway length is handled like `setbackFt`/`alignU` already are: a **continuous knob refined around the top-K winners in Phase 2**. Phase 1 stays at 288. *(Alternative if you prefer: a discrete `drivewayLengthFt: [...]` set in `searchConfig` enumerated in Phase 1 — simpler wiring, but raise `maxCandidates` and accept the larger grid.)*

**Decision B — `drivewayConnected` is neutral (raw = 1, no penalty) when no road object is present.**
Every driveway is built *from the parcel frontage edge by construction*, so measuring "does it reach the parcel frontage" can't differentiate candidates — they all pass. The connection signal only carries information when there's a **real detected road** (`detectedRoad.line`) that may sit offset/at a distance from the assumed frontage. So: measure against `road.line` when present; when `road` is `null` (manual frontage, Overpass miss, detection off), the term contributes its neutral max. This is correct scoping, not a cop-out — it avoids plumbing `parcelLatLng` into the scorer for a measurement that would be a no-op anyway.

Both decisions keep the change small and honest. Both are reversible.

---

## PHASE 1 — Unweld driveway length (`arrange.js` only)

**Goal:** driveway length becomes a parameter; the default makes the lane span the full parking depth (fixing "too short") without any caller change. Additive to the schema; no search or scoring change yet.

### 1a. Add a placement default to the profile
`score.js`, `PROFILES.retail`, in the **placement defaults** block (next to `drivewayWidthFt: 24`):

```js
defaultDriveLengthFt: null,   // null → derive functional length (span to served element's far edge)
```

`null` signals "derive it." Keeping it a profile key honors knob-not-weld even though the default is derived.

### 1b. Rewrite the v-range in `realizeDriveway`
File `arrange.js`, function `realizeDriveway` (currently ~line 249). Today:

```js
const vFront  = frontageV(parcelFt, frame);
const vTarget = Math.max(targetBounds.vMin, vFront + 1);
```

Replace with length-driven logic:

```js
const vFront = frontageV(parcelFt, frame);

// Functional default: span from the road edge to the served element's FAR edge
// (vMax = building face for front parking), so the lane runs the full parking depth.
// Falls back to the near edge if no target bounds (parcelFrontage-only case).
const functionalLenFt = Number.isFinite(targetBounds.vMax)
  ? (targetBounds.vMax - vFront)
  : (targetBounds.vMin - vFront);

// lengthFt knob: schema size.lengthFt > profile.defaultDriveLengthFt > functional default.
const reqLenFt = (Number.isFinite(size.lengthFt) ? size.lengthFt
              : Number.isFinite(profile.defaultDriveLengthFt) ? profile.defaultDriveLengthFt
              : functionalLenFt);

// Clamp: at least reach 1 ft into the parcel; never run past the parcel's deep edge.
const parcelVMax = Math.max(...parcelFt.map(p => feetToLocal(p, frame).v));
const vTarget = Math.min(parcelVMax, Math.max(vFront + 1, vFront + reqLenFt));
```

The `[vFront - 50, vTarget]` rectangle and the clip-to-parcel that follow stay as-is.

### 1c. Attach properties to the realized feature (for Phase 3 scoring)
Mirrors how parking attaches `.properties`. Replace the success return:

```js
return { id: el.id, type: 'driveway', feasible: true, feature: clipped };
```

with one that records the realized geometry on the feature **and** the element:

```js
const realizedLenFt = vTarget - vFront;
clipped.properties = {
  ...(clipped.properties ?? {}),
  lengthFt: realizedLenFt,
  widthFt:  halfWidth * 2,
  entryU,
};
return {
  id: el.id, type: 'driveway', feasible: true,
  feature: clipped,
  lengthFt: realizedLenFt,
};
```

The `layoutFromArrangement` / `layoutFromElements` adapters map driveways to `e.feature` unchanged, so `feature.properties.lengthFt` flows into `layout.driveways[i]` for free. No adapter edit needed.

### Phase 1 test gate (I will run these)
- Solve a parcel with front parking + 1 driveway. The lane should now visibly run the **full depth of the parking field** to the building face, not stop at the parking's road-side edge.
- No regression with no parking (parcelFrontage-only driveway still draws).
- `console.log(layout.driveways[0].properties)` shows `{lengthFt, widthFt, entryU}`.
- Multi-building + 2 driveways (`left`/`right`) still feasible and render correctly.

**Stop here. Do not start Phase 2 until I confirm.**

---

## PHASE 2 — Expose driveway length to the optimizer (`optimize.js` + `score.js searchConfig`)

**Goal:** the search explores driveway length, refined around Phase 1 winners (per Decision A). No scoring change yet.

### 2a. `searchConfig.refineConfig` — add length offsets
`score.js`, `PROFILES.retail.searchConfig.refineConfig` (next to `alignOffsetsFt`):

```js
driveLengthOffsetsFt: [-40, -20, 0, 20, 40],  // ft offsets from the functional default
```

Empty array `[]` disables length refinement cleanly.

### 2b. `buildCandidateSchema` — accept and apply the length knob
`optimize.js`, `buildCandidateSchema` (line ~75). Add `drivewayLengthFt` to the destructure:

```js
const { layout, gapFt, parkingFaces, driveways, basinCorner, setbackFt, alignU,
        drivewayLengthFt } = knobs;
```

In the driveway-push block (line ~130), set `size.lengthFt` when the knob is a finite number:

```js
driveways.forEach((entryU, di) => {
  const size = { widthFt: 24 };
  if (Number.isFinite(drivewayLengthFt)) size.lengthFt = drivewayLengthFt;
  elements.push({
    id:    `d${fi * 10 + di + 1}`,
    type:  'driveway',
    size,
    place: { connects: 'parcelFrontage', to: parkId, entryU },
  });
});
```

When `drivewayLengthFt` is absent (all Phase 1 candidates), `size.lengthFt` is unset and Phase 1's functional default from §1b applies. Phase 1 behavior is unchanged.

### 2c. `knobSig` — include length so dedup stays correct
`optimize.js`, `knobSig` (line ~279). Two candidates that differ only in driveway length must hash differently, or Phase 2 dedup will silently drop them:

```js
export function knobSig(k) {
  const dw = Array.isArray(k.driveways) ? [...k.driveways].sort().join(',') : String(k.driveways);
  const dl = Number.isFinite(k.drivewayLengthFt) ? k.drivewayLengthFt : 'def';
  return `${k.layout}|${k.gapFt}|${k.parkingFaces}|${dw}|${k.basinCorner}|${k.setbackFt}|${k.alignU}|${dl}`;
}
```

### 2d. `refineArrangement` — add length to the refinement loop
`optimize.js`, `refineArrangement` (line ~221). Currently nests `for (setbackFt) { for (alignU) { ... } }`. Add a length loop using the winner's functional length as the base.

You don't have the realized functional length as a number in the knob-set, so derive a base from the winner and offset it. Simplest robust approach: compute base length once per winner from the winner's already-realized layout if available, else use a profile fallback. Concretely, add inside the `for (const winner of topKWinners)` body, after `alignUs` is built:

```js
const offs = refineConfig.driveLengthOffsetsFt ?? [0];
// Base = realized length of the winner's first driveway (from Phase 1 layout), if any.
const baseDriveLen = winner.layout?.driveways?.[0]?.properties?.lengthFt;
const driveLengths = Number.isFinite(baseDriveLen)
  ? [...new Set(offs.map(o => Math.max(10, Math.round(baseDriveLen + o))))]
  : [undefined];   // no driveways / no base → single pass with default length
```

Then wrap the existing `setbackFt × alignU` body in the length loop and thread it into the knob-set:

```js
for (const drivewayLengthFt of driveLengths) {
  for (const setbackFt of uniqueSetbacks) {
    for (const alignU of alignUs) {
      tried++;
      const schema = buildCandidateSchema(
        reqs, frontage,
        Number.isFinite(drivewayLengthFt)
          ? { ...k, setbackFt, alignU, drivewayLengthFt }
          : { ...k, setbackFt, alignU }
      );
      // ...unchanged: realize, feasibility gate, score, push...
    }
  }
}
```

**Combinatorial check:** Phase 2 per-winner count goes from ~9×5 = 45 to ~9×5×5 = 225, × topK(4) ≈ 900 Phase 2 candidates. These are free local-CPU geometry, not API calls, but confirm the worker still finishes in a few seconds on a typical parcel. If too slow, trim `driveLengthOffsetsFt` to 3 values in the profile (it's a knob — no code change).

### Phase 2 test gate
- Run Optimize. Status/console shows Phase 2 trying more candidates than before.
- Step through the ranked rows: at least some winners differ in realized driveway length (inspect `c.layout.driveways[0].properties.lengthFt`).
- Dedup intact: no console errors; `totalTried` is sane (not exploding past a few thousand).
- Single-building and 5-building cases both still produce feasible winners.

**Stop here. Do not start Phase 3 until I confirm.**

---

## PHASE 3 — Driveway scoring + retire `accessQuality` + thread the road object

**Goal:** replace `accessQuality` with `drivewayConnected` + `drivewayLength`, and thread the detected road through every scoring path. This phase has the most plumbing — the road has to cross the worker boundary. Do it carefully; use Plan Mode.

### 3a. Add a `road` parameter to `score()` — **threaded through 6 call sites + the worker**
`score.js`, signature becomes:

```js
export function score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile, road = null) {
```

`road = null` keeps every existing caller valid until updated. The road object is `detectedRoad` from `road.js`: `{ cardinal, line (Turf LineString WGS84), nearestPt, distanceFt, ... }` or `null`. It is GeoJSON → **structured-cloneable**, so it crosses `postMessage` to the worker without special handling.

**Thread `road` into every `score(...)` call. Exhaustive list (re-grep `score(` to be sure — line numbers shift as you edit):**

| File | Location | What to do |
|---|---|---|
| `optimize.js` | `optimizeArrangement(...)` signature (~line 340) | add trailing `road = null` param |
| `optimize.js` | `scoreAiSeeds(...)` signature (~line 287) | add trailing `road = null` param |
| `optimize.js` | `refineArrangement(...)` signature (~line 221) | add trailing `road` param; pass it from `optimizeArrangement` |
| `optimize.js` | all `score(...)` calls (currently lines ~22, 260, 315, 393, 427) | pass `road` as the 7th arg |
| `optimizer-worker.js` | `self.onmessage` destructure | add `road` to `{ parcelLatLng, reqs, frontage, profile, aiSeeds, road }` and pass to `optimizeArrangement(...)` |
| `main.js` | worker `postMessage` (~line 614) | add `road: detectedRoad` to the message object |
| `main.js` | `scoreAiSeeds(...)` call (~line 576) | pass `detectedRoad` as trailing arg |
| `main.js` | `renderLayout`'s `score(...)` call (~line 467) | pass `detectedRoad` (module-scope, line 40 — in scope here) as trailing arg |

After editing, **grep `score(` across all `.js` once more** and confirm none were missed.

### 3b. Implement the two new terms in `score()`
Add weights to `PROFILES.retail` (scoring-weights block) and **remove `accessQuality`**:

```js
// remove:  accessQuality: -0.25,
drivewayConnected: 0.4,   // near-binary gate: lanes reach the detected road
drivewayLength:    0.3,   // functional length, penalizes gross overshoot
```

In `score()`, **delete the `accessQuality` block** (the `dwSqFt` lines ~109–110) and add:

```js
// --- drivewayConnected (Decision B: neutral when no road object) ---
const dwCount = layout.driveways.length;
if (!road?.line || dwCount === 0) {
  add('drivewayConnected', 1);   // nothing to measure against, or no lanes requested
} else {
  const connectThreshFt = profile.drivewayConnectThreshFt ?? 30;
  const roadBuf = turf.buffer(road.line, connectThreshFt, { units: 'feet' });
  let connected = 0;
  for (const d of layout.driveways) {
    if (roadBuf && turf.booleanIntersects(d, roadBuf)) connected++;
  }
  add('drivewayConnected', clamp01(connected / dwCount));  // near-binary in practice
}

// --- drivewayLength (functional reach vs. waste) ---
// "Full" length = road → building front face. Reward lanes that reach most of the
// way; penalize gross overshoot past the face. Uses only layout data.
if (dwCount === 0 || layout.buildings.length === 0) {
  add('drivewayLength', 1);
} else {
  const meanBldgDepth = layout.buildings.reduce((s, bl) =>
      s + depthFromFront({ x: bl.center_x_ft, y: bl.center_y_ft }, frontage, b), 0)
    / layout.buildings.length;
  // building front face depth from road ≈ center depth − half the building's road-facing dim
  const faceDepthFt = Math.max(40, meanBldgDepth);  // floor avoids div-by-small
  const lo = profile.drivewayLengthLo ?? 0.6;       // reaches 60% of the way → functional
  const hi = profile.drivewayLengthHi ?? 1.0;       // reaches the face
  const falloff = profile.drivewayLengthFalloff ?? 0.5;
  const raws = layout.driveways.map(d => {
    const L = d.properties?.lengthFt ?? 0;
    return plateau(L / faceDepthFt, lo, hi, falloff);
  });
  add('drivewayLength', raws.reduce((s, r) => s + r, 0) / raws.length);
}
```

Add the corresponding knobs to the profile placement-defaults block:

```js
drivewayConnectThreshFt: 30,
drivewayLengthLo:        0.6,
drivewayLengthHi:        1.0,
drivewayLengthFalloff:   0.5,
```

> **Honesty flag for the user:** `drivewayLength`'s constants (`lo/hi/falloff`, the `faceDepth` proxy) are intuition-set — there's no approved-plan dataset to calibrate against (project decision §8). `drivewayConnected` is a clean near-binary gate and is the trustworthy one. Expect to tune `drivewayLength` after eyeballing real outputs in the test gate. All four constants are profile knobs precisely so tuning needs no code change.

### 3c. maxScore interaction
`maxScore` already sums only positive scored-term weights (the on-disk fix:
`Object.values(terms).reduce((s,t)=> t.weight>0 ? s+t.weight : s, 0)`). Retiring `accessQuality` (a negative weight, never in maxScore) and adding two positives changes the denominator automatically — no maxScore code change. New retail max = old 4.15 + 0.4 + 0.3 = **4.85**. The score panel updates itself. If the on-disk maxScore fix isn't committed yet, **commit it as part of this phase** (see §4).

### Phase 3 test gate
- Draw a parcel **near a detected road** (magenta line appears). Optimize. The breakdown panel shows `drivewayConnected` and `drivewayLength`; **no `accessQuality` row**.
- A candidate whose lanes reach the road scores `drivewayConnected` ≈ 1; force a short lane (small `driveLengthOffsetsFt` or a manual schema) and confirm it drops.
- Draw a parcel **with no nearby road** (manual frontage, no magenta line). `drivewayConnected` raw = 1 (neutral) — confirm it doesn't zero out every candidate.
- Worker path and AI-seed path both produce scores (no "road is undefined" errors in console) — verifies the threading reached the worker and `scoreAiSeeds`.
- Score total denominator reads `/ 4.85`.

---

## 4. Commit hygiene
- Commit the **on-disk `maxScore` fix** if not already committed (`score.js`), separately or as part of Phase 3.
- One commit per phase, e.g.:
  - `Phase 1: driveway length knob — unweld vTarget, attach realized length`
  - `Phase 2: refine driveway length in optimizer Phase 2 + knobSig`
  - `Phase 3: drivewayConnected + drivewayLength terms, retire accessQuality, thread road`

## 5. Honest limits (acknowledged, not bugs)
- `drivewayConnected` only discriminates when a road was detected/stored; without one it's neutral by design (Decision B).
- `drivewayLength` uses a building-face-depth proxy, not a per-driveway served-parking measurement — good enough for ranking, tunable, not ground truth.
- Phase 2's length base reads the winner's realized first-driveway length; candidates with zero driveways skip length refinement (correct — nothing to refine).
- None of this validates against approved plans (project constraint). "Best" still means "best per the current scorer" — now with one more objective gate (connection) under it.
