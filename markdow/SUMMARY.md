# AI Site Planner — Project Summary

## What this app does
A browser-based civil site-planning tool. The user draws a parcel boundary on a
satellite map, fills in a program (buildings, basin %, parking, driveways), and a
**deterministic geometry solver** places everything so it is guaranteed to fit inside
the boundary with no overlaps. Output renders to scale on a canvas backed by a
satellite imagery background and exports as PNG.

---

## Current status

All Phases 0–7 + post-review fixes + Frontage task + Scoring + Optimizer + Arrange Phases A–E + Schema Optimizer Phases 1–3 + AI Schema-Proposer Phases 1–2 + Road Detection Phases 1–2 + Driveway Length Knob + Driveway Scoring (Phases 1–3) COMPLETE.

### Phase history
| Phase | What was built | Commit |
|-------|---------------|--------|
| 0 | Scaffold + Google Maps + polygon sketching | ad08ec6 |
| 1 | Projection (lat/lng → feet) + acreage display | aacacdd |
| 2 | Geometry helpers + setback overlay (blue inset) | ffb24f6 |
| 3 | Detention basin solver (binary-search corner clip) | 61d1975 |
| 4 | Parking + driveways (south-only, original) | 16cced4 |
| 5 | Building placement via erosion (guaranteed fit, deterministic) | 7d3398e |
| 6 | Canvas scale drawing + scale bar + PNG export | 03b8769 |
| 7 | AI hints layer via Gemini (parseInstructions → hints → re-solve) | 69cdd48 |

### Post-review fixes (all done)
| Fix | What changed | Commit |
|-----|-------------|--------|
| P1 | Satellite background on canvas/PNG via Web Mercator projection | 9028b90 |
| P2 | Building clearance: `clearance/2` → `clearance` (was getting ~15 ft gap, now ~30 ft) | 442ddce |
| P3 | gridPointsInside samples all poly pieces; zoneCentroid spreads along long axis; basin undersized warning; determinism tie-break; removed duplicate computeScaleFactors | 11658a4 |

### Frontage task (all done)
| Step | What | Commit |
|------|------|--------|
| 1 | Generalize parking placement: `placeAlongFrontageEdge(free, sqFt, centroid, frontage)` | 165e183 |
| 2 | Generalize driveways for all 4 directions | 165e183 |
| 3 | Basin default corner derived from frontage (S→NE, N→SW, W→SE, E→NW) | 165e183 |
| 4 | UI dropdown for Road Frontage in index.html + main.js read | 189c475 |
| 5a | ai.js: add `frontage` field to Gemini prompt + VALID_FRONTAGE allowlist | 165e183 |
| 5b | main.js: wire `aiHints.frontage` into `onSolve` hints | 96d9b13 |
| 5c | main.js `onApplyAI`: reflect parsed frontage back into `#input-frontage` element | 189c475 |
| — | Fix: E/W driveway bbox-anchor bug on slanted parcels | 781f786 |
 | — | Fix: E/W parking multi-lat edge sampling (`sampleEdgeLng`) | 35eafbe |
| — | Fix: S/N parking stall loss on slanted/tilted parcels (`sampleEdgeLat` + scan) | 189c475 |

### Scoring, Optimizer, Relational Placement (all done)
| What | File | Commit | Status |
|------|------|--------|--------|
| Pure layout scorer, 9 weighted terms | js/score.js | 85b1a5e | ✅ |
| Score breakdown panel in sidebar | index.html + styles.css + main.js | 85b1a5e | ✅ |
| Brute-force optimizer over 4 basin corners | js/optimize.js | 85b1a5e | ✅ |
| "Optimize Layout" button + "Why This Won" ranked panel | index.html + styles.css + main.js | 85b1a5e | ✅ |
| Export `placeBuilding` from solver.js | js/solver.js | 85b1a5e | ✅ |
| arrange.js Phase A: local frame + schema parser + topo-sort + building→parcelFrontage | js/arrange.js | 85b1a5e | ✅ |
| arrange.js Phase B: parking → building face, stall-count sizing, clip-to-free | js/arrange.js | fd55d90 | ✅ |
| arrange.js Phase C: driveway connects parcelFrontage → parking, entryU | js/arrange.js | fd55d90 | ✅ |
| USE_ARRANGER = true (arranger is live for Solve button) | js/main.js | fd55d90 | ✅ |
| arrange.js Phase D: group/strip, childToGroup topo-sort, scanGroupPlacement, parking clearance fix, driveway vTarget fix, bSetbackFt | js/arrange.js + js/main.js | c4bafb8 | ✅ |
| arrange.js Phase E: basin → parcelCorner, semantic corner names, cardinal passthrough, pondPct=0 bug fix | js/arrange.js + js/main.js | b084610 | ✅ |
| Schema optimizer Phase 1: optimizeArrangement, generateCandidates, buildCandidateSchema, layoutFromElements | js/optimize.js + js/score.js + js/main.js | b520168 | ✅ |
| Fix optimizer crash on Turf geometry errors (per-candidate try/catch + turf monkey-patch) | js/optimize.js | 6767a1f | ✅ |
| Schema optimizer Phase 2: local refinement — fine setbackFt grid + numeric alignU offsets around top-K Phase 1 winners; export buildLocalFrame; alignU numeric support in realizeBuilding + realizeGroup | js/optimize.js + js/arrange.js + js/score.js + js/main.js | — | ✅ |
| Schema optimizer Phase 3: Web Worker off main thread, streaming best-so-far on progress, step-through ranked list (displayK=10 clickable rows), cancel button | js/optimizer-worker.js (new) + js/optimize.js + js/main.js + js/score.js + index.html + styles.css | — | ✅ |
| AI Schema-Proposer Phase 1: proposeArrangements (Gemini knob-set proposals, main-thread, 4 s timeout, AbortController), aiSeeds merge into ranked list tagged source:'ai', knobSig dedup vs grid, opt-ai-tag badge in UI | js/ai.js + js/optimize.js + js/optimizer-worker.js + js/main.js + styles.css | — | ✅ |
| Fix maxScore computation in score.js: sum scoring term weights only (not all profile values) — was 600.15, now correctly 4.15 for retail | js/score.js | — | ✅ (on disk, not yet committed) |
| AI Schema-Proposer Phase 2: 3 bias templates (visibility/parking/compact) fired concurrently via Promise.allSettled; Gemini runs parallel to worker (not sequential) to hide latency; richer parcel description (aspect ratio + shape note); AI seeds scored on main thread via scoreAiSeeds export; knobSig exported; debug console.log removed; status shows "· N AI" count | js/ai.js + js/optimize.js + js/main.js | — | ✅ |
| Driveway Length Knob Phase 1: unweld vTarget in realizeDriveway — functional default spans road→parking far edge (building face); knob priority chain size.lengthFt > profile.defaultDriveLengthFt > functional; attach {lengthFt, widthFt, entryU} to feature.properties and element; add defaultDriveLengthFt:null to PROFILES.retail; JSTS monkey-patch added to realizeArrangement (same as optimizeArrangement) to fix multi-building Solve path | js/arrange.js + js/score.js | — | ✅ |
| Driveway Length Knob Phase 2: drivewayLengthFt wired into schema optimizer — buildCandidateSchema applies size.lengthFt when knob is finite; knobSig gains \|dl segment; refineArrangement adds outer driveLengths loop (offsets from winner's realized length, falls back to [undefined] when no driveways); driveLengthOffsetsFt:[-40,-20,0,20,40] added to searchConfig.refineConfig; Phase 2 candidates ≈900 vs 180 before | js/optimize.js + js/score.js | — | ✅ |
| Fix: 2-driveway candidates never surfaced — generateCandidates tried all 4 drivewaySet combos regardless of reqs.driveways; now filters to sets matching the requested count | js/optimize.js | — | ✅ |
| Driveway Scoring Phase 3 (driveway-spec): replace accessQuality (−0.25 area-ratio penalty) with drivewayConnected (0.4, near-binary gate — do lanes reach detected road?) + drivewayLength (0.3, plateau scoring on realized lane depth vs building face depth); road = null threaded through score() signature, all 5 score() calls in optimize.js, 3 function signatures (optimizeLayout/refineArrangement/scoreAiSeeds/optimizeArrangement), 3 main.js call sites, and optimizer-worker.js postMessage destructure; 4 profile knobs added (drivewayConnectThreshFt/Lo/Hi/Falloff); retail maxScore 4.55 → 5.25 | js/score.js + js/optimize.js + js/main.js + js/optimizer-worker.js | — | ✅ |

---

## File structure (current state)

```
index.html          UI shell — sidebar controls + stats/score/optimizer panels
styles.css          Dark sidebar + map + canvas panel layout + score/optimizer CSS
config.js           API keys — GITIGNORED, never commit
config.example.js   Safe shape reference
SCORING.md          Spec for score.js (implemented)
OPTIMIZER_TASK.md   Spec for optimize.js (implemented)
schema-optimizer-spec.md  Spec for optimizeArrangement Phase 1–3 (Phase 1 done)
relational-placement-spec.md  Spec for arrange.js (Phases A–E all done)
js/
  main.js           App state + wires UI events → solver → renderer → scorer
  map.js            Google Maps init, click-to-draw polygon sketching
  projection.js     computeCentroid, computeScaleFactors, latLngToFeetFromCentroid,
                    feetToLatLngFromCentroid, latLngToFeet, polygonAreaSqFt
  geometry.js       toPoly, rectPoly, polysOf, biggestPoly, reach, gridPointsInside
  solver.js         solveLayout() — deterministic geometry engine
                    Export: placeBuilding(free, bSpec, targetPt, orientations, centroid)
  render.js         async renderLayoutOnCanvas(canvas, parcelLatLng, layout, centroid)
  export.js         exportToPng()
  ai.js             parseInstructions(text) → hints via Gemini 2.5 Flash
                    proposeArrangements(parcelSummary, reqs, frontage, profile) → knob-set[] for AI seeds
  score.js          score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile)
                    PROFILES.retail — scoring weights + placement defaults + searchConfig
  optimize.js       optimizeLayout(...) — legacy 4 basin corners (USE_SCHEMA_OPTIMIZER=false)
                    optimizeArrangement(...) — Phase 1 schema optimizer (LIVE)
  arrange.js        realizeArrangement(schema, parcelLngLat, profile) — Phases A–E all done
```

---

## App state (main.js module scope)
```javascript
parcelLatLng  // [{lat, lng}]   raw map vertices
parcelFt      // [{x, y}]       projected to feet from centroid
centroid      // {lat, lng}     parcel centroid, reference for all conversions
lastLayout    // last solver/optimizer/arranger output — used by renderer and export
aiHints       // accumulated hints from AI (merged on each Apply AI Hints click)
              // keys: setbackFt, clearanceFt, basinCorner, orientationPreference, frontage
              // NOTE: aiHints.frontage is NOT read directly in onSolve —
              // onApplyAI writes it into the #input-frontage dropdown instead.

const USE_ARRANGER        = true;  // Solve button routes through realizeArrangement (Phase E)
const USE_SCHEMA_OPTIMIZER = true;  // Optimize button routes through optimizeArrangement Phase 1
                                    // Set false to fall back to legacy 4-basin-corner search
```

---

## Solver API

### Inputs
```javascript
reqs = {
  buildings:      [{ label, length_ft, width_ft }],  // up to 5, sorted largest-first internally
  parking_stalls: 50,          // stalls; 0 = no parking
  pondPct:        15,          // % of parcel area for basin; or use pondSqFt directly
  driveways:      1,           // count of driveway strips
}
hints = {
  setbackFt:             20,
  clearanceFt:           30,   // guaranteed building-to-building gap (full buffer, not /2)
  basinCorner:           'SW', // SW | SE | NW | NE — overrides frontage default when set
  orientationPreference: 'auto', // NS | EW | auto
  frontage:              'auto', // 'auto'|'N'|'S'|'E'|'W' — which edge fronts the road
}
```

### Layout output shape (used by render.js, score.js, and the arranger adapter)
```javascript
{
  buildings:      [{ label, length_ft, width_ft, center_x_ft, center_y_ft, orientation_deg }],
  parking_areas:  [Turf Feature<Polygon> with .properties { center_x_ft, center_y_ft, orientation_deg, stall_count }],
  driveways:      [Turf Feature<Polygon>],
  detention_pond: Turf Feature<Polygon> | null,
  warnings:       ['Basin undersized: ...', 'Building X does not fit.', ...],
  rationale:      string,
}
```

**This layout shape is the contract.** render.js and score.js both consume it.
`layoutFromElements` in optimize.js and `layoutFromArrangement` in main.js both
convert `realizeArrangement` output into this same shape.

---

## score.js — Pure layout scorer

### API
```javascript
import { score, PROFILES } from './score.js';

const result = score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, PROFILES.retail, road);
// road = detectedRoad from road.js: { cardinal, line (Turf LineString WGS84), nearestPt, distanceFt }
//        or null (neutral: drivewayConnected scores 1)
// result: { total, maxScore, terms }
// terms: { termName: { raw, weight, contribution } }
```

`parcelFt` = `[{x, y}]` in feet from centroid (from `latLngToFeet(parcelLatLng)`).
`parcelAreaSqFt` = shoelace area of parcelFt.
`frontage` must be a resolved 'N'|'S'|'E'|'W' — not 'auto'.

### PROFILES.retail
```javascript
// Scoring weights (Phase 3 driveway scoring — accessQuality RETIRED)
buildingsPlaced:   1.0    // fraction of requested buildings placed
parkingMet:        0.9    // gotStalls / reqStalls, capped at 1
parkingInFront:    0.7    // parking center depth < building center depth → in front
roadVisibility:    0.6    // mean building setback in plateau(60, 200, 250) ft band
coverageTarget:    0.5    // building footprint / parcel area in plateau(0.20, 0.25, 0.20)
drivewayConnected: 0.4    // fraction of driveways that intersect a 30 ft buffer around detected road
                          // neutral = 1 when road is null (no road detected) or no driveways
drivewayLength:    0.3    // plateau(realizedLen / meanBldgDepth, lo=0.6, hi=1.0, falloff=0.5)
                          // rewards lanes that span the parking depth; penalizes gross overshoot
                          // neutral = 1 when no driveways or no buildings
drivewayPresent:   0.4    // 1 if any driveway placed, 0 if none
basinAccuracy:     0.3    // 1 - |gotBasinSqFt - targetSqFt| / targetSqFt
compactness:       0.15   // 1 - buildingSpread / parcelDiagonal (multi-building only)
openSpace:         0.0    // placeholder (irrelevant for retail)

// Placement defaults (used by arrange.js — read from profile, not hardcoded)
setbackFt:             20    // parcel setback before placement
clearanceFt:           30    // building-to-building clearance gap
maxBuildingDepthFt:    70    // max building depth from road (arrange.js size derivation)
minBuildingAreaSqFt:  400    // minimum viable area (feasibility check for parking too)
stallDepthFt:          18    // parking stall depth
aisleFt:               24    // parking aisle width
drivewayWidthFt:       24    // driveway strip width
defaultDriveLengthFt: null   // null → derive functional length (road → building far face)
gapFt:                 10    // gap between elements (parking → free subtraction)
// Driveway scoring knobs (Phase 3)
drivewayConnectThreshFt: 30   // buffer (ft) around road.line to test driveway intersection
drivewayLengthLo:        0.6  // ratio below which drivewayLength scores < 1
drivewayLengthHi:        1.0  // ratio above which drivewayLength starts to decay
drivewayLengthFalloff:   0.5  // how fast the score decays past hi

// Schema-optimizer search config (all value-sets live here, NOT in optimize.js)
searchConfig: {
  layout:        ['strip'],
  gapFt:         [0, 20],
  parkingFaces:  ['front'],
  driveways:     [['left'], ['center'], ['right'], ['left', 'right']],
  // NOTE: generateCandidates filters this list to sets whose .length === reqs.driveways
  // so a user requesting 2 driveways only gets ['left','right'] candidates, not single-driveway ones
  basinCorner:   ['rearLeft', 'rearRight', 'frontLeft', 'frontRight'],
  setbackFt:     [15, 25, 35],
  alignU:        ['left', 'center', 'right'],
  maxCandidates: 500,
  topK:          4,    // Phase 2 refines around this many Phase 1 winners
  displayK:      10,   // rows shown in the step-through optimizer panel
  refineConfig: {
    setbackStep:          2,                       // ft between fine setback samples
    setbackRange:         9,                       // ±ft around Phase 1 winner value
    alignOffsetsFt:       [-60, -30, 0, 30, 60],  // u-offsets (ft) from base Phase 1 alignU
    driveLengthOffsetsFt: [-40, -20, 0, 20, 40],  // ft offsets from winner's realized driveway length
  },
}
```

**Max score for retail = 1.0+0.9+0.7+0.6+0.5+0.4+0.3+0.4+0.3+0.15 = 5.25** (after Phase 3 driveway scoring).
Score panel shows `total.toFixed(2) / maxScore.toFixed(2)`.

**maxScore computation** (fixed — `score()` sums only scored term weights):
```javascript
// Correct: only sums weights of scored terms, not all profile values
const maxScore = Object.values(terms).reduce((s, t) => t.weight > 0 ? s + t.weight : s, 0);
```

### Score helpers
```javascript
const clamp01 = v => Math.max(0, Math.min(1, v));

function depthFromFront(pt, frontage, b) {
  // b = {minX, maxX, minY, maxY} of parcelFt
  // S: return pt.y - b.minY  (distance from south edge)
  // N: return b.maxY - pt.y
  // W: return pt.x - b.minX
  // E: return b.maxX - pt.x
}

function plateau(v, lo, hi, falloff) {
  // 1 if v in [lo,hi]; ramps up below lo; decays above hi over falloff
}
```

### Coordinate system note for score.js
`depthFromFront` uses feet coordinates from `parcelFt` and building `center_x_ft`/`center_y_ft`.
Both use the SAME origin (parcel centroid from `latLngToFeet`). The building centers in
layouts come from `latLngToFeetFromCentroid({lat, lng}, centroid)` using the same centroid.
Parking `center_x_ft`/`center_y_ft` similarly uses `latLngToFeetFromCentroid`. All comparable. ✓

### Scoring UI wiring in main.js
Score is computed inside `renderLayout(layout, reqs, isDeterministic, frontageHint)`:
```javascript
const resolvedFrontage = ['N','S','E','W'].includes(frontageHint) ? frontageHint : 'S';
const scoreResult = score(layout, reqs, parcelFt, parcelSqFt, resolvedFrontage, PROFILES.retail, detectedRoad);
// detectedRoad is module-scoped (line ~41); null until Overpass query succeeds
// then populate #score-total and #score-breakdown
```

`onSolve` passes `hints.frontage`; `onOptimize` passes the resolved frontage.

---

## ai.js — AI features

### `parseInstructions(text)` — existing (Phase 7)
Parses a plain-English site instruction into a hints object via Gemini 2.5 Flash.
Returns `{ setbackFt?, clearanceFt?, basinCorner?, orientationPreference?, frontage? }`.

### `proposeArrangements(parcelSummary, reqs, frontage, profile)` — AI Schema-Proposer Phase 1

**Important:** Runs on the **main thread only**. Workers have no `window` and cannot read `GEMINI_API_KEY`. Local-only until the key is proxied through a backend — do NOT deploy with a client-readable key.

**Returns:** `Promise<knobSet[]>` — validated knob-set objects ready to pass to `buildCandidateSchema`. Returns `[]` on any error (missing key, timeout, bad JSON, API error, failed validation).

**Knob-set shape:**
```javascript
{
  layout:       'strip',              // currently always 'strip'
  gapFt:        0 | 20,              // snapped to nearest value in searchConfig.gapFt
  parkingFaces: 'front',             // validated against searchConfig.parkingFaces split('+')
  driveways:    ['left'],            // array of entryU strings, each in {left,center,right}
  basinCorner:  'rearLeft' | ...,    // required; object dropped if invalid
  setbackFt:    25,                  // clamped [0, 200]
  alignU:       'center' | number,   // string {left,center,right} or finite number (feet)
}
```

**Prompt:** Injects parcel acres/width/depth, building program sqFt, parking stalls, pondPct, and all valid values from `profile.searchConfig`. Requests exactly 5 proposals with no prose/fences.

**Reliability design:**
- 4 s `AbortController` timeout wrapping the fetch (fires before `clearTimeout` in finally block)
- `temperature: 0.3`, `maxOutputTokens: 512`
- Fence-stripping: `raw.replace(/```(?:json)?\n?/g, '').replace(/```\n?/g, '').trim()`
- Per-object validation loop: `basinCorner` required (drops object if invalid); `layout` defaults `'strip'`; `gapFt` snapped to nearest in array; `parkingFaces` validated by splitting on `'+'`; `driveways` validated as `string[]` of `{left,center,right}`; `setbackFt` clamped `[0, 200]`; `alignU` accepts `string {left,center,right}` or finite number
- Full outer `try/catch` → `[]` on any unexpected error

**Why main thread:** Workers have no `window`, so `window.GEMINI_API_KEY` is undefined. The call must complete on the main thread before the worker is spawned. `onOptimize` was made `async` to `await proposeArrangements(...)` first, then passes `aiSeeds` to the worker via `postMessage`.

---

## optimize.js — Schema optimizer (Phases 1–3) + legacy optimizer

### Legacy optimizer (behind USE_SCHEMA_OPTIMIZER = false)
```javascript
export function optimizeLayout(parcelLatLng, reqs, baseHints, profile, parcelFt, parcelAreaSqFt, frontage, road = null)
// Tries 4 basin corners (SW/SE/NW/NE), scores each, returns { best, all }.
// frontage is FIXED — never searched. Hard architectural rule.
```

### Schema optimizer Phases 1–3 — `optimizeArrangement`

**Entry point:**
```javascript
export function optimizeArrangement(parcelLngLat, reqs, frontage, profile, onProgress = null, aiSeeds = [], road = null)
// Returns { ranked, totalTried }
// ranked: array of { schema, layout, total, maxScore, terms, feasible:true, source:'ai'|'grid' } sorted by total desc
// totalTried: count of all candidates attempted across AI seeds + Phase 1 + Phase 2 (including infeasible ones)
//
// road: detectedRoad object (Turf LineString WGS84) or null — threaded to all score() calls
//   GeoJSON is structured-cloneable so it crosses postMessage to the worker without special handling.
//
// onProgress(callback): called whenever a new best candidate is found during the search.
//   callback receives { best: candidate, totalTried }
//   Used by the Web Worker to stream progress to the main thread. Pass null for synchronous path.
//
// aiSeeds: pre-validated knob-set objects from proposeArrangements (main thread).
//   Scored first through the identical realize→gate→score pipeline as grid candidates.
//   Deduped against Phase 1 grid via knobSig. Pass [] for a purely deterministic run.
```

**Internal signatures (road threaded through):**
```javascript
function refineArrangement(topKWinners, parcelLngLat, reqs, frontage, profile, parcelFt, parcelAreaSqFt, road = null)
export function scoreAiSeeds(seeds, parcelLngLat, reqs, frontage, profile, road = null)
```

**`knobSig` deduplication helper:**
```javascript
export function knobSig(k) {
  const dw = Array.isArray(k.driveways) ? [...k.driveways].sort().join(',') : String(k.driveways);
  const dl = Number.isFinite(k.drivewayLengthFt) ? k.drivewayLengthFt : 'def';
  return `${k.layout}|${k.gapFt}|${k.parkingFaces}|${dw}|${k.basinCorner}|${k.setbackFt}|${k.alignU}|${dl}`;
}
```
Driveways array is sorted so `['right','left']` and `['left','right']` hash identically. `dl` segment ensures candidates differing only in driveway length are not deduplicated. Used to prevent AI seeds from being re-scored as Phase 1 grid candidates.

**AI seeds execution (inside try block, after turf monkey-patch):**
```javascript
const seenSigs = new Set();
for (const knobs of aiSeeds) {
  const sig = knobSig(knobs);
  if (seenSigs.has(sig)) continue;
  seenSigs.add(sig);
  totalTried++;
  const schema = buildCandidateSchema(reqs, frontage, knobs);
  let elements;
  try { ({ elements } = realizeArrangement(schema, parcelLngLat, profile)); } catch (_) { continue; }
  if (elements.some(e => !e.feasible)) continue;
  const layout = layoutFromElements(elements);
  const result = score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile);
  const candidate = { schema, layout, total: result.total, maxScore: result.maxScore,
                      terms: result.terms, feasible: true, source: 'ai' };
  ranked.push(candidate);
  notifyIfBetter(candidate);
}
```
AI seeds run first so they can beat or tie the grid candidates. Phase 1 grid skips any sig already in `seenSigs`.

**Phase 1 search space (current searchConfig):**
- 1 layout (strip) × 2 gapFt × 1 parkingFaces (front) × 4 drivewaySets × 4 basinCorners × 3 setbackFts × 3 alignUs
- = **288 candidates**, well under maxCandidates=500

**Phase 2 — `refineArrangement(topKWinners, ...)` (internal):**
After Phase 1 ranking, takes top-K winners and refines three continuous knobs:
- **setbackFt**: fine grid ±`refineConfig.setbackRange` (9 ft) in `refineConfig.setbackStep` (2 ft) steps around each winner's value, skipping Phase 1 values already tried → ~9 new setback values per winner
- **alignU (numeric)**: converts the winner's string `alignU` to a base u-coordinate in local feet, then tries `refineConfig.alignOffsetsFt` ([-60,-30,0,30,60] ft) offsets → 5 numeric u-positions per winner
- **drivewayLengthFt**: derives base from winner's realized first driveway `properties.lengthFt`, applies `driveLengthOffsetsFt` ([-40,-20,0,20,40] ft) → 5 length variants per winner (or [undefined] when no driveways)

Per-winner candidate count: ~9 setbacks × 5 alignU × 5 driveLengths = ~225 candidates × topK=4 winners = **~900 Phase 2 candidates**.

`buildCandidateSchema` accepts numeric `alignU` and `drivewayLengthFt`:
- Numeric `alignU` passes directly to the schema's `place` spec; `realizeBuilding`/`realizeGroup` use it as a local-frame u-coordinate (feet from parcel centroid along t̂)
- `drivewayLengthFt` sets `size.lengthFt` on each driveway element when finite; omitted when `undefined` (functional default applies)

**Phase 2 `refineConfig` (in `profile.searchConfig`):**
```javascript
refineConfig: {
  setbackStep:          2,                       // ft between fine setback samples
  setbackRange:         9,                       // ±ft around Phase 1 winner value
  alignOffsetsFt:       [-60, -30, 0, 30, 60],  // u-offsets (ft) from base Phase 1 alignU
  driveLengthOffsetsFt: [-40, -20, 0, 20, 40],  // ft offsets from winner's realized driveway length
}
```

**`buildCandidateSchema(reqs, frontage, knobs)`:**
Assembles one arrangement schema from a knob-value point. Computes `bSetbackFt = setbackFt + parkDepthFt`
so the building is pushed back far enough for front parking to fit between road and building face.
Single building → individual element; multiple buildings → strip group with children.

**`*generateCandidates(reqs, frontage, searchConfig)`:**
Generator that yields one schema per cross-product point. Caps at `maxCandidates`. All
value-sets come from `searchConfig` (in the profile), not hardcoded.

**Driveway count filtering (bug fix):**
```javascript
// Before entering the loop, filter drivewaySets to only those matching reqs.driveways count.
// Without this, a user requesting 2 driveways got 3 single-driveway candidates for every
// 1 double-driveway candidate, so single-driveway layouts always dominated the top-10.
const reqDwCount = reqs.driveways ?? 1;
const filteredDrivewaySets = drivewaySets.filter(s => s.length === reqDwCount);
const activeDrivewaySets = filteredDrivewaySets.length > 0 ? filteredDrivewaySets : drivewaySets;
```

**`layoutFromElements(elements)`:**
Adapts `realizeArrangement` output to the `layout` shape `score.js` expects.
Identical logic to `layoutFromArrangement` in main.js but lives in optimize.js
so optimizeArrangement is self-contained.

**Feasibility gate (lenient — buildings only):**
```javascript
// isCandidateViable: only building failures disqualify a candidate.
// Parking/driveway/basin failures reduce score via parkingMet/drivewayPresent/basinAccuracy
// rather than hard-disqualifying. Tight parcels where only partial placements fit should still
// appear in the ranked list rather than causing "No feasible layouts found".
function isCandidateViable(elements) {
  const buildings = elements.filter(e => e.type === 'building');
  return buildings.some(e => e.feasible);
}
if (!isCandidateViable(elements)) continue;
```

**`notifyIfBetter` (internal helper inside `optimizeArrangement`):**
```javascript
let currentBest = null;
function notifyIfBetter(candidate) {
  if (!onProgress) return;
  if (!currentBest || candidate.total > currentBest.total) {
    currentBest = candidate;
    onProgress({ best: candidate, totalTried });
  }
}
```
Called after each feasible Phase 1 candidate is pushed to `ranked`, and for each Phase 2
candidate (Phase 2 push is now a loop, not `...spread`, so it can call `notifyIfBetter`
per candidate). Only fires when a new best is found — typically 5–15 events per full run.

**Turf monkey-patch (critical for multi-building scenarios):**
```javascript
// Applied at the start of optimizeArrangement, restored in finally:
turf.union      = (a, b) => { try { return origUnion(a, b);      } catch (_) { return null; } };
turf.difference = (a, b) => { try { return origDifference(a, b); } catch (_) { return null; } };
turf.intersect  = (a, b) => { try { return origIntersect(a, b);  } catch (_) { return null; } };
```
WHY: With multi-building groups, the group's bounding-box clearance buffer and the first
child's clearance buffer (used in `realizeParking`'s `turf.union(free, clearRing)`) share
EXACTLY coincident boundary segments. JSTS's ring-traversal algorithm throws
"Unable to complete output ring" on these. Arrange.js already has `?? free` / `?? null`
fallbacks for all these calls — they just never reached them because the throw propagated
first. The monkey-patch makes them return null instead of throwing, so the existing
fallbacks kick in (parking clips to a slightly smaller zone) and candidates remain feasible.
`finally` always restores the originals — nothing outside `optimizeArrangement` is affected.

**IMPORTANT for the Web Worker (Phase 3):** The worker imports Turf as an ES module namespace
which is frozen (read-only properties). The worker spreads it into a plain mutable object
(`globalThis.turf = { ...turfNS }`) so the monkey-patch can reassign `turf.union` etc.
If this spread is missing, the monkey-patch silently fails and multi-building runs throw.

**Per-candidate safety net:**
```javascript
try {
  ({ elements } = realizeArrangement(schema, parcelLngLat, profile));
} catch (_) {
  continue;  // skip any unexpected throws (e.g. turf.buffer on malformed geometry)
}
```

---

### Phase 3 — Web Worker (`js/optimizer-worker.js`)

**Why a worker:** Phase 1+2 search (~468 candidates × ~20ms each on a typical parcel)
blocks the main thread for several seconds. Moving it to a worker keeps the map and sidebar
interactive while the search runs and enables streaming best-so-far renders.

**Worker file: `js/optimizer-worker.js`**
```javascript
// Module worker — importScripts() is NOT available in module workers.
// Turf must be imported as ESM and spread into a mutable plain object
// so the monkey-patch inside optimizeArrangement can reassign turf.union etc.
import * as turfNS from 'https://esm.sh/@turf/turf@6.5.0';
globalThis.turf = { ...turfNS };  // mutable plain object — frozen namespace won't work

import { optimizeArrangement } from './optimize.js';

self.onmessage = ({ data }) => {
  const { parcelLatLng, reqs, frontage, profile, aiSeeds = [], road = null } = data;
  const { ranked, totalTried } = optimizeArrangement(
    parcelLatLng, reqs, frontage, profile,
    (progress) => self.postMessage({ type: 'progress', ...progress }),
    aiSeeds,
    road,
  );
  self.postMessage({ type: 'done', ranked, totalTried });
};
```

**Worker message protocol:**
- Main → worker: `{ parcelLatLng, reqs, frontage, profile, road }` via `postMessage`
  - `profile` = `PROFILES.retail` — all primitives/arrays, fully structured-cloneable ✓
  - `road` = `detectedRoad` (GeoJSON LineString) or `null` — structured-cloneable ✓
  - Turf polygon results in `ranked` are GeoJSON (plain objects) — also cloneable ✓
- Worker → main (`type: 'progress'`): `{ type, best: candidate, totalTried }`
  - Fired only on new best — typically 5–15 times per full run
  - Main thread renders `best.layout` live on the map (streaming best-so-far)
- Worker → main (`type: 'done'`): `{ type, ranked, totalTried }`
  - Fired once when AI seeds + Phase 1 + Phase 2 are all complete

**Worker creation:** `new Worker('./js/optimizer-worker.js', { type: 'module' })`
Requires page served over HTTP (Live Server ✓). Does not work from `file://`.

---

### Optimizer UI in main.js (Phase 3 schema optimizer path)

**Module-level state added for Phase 3:**
```javascript
let optimizerWorker = null;  // reference to running Worker, or null
let lastRanked      = [];    // full ranked array from last completed run
let lastReqs        = null;  // reqs at time of last optimize click (for step-through renders)
let lastFrontage    = 'S';   // frontage at time of last optimize click
```

**`onOptimize` flow (USE_SCHEMA_OPTIMIZER = true) — now `async`:**
1. If a worker is already running, terminate it first (user hit Optimize again)
2. Store `lastReqs` and `lastFrontage` for step-through click handlers
3. Disable "Optimize Layout" button, show "Cancel Optimization" button
4. Set status `'Proposing layouts…'`, await `proposeArrangements(parcelSummary, reqs, frontage, PROFILES.retail)`
   - Computes `parcelSummary = { acres, widthFt, depthFt }` from `parcelFt` bounding box
   - If user cancelled during the Gemini await (btn-optimize re-enabled by cancel handler), return early
5. Set status `'Optimizing…'`, spawn new worker via `new Worker('./js/optimizer-worker.js', { type: 'module' })`
6. `worker.postMessage({ parcelLatLng, reqs, frontage, profile: PROFILES.retail, aiSeeds, road: detectedRoad })`
7. On `progress` message: `clearSolveOverlays()`, render `best.layout` live, update status text
8. On `done` message: restore buttons, populate `lastRanked`, render winner, call `showSchemaOptimizerResult(ranked)`
9. On `onerror`: restore buttons, log to console, show error in status bar

**Cancellation guard after Gemini await:**
```javascript
if (!document.getElementById('btn-optimize').disabled) return; // cancelled during Gemini call
```
The cancel and solve handlers re-enable btn-optimize. If it was re-enabled while awaiting Gemini, skip spawning the worker.

**`onCancelOptimize`:**
```javascript
function onCancelOptimize() {
  if (optimizerWorker) { optimizerWorker.terminate(); optimizerWorker = null; }
  document.getElementById('btn-cancel-optimize').style.display = 'none';
  document.getElementById('btn-optimize').disabled = false;
  document.getElementById('status').textContent = 'Optimization cancelled.';
}
```

**Worker lifecycle rules:**
- `onSolve`: terminates worker (user switching to manual solve), restores optimize button
- `onClear`: terminates worker, hides cancel button, resets `lastRanked`/`lastReqs`
- `onOptimize`: terminates any existing worker before spawning a new one

**`showSchemaOptimizerResult(ranked)` (Phase 3 + AI Phase 1 version):**
- Shows `searchConfig.displayK` (10) rows instead of `topK` (4)
- Candidates with `source:'ai'` display an `<span class="opt-ai-tag">AI</span>` badge before the params
- Winner row starts with both `opt-candidate-winner` and `opt-candidate-active` classes
- Each row has a click handler for **step-through**:
  ```javascript
  row.addEventListener('click', () => {
    container.querySelectorAll('.opt-candidate').forEach(r => r.classList.remove('opt-candidate-active'));
    row.classList.add('opt-candidate-active');
    clearSolveOverlays();
    lastLayout = c.layout;
    renderLayout(c.layout, lastReqs, true, lastFrontage);
  });
  ```
  Clicking any row clears the map and renders that candidate's layout. The score breakdown
  panel updates too (via `renderLayout`). The clicked row highlights in blue
  (`opt-candidate-active`), winner row stays green (`opt-candidate-winner`).

**`fmtAlignU(alignU)` helper (added in Phase 2, used here):**
```javascript
function fmtAlignU(alignU) {
  if (typeof alignU !== 'number') return alignU;
  return `u${alignU >= 0 ? '+' : ''}${Math.round(alignU)}ft`;
}
```
Formats Phase 2 numeric alignU values (e.g. `-42` → `u-42ft`) in the optimizer panel rows
and status bar. String values ('left', 'center', 'right') pass through unchanged.

**Cancel button in `index.html`:**
```html
<button id="btn-cancel-optimize" style="display:none">Cancel Optimization</button>
```
Placed directly after `btn-optimize`. Shown only while a worker is running.

**`searchConfig` keys relevant to UI:**
```javascript
topK:     4,   // Phase 2 refines around this many Phase 1 winners
displayK: 10,  // rows shown in the step-through optimizer panel
```

---

## arrange.js — Relational placement engine

### Spec file
`relational-placement-spec.md` — read this before implementing any phase.

### Current status: ALL Phases A–E COMPLETE

### Entry point
```javascript
import { realizeArrangement } from './arrange.js';

const { elements, freeRemaining } = realizeArrangement(schema, parcelLngLat, profile);
// elements: [{id, type, feasible, reason?, ...geomFields}]
// freeRemaining: Turf polygon of remaining free space after placement
```

### Schema format (what main.js buildTestSchema emits)
```json
{
  "frontage": "S",
  "elements": [
    { "id": "b1", "type": "building",
      "size": { "areaSqFt": 12000, "maxDepthFt": 70 },
      "place": { "anchor": "parcelFrontage", "setbackFt": 25, "alignU": "center" } },

    { "id": "p1", "type": "parking",
      "size": { "stalls": 60 },
      "place": { "anchor": "b1", "face": "front" } },

    { "id": "d1", "type": "driveway",
      "size": { "widthFt": 24 },
      "place": { "connects": "parcelFrontage", "to": "p1", "entryU": "left" } },

    { "id": "bn1", "type": "basin",
      "size": { "pctOfParcel": 0.08 },
      "place": { "anchor": "parcelCorner", "corner": "rearLeft" } }
  ]
}
```

### Local frame (the coordinate foundation)
All relations resolve in a parcel-local frame derived from frontage. Origin = parcel centroid.

```
n̂ (n): unit vector pointing inward (perpendicular to frontage, into the lot)
t̂ (t): unit vector along the frontage edge

v = depth into lot  (0 at frontage edge, positive inward)
u = lateral offset  (0 at parcel centroid, positive in t̂ direction)

Frame by frontage:
  S: n̂ = {x:0,  y:1}   t̂ = {x:1,  y:0}   (road at south; inward = north; along = east)
  N: n̂ = {x:0,  y:-1}  t̂ = {x:1,  y:0}   (road at north; inward = south; along = east)
  E: n̂ = {x:-1, y:0}   t̂ = {x:0,  y:1}   (road at east;  inward = west;  along = north)
  W: n̂ = {x:1,  y:0}   t̂ = {x:0,  y:1}   (road at west;  inward = east;  along = north)

Convert feet → local:
  u = pt.x * t̂.x + pt.y * t̂.y
  v = pt.x * n̂.x + pt.y * n̂.y

Convert local → feet:
  x = u * t̂.x + v * n̂.x
  y = u * t̂.y + v * n̂.y

frontageV(parcelFt, frame) = min(v for all parcel vertices)
  = the v-coordinate of the frontage edge (closest to road = smallest v)
```

### Topological sort
Dependencies extracted from `place.anchor`, `place.to`, `place.connects` (excluding
parcel-level anchors: `parcelFrontage`, `parcelCorner`). DFS topo-sort; cycle → all
involved elements return `{feasible: false, reason: 'Dependency cycle'}`.

**`childToGroup` map** (built before topoSort):
When parking anchors to a group child (e.g. `anchor: "A"` where A is inside group g1),
the dependency resolves to the parent group so topo-sort places g1 before p1.
```javascript
const childToGroup = {};
for (const el of schema.elements) {
  if (el.type === 'group' && el.children)
    for (const child of el.children) childToGroup[child.id] = el.id;
}
```

---

### Phase A — realizeBuilding (anchor: 'parcelFrontage' only)

**Size derivation from schema:**
```javascript
areaSqFt   = size.areaSqFt ?? profile.defaultBuildingAreaSqFt ?? 12000
maxDepthFt = size.maxDepthFt ?? profile.maxBuildingDepthFt ?? 70
depthFt    = min(maxDepthFt, sqrt(areaSqFt))   // depth along n̂
faceFt     = areaSqFt / depthFt                 // face along t̂
bSpec = {
  label:     el.id,
  length_ft: max(depthFt, faceFt),  // longer side
  width_ft:  min(depthFt, faceFt),  // shorter side
}
```

**Target point derivation:**
```javascript
vFront    = frontageV(parcelFt, frame)       // v-coord of frontage edge
halfDepth = bSpec.width_ft / 2              // shorter side faces road at orient=0
targetV   = vFront + setbackFt + halfDepth  // building center depth from road
targetU   = 0                               // alignU:'center' → at parcel centroid
targetPt  = localToFeet(targetU, targetV, frame)
```

For `alignU: 'left'|'right'`: targetU = parcel u-extent min/max ± (setbackFt + length/2).

**Placement:**
```javascript
const placed = placeBuilding(free, bSpec, targetPt, [0, 90], centroid);
```

**Free space update:**
```javascript
const foot = rectPoly(result.center_x_ft, result.center_y_ft,
                      result.length_ft, result.width_ft,
                      result.orientation_deg, centroid);
const buf = turf.buffer(foot, profile.clearanceFt ?? 30, { units: 'feet' });
if (buf) free = turf.difference(free, buf) ?? free;
```

**Building element output shape:**
```javascript
{
  id: 'b1', type: 'building', feasible: true,
  label: 'b1',
  length_ft: 200, width_ft: 100,
  center_x_ft: ..., center_y_ft: ...,  // feet from parcel centroid
  orientation_deg: 0,                   // 0 = length along x; 90 = length along y
}
```

---

### Phase B — realizeParking (anchor: element id, face: 'front'|'rear')

**Looks up anchor building from `realized` map. Fails gracefully if anchor is infeasible.**

**Bounds helper** `buildingLocalBounds(b, frame)`: rotates all 4 corners into local (u,v)
and returns `{uMin, uMax, vMin, vMax}`. `vMin` = front face (closest to road) for any
frontage direction and any orientation_deg.

**Sizing from stall target:**
```javascript
faceFt        = ab.uMax - ab.uMin           // building's u-extent (along frontage)
stallsPerRow  = max(1, floor(faceFt / 9))   // 9 ft per stall width
rows          = ceil(targetStalls / stallsPerRow)
stallRowDepth = profile.stallDepthFt + profile.aisleFt / 2  // 18 + 12 = 30 ft/row
depthFt       = rows * stallRowDepth
```

**Placement in local frame:**
```javascript
vFace = ab.vMin  // front face of building (face: 'front')
vNear = vFace - depthFt  // parking extends toward road
vFar  = vFace            // parking touches building face
```

**Parking clearance restore (critical):**
Before clipping parking to `free`, restore the anchor building's own clearance zone
back into free so parking is allowed to occupy that zone:
```javascript
const anchorFoot = rectPoly(anchorEl.center_x_ft, anchorEl.center_y_ft,
                            anchorEl.length_ft, anchorEl.width_ft,
                            anchorEl.orientation_deg ?? 0, centroid);
const anchorBuf  = turf.buffer(anchorFoot, clearanceFt, { units: 'feet' });
const clearRing  = anchorBuf ? (turf.difference(anchorBuf, anchorFoot) ?? anchorBuf) : null;
const freeForPark = clearRing ? (turf.union(free, clearRing) ?? free) : free;
const clipped = turf.intersect(freeForPark, parkRect);
```

**Parking element output shape:**
```javascript
{
  id: 'p1', type: 'parking', feasible: true,
  feature: clipped,          // Turf Feature<Polygon> with .properties attached
  stall_count: actualStalls,
  localBounds: { uMin, uMax, vMin: vNear, vMax: vFar },
  // localBounds stores the PRE-CLIP intended rectangle so driveways can
  // position against the full parking block without bbox approximation error.
}
```

**Free space update:** subtract `clipped + profile.gapFt (10 ft) buffer`.

---

### Phase C — realizeDriveway (connects: 'parcelFrontage', to: elementId, entryU: 'left'|'center'|'right')

**u-center of driveway** (within target's u-extent):
```javascript
case 'left':   uCenter = targetBounds.uMin + halfWidth
case 'right':  uCenter = targetBounds.uMax - halfWidth
default:       uCenter = (targetBounds.uMin + targetBounds.uMax) / 2
```

**v range:**
```javascript
vFront  = frontageV(parcelFt, frame)   // parcel road edge
vTarget = Math.max(targetBounds.vMin, vFront + 1)  // clamp to avoid going outside parcel
// Rectangle: [uCenter ± halfWidth] × [vFront - 50, vTarget]
// 50 ft over-extension ensures clip to parcel reaches the road boundary exactly.
```

**Clip to `parcelTurf` (NOT free):** driveways pass through the setback zone between
road and parking, which has already been eroded from `free`. Clipping to the full
parcel polygon keeps the driveway inside the lot while covering the setback strip.

**Free space update:** subtract `clipped + 3 ft buffer`.

---

### Phase D — realizeGroup (group/strip along t̂)

**Schema element:**
```json
{ "id": "g1", "type": "group", "layout": "strip",
  "place": { "anchor": "parcelFrontage", "setbackFt": 110 },
  "gapFt": 0,
  "children": [
    { "id": "A", "size": { "areaSqFt": 20000, "maxDepthFt": 100 } },
    { "id": "B", "size": { "areaSqFt": 12000, "maxDepthFt": 80  } }
  ] }
```

**`scanGroupPlacement` (NOT `placeBuilding`):**
`placeBuilding` uses `reach = hypot(length, width)/2` isotropic erosion — for a 300×80
group this is 155 ft, requiring 310 ft parcel depth just for the legal zone.
`scanGroupPlacement` checks DIRECT POLYGON CONTAINMENT: builds exact bounding-box polygon
at each candidate position and calls `turf.intersect` to verify fit. For an 80 ft deep
group, only 40 ft of clearance from the N/S boundary is needed.

Scans forward in 10 ft steps from `startV`, trying 5 lateral shifts at each depth.

**Child distribution:** all children's FRONT FACES align to the group's front face.
Shorter children leave open space at their rear, not at the front.

**Free space update:** group BOUNDING BOX (not individual children) subtracted with
clearanceFt buffer. Prevents double-buffering with child clearance buffers.

**Children in `results`:** each child pushed into top-level `results` with `type: 'building'`
AND registered in `realized` under their own id (e.g. `realized['A']`). This lets
downstream parking anchor directly to `"A"` and find it after the group is realized.

---

### Phase E — realizeBasin (anchor: 'parcelCorner')

**Schema element:**
```json
{ "id": "bn1", "type": "basin",
  "size": { "pctOfParcel": 0.08 },
  "place": { "anchor": "parcelCorner", "corner": "rearLeft" } }
```

**Corner name resolution:**
Semantic names (relative to frontage) are converted to cardinal directions:
```javascript
const SEMANTIC_TO_CARDINAL = {
  rearLeft:   { S:'NW', N:'SE', E:'SW', W:'NE' },
  rearRight:  { S:'NE', N:'SW', E:'NW', W:'SE' },
  frontLeft:  { S:'SW', N:'NE', E:'SE', W:'NW' },
  frontRight: { S:'SE', N:'SW', E:'NE', W:'SW' },
};
// Cardinals (NW, NE, SW, SE) pass through directly.
```

**Placement:**
Computes target basin area from `pctOfParcel * parcelAreaSqFt`. Finds the parcel corner
vertex nearest the target cardinal corner, then clips a rectangular block from that corner
using binary-search to hit the target area within tolerance.

**`pondPct=0` bug (fixed in Phase E):**
When `pondPct = 0`, `buildTestSchema` correctly omits the basin element from the schema.
However, `layoutFromArrangement` used `elements.find(e => e.type === 'basin')?.feature ?? null`
— this was correct but an earlier version called `.feature` unconditionally which would
throw `TypeError: Cannot read properties of undefined (reading 'feature')` when no basin
element existed. Fixed by ensuring the `?.feature` optional chain is used correctly.
The optimizer's `layoutFromElements` in optimize.js handles this the same way. ✓

**Basin element output shape:**
```javascript
{
  id: 'bn1', type: 'basin', feasible: true,
  feature: turfPolygon,  // the clipped basin polygon
}
```

---

### realizeElement dispatch
```javascript
function realizeElement(el, free, parcelFt, parcelTurf, frame, centroid, profile, realized) {
  if (el.type === 'building') return realizeBuilding(el, free, parcelFt, frame, centroid, profile);
  if (el.type === 'parking')  return realizeParking(el, free, parcelFt, frame, centroid, profile, realized);
  if (el.type === 'driveway') return realizeDriveway(el, parcelFt, parcelTurf, frame, centroid, profile, realized);
  if (el.type === 'group')    return realizeGroup(el, free, parcelFt, frame, centroid, profile);
  if (el.type === 'basin')    return realizeBasin(el, free, parcelFt, frame, centroid, profile);
  return { id: el.id, type: el.type, feasible: false, reason: `${el.type} not implemented` };
}
```

---

### Adapter in main.js (`layoutFromArrangement`)
```javascript
function layoutFromArrangement(elements) {
  return {
    buildings: elements
      .filter(e => e.type === 'building' && e.feasible)
      .map(e => ({ label: e.label ?? e.id, length_ft: e.length_ft, width_ft: e.width_ft,
                   center_x_ft: e.center_x_ft, center_y_ft: e.center_y_ft,
                   orientation_deg: e.orientation_deg ?? 0 })),
    parking_areas: elements
      .filter(e => e.type === 'parking' && e.feasible)
      .map(e => e.feature),
    driveways: elements
      .filter(e => e.type === 'driveway' && e.feasible)
      .map(e => e.feature),
    detention_pond: elements.find(e => e.type === 'basin' && e.feasible)?.feature ?? null,
    warnings: elements.filter(e => !e.feasible)
                      .map(e => `[arrange] ${e.id}: ${e.reason ?? 'infeasible'}`),
    rationale: 'realizeArrangement (Phase E)',
  };
}
```

**IMPORTANT:** `layoutFromArrangement` filters for `e.type === 'building'`. Group child
results are pushed into the top-level `results` array with `type: 'building'`, so they
are picked up correctly. The parent group element (`type: 'group'`) is NOT included in
the buildings list — only the children are.

---

### `buildTestSchema` in main.js (used by onSolve)

Builds the schema for the Solve button. Single building → individual element.
Multiple buildings → group/strip containing all as children.

Key formula — bSetbackFt pushes building back to make room for front parking:
```javascript
const stallsPerRow = Math.max(1, Math.floor(firstFace / 9));
const parkRows     = reqs.parking_stalls > 0 ? Math.ceil(reqs.parking_stalls / stallsPerRow) : 0;
const parkDepthFt  = parkRows * 30;   // 18 ft stall + 12 ft aisle/2 = 30 ft per row
const bSetbackFt   = setbackFt + parkDepthFt;
```

Basin included only when `reqs.pondPct > 0` (using the UI basin-corner dropdown value).
Driveways: 1 → center, 2 → left+right, 3 → left+center+right.

---

## solver.js — placeBuilding export (used by arrange.js)

```javascript
export function placeBuilding(free, bSpec, targetPt, orientations, centroid) {
  for (const deg of orientations) {
    const r = reach(bSpec.length_ft, bSpec.width_ft);
    const legal = turf.buffer(free, -r, { units: 'feet' });
    if (!legal) continue;
    const cands = gridPointsInside(legal, 10, centroid);
    if (cands.length === 0) continue;
    cands.sort((a, b) => dist2(a, targetPt) - dist2(b, targetPt) || a.y - b.y || a.x - b.x);
    return { ...bSpec, center_x_ft: cands[0].x, center_y_ft: cands[0].y, orientation_deg: deg };
  }
  return null;
}
// Returns {…bSpec, center_x_ft, center_y_ft, orientation_deg} or null.
// Caller is responsible for subtracting footprint + clearance from free after placement.
```

---

## Frontage parameter — how it works

`resolveFrontage(parcelLatLng, hints)` in solver.js is the single resolver:
- `hints.frontage` = 'N'|'S'|'E'|'W' → use that direction
- anything else (undefined, 'auto') → returns `'S'`

**Basin default corner** (Step 3): when `hints.basinCorner` is undefined, the solver
derives the default from frontage: `S→NE, N→SW, W→SE, E→NW` (opposite the road).
**IMPORTANT**: the UI basin-corner `<select>` always sends an explicit value (SW/SE/NW/NE),
so this default only fires when `basinCorner` is absent from hints.

---

## Road Frontage UI

### index.html
```html
<label class="sidebar-label">
  Road frontage
  <select id="input-frontage">
    <option value="auto">Auto</option>
    <option value="S">South</option>
    <option value="N">North</option>
    <option value="E">East</option>
    <option value="W">West</option>
  </select>
</label>
```

### main.js `onSolve`
```javascript
frontage: document.getElementById('input-frontage').value,
```

### main.js `onApplyAI`
```javascript
if (hints.frontage !== undefined) {
  document.getElementById('input-frontage').value = hints.frontage;
}
```

---

## Render pipeline (render.js)

`renderLayoutOnCanvas` is **async**:
```javascript
await renderLayoutOnCanvas(canvas, parcelLatLng, layout, centroid)
```

Takes `parcelLatLng` (not `parcelFt`). Web Mercator projection + Static Maps satellite
background + scale bar. `img.crossOrigin = 'anonymous'` must be set before `img.src`.

**Satellite background note:** The canvas uses Google Static Maps API, which is a
SEPARATE API from the Maps JavaScript API used for the interactive map. Static Maps
must be independently enabled in Google Cloud Console + billing required.
The code already falls back gracefully to a dark `#1a1a2e` background when the image
fails to load — this is expected behavior if Static Maps isn't enabled.

---

## Key technical invariants

- **Turf uses WGS84** `[lng, lat]`. Feet coords only for grid sampling and building corners.
- **Erosion guarantees containment**: erode free by `reach` = half-diagonal; any center
  inside the eroded region guarantees the full rectangle fits. No place-then-check.
- **Buildings erode-and-fit; parking/driveway/basin clip-to-free.** Buildings must stay
  rectangular so clipping is not allowed. Parking/driveway/basin tolerate irregular shapes.
- **Determinism**: buildings sorted largest-first; candidates sorted by dist2 then y then x.
  Solver runs twice per solve; warns if outputs differ. Arranger is deterministic by construction.
- **placeBuilding caller updates free**: returns the placed spec; caller subtracts footprint +
  clearance. Both `solveLayout` and `arrange.js` follow this rule.
- **Driveway clips to parcelTurf, not free**: driveways span the setback zone between road
  edge and parking, which has already been eroded from `free`. Must clip to full parcel.
- **parking.localBounds stores pre-clip extents**: so `realizeDriveway` can position against
  the full intended parking rectangle without bbox-in-lat/lng approximation error.
- **Groups use scanGroupPlacement, not placeBuilding**: placeBuilding's isotropic erosion
  (reach ≈ 155 ft for a 300×80 group) eats too much parcel depth. scanGroupPlacement
  checks direct polygon containment — only 40 ft clearance needed for an 80 ft deep group.
- **bSetbackFt must include parking depth**: without this, the building sits at setback=20 ft
  and parking clips to ~20 ft — almost no stalls. Formula: `setbackFt + parkRows × 30`.
- **Parking clearance must be restored before clipping**: `free` has the building's 30 ft
  clearance subtracted. Without `turf.union(free, clearRing)` in `realizeParking`, the
  zone directly in front of the building is a hole in the parking.
- **Turf is a CDN global (v6.5.0) on the main thread**: do NOT use ESM imports in main.js / arrange.js / etc. Access as `turf.*`. Exception: `optimizer-worker.js` imports Turf from `https://esm.sh/@turf/turf@6.5.0` as ESM (module workers can't use importScripts), spread into a mutable plain object via `globalThis.turf = { ...turfNS }` so the monkey-patch can assign to it.
- **`realizeArrangement` never throws**: all failures return `{ feasible: false, reason }`.
  The try/catch in `onSolve` is a safety net for unexpected JS errors only.
- **optimizeArrangement's turf monkey-patch**: JSTS throws on exactly coincident geometry
  boundaries in multi-building groups. Monkey-patch turf.union/difference/intersect to
  return null instead of throwing, inside a try/finally that always restores originals.

---

## Schema optimizer bugs fixed (Phase 1)

### Bug 1: "Optimizer error: Unable to complete output ring" (single building)
When testing with 1 building, `optimizeArrangement` threw a Turf/JSTS geometry exception.
The outer try/catch in `onOptimize` caught it and showed "Optimizer error: ..." — killing
the whole run.
**Fix:** Added per-candidate try/catch inside the generator loop in `optimizeArrangement`.
One bad geometry silently skips that candidate; the search continues normally.
Commit: b520168 (initial impl) → per-candidate catch is in the main loop body.

### Bug 2: "No feasible layouts found (288 candidates tried)" with 5 buildings
With 5 buildings, ALL 288 candidates were either thrown or skipped. The per-candidate
try/catch from Bug 1 caught every throw, so zero candidates survived to the feasibility gate.

**Root cause:** Multi-building group's bounding-box clearance buffer and building A's
clearance buffer (used in `realizeParking`'s `turf.union(free, clearRing)`) share EXACTLY
coincident boundary segments. JSTS throws "Unable to complete output ring" on these.

**Fix:** Monkey-patch `turf.union`, `turf.difference`, `turf.intersect` at the start of
`optimizeArrangement` to return `null` instead of throwing. Arrange.js already has
`?? free` / `?? null` fallbacks for all these calls — they just never reached them because
the throw propagated first. With the monkey-patch, the fallbacks activate, parking clips
to a slightly smaller zone (no clearance restore), and candidates remain feasible+scoreable.
Commit: 6767a1f

---

## Phase roadmap (arrange.js)

| Phase | Scope | Status |
|-------|-------|--------|
| A | Local frame, schema parser, topo-sort, building → parcelFrontage | ✅ Done |
| B | parking → building face, stall-count sizing, clip-to-free | ✅ Done |
| C | driveway connects frontage → parking, entryU left/center/right | ✅ Done |
| D | group/strip: children along t̂, gapFt, child faces as anchors, scanGroupPlacement | ✅ Done |
| E | basin → parcelCorner, semantic + cardinal corners, pondPct=0 fix | ✅ Done |

## Phase roadmap (schema optimizer)

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Exhaustive discrete cross-product search, synchronous, feasibility gate, ranked output | ✅ Done |
| 2 | Local refinement: fine setbackFt grid (±9 ft in 2 ft steps) + numeric alignU offsets (±30/60 ft) around top-K winners | ✅ Done |
| 3 | Web Worker + progressive UI: move search off main thread, stream best-so-far, step-through ranked list (displayK=10 rows) | ✅ Done |

## Phase roadmap (AI schema-proposer)

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | proposeArrangements (main thread, Gemini 2.5 Flash, 5 knob-sets), aiSeeds merge into ranked list via identical realize→gate→score pipeline, knobSig dedup, opt-ai-tag badge, 4 s timeout | ✅ Done |
| 2 | 3 bias templates (visibility/parking/compact) via Promise.allSettled; Gemini fires concurrently with worker; seeds scored on main thread via scoreAiSeeds; richer parcel description (aspect + shape note) | ✅ Done |
| Deploy | Backend proxy for Gemini key; rotate keys; lock Maps key with HTTP-referrer restriction | Not started |

## Phase roadmap (driveway length + scoring — `driveway-spec.md`)

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Unweld driveway vTarget — functional default spans road→building far face; knob priority chain size.lengthFt > profile.defaultDriveLengthFt > functional; `frontageVAtU` for diagonal parcels; attach {lengthFt, widthFt, entryU} to feature.properties + element | ✅ Done |
| 2 | Expose drivewayLengthFt to optimizer — buildCandidateSchema applies it; knobSig gains \|dl; refineArrangement adds outer driveLengths loop; driveLengthOffsetsFt in refineConfig; fix generateCandidates to filter by reqs.driveways count | ✅ Done |
| 3 | Replace accessQuality with drivewayConnected + drivewayLength; thread road = null through score() + all call sites; 4 profile knobs; maxScore 4.55 → 5.25 | ✅ Done |

## Road Detection (`js/road.js`) — Phases 1–2 COMPLETE

New `js/road.js`: exports `roadConfig` (all knobs) and `async detectRoad(parcelLatLng, centroid) → roadResult | null`. Never throws.

Queries Overpass `way["highway"]` within parcel bbox expanded by `bboxMarginFt` (150 ft), converted ft→degrees via `computeScaleFactors`. Filters pedestrian types (`highwayExclude`). Collects all roads passing both gates into `survivors[]`, deduplicates by cardinal direction (keeping nearest per direction — prevents multi-segment highways from flooding the list), sorts by centroid distance. Nearest wins.

**Return shape (Phase 2 §5):**
```javascript
{
  cardinal, line, nearestPt, distanceFt, bearingDiffDeg, source: 'overpass',
  candidates: [  // all survivors deduped by cardinal, sorted by distance; [0] = winner
    { cardinal, line, nearestPt, distanceFt, bearingDiffDeg, source },
    ...
  ]
}
```
Corner lots produce `candidates.length > 1`. Road-status shows `· also: W (85 ft)` for alternates.

Wired in `main.js`:
- `onBoundaryClosed` resets `#input-frontage` to `'auto'` immediately (so a stale direction from a previous parcel never blocks detection pre-fill), then fires `detectRoad` async; stale-result guard via `parcelLatLng !== snapPts`; pre-fills dropdown (only when still `'auto'` after reset); draws thin magenta `google.maps.Polyline`.
- `onClear` removes `roadOverlay` and nulls `detectedRoad`.

### Road Detection bugs fixed (all in previous session)

**Bug 1:** Distance gate used centroid→road; fails on large parcels. Fixed: use min vertex→road distance.
**Bug 2:** Road status overwritten by "Boundary confirmed". Fixed: dedicated `<div id="road-status">`.
**Bug 3:** `distFt` ReferenceError silently dropped all survivors. Fixed: renamed to `centroidDistFt`.
**Bug 4:** Multi-segment highways produced duplicate cardinal entries (e.g., 7 × "E"). Fixed: dedup by cardinal, keep nearest.
**Bug 5:** Stale frontage direction blocked detection pre-fill on re-draw. Fixed: reset dropdown to `'auto'` at boundary close.

## Optimizer feasibility gate fix (`js/optimize.js`)

**Problem:** The gate `elements.some(e => !e.feasible)` rejected any candidate where a driveway or basin failed. On irregular/large parcels with diagonal edges, the driveway consistently failed because `frontageV` returned the global min-v rather than the actual parcel boundary at the driveway's u-position — driveway rectangle fell entirely outside the parcel. This caused "No feasible layouts found (288 candidates tried)" for all 288 candidates.

**Fix (current):** `isCandidateViable(elements)` — only building failures disqualify a candidate. Now only requires ≥ 1 building to be feasible (not all buildings). Parking/driveway/basin failures reduce score rather than disqualifying.
```javascript
function isCandidateViable(elements) {
  const buildings = elements.filter(e => e.type === 'building');
  return buildings.some(e => e.feasible);
}
```
Used in all 4 gate checks: Phase 1 grid, AI seeds loop, Phase 2 refinement, `scoreAiSeeds`. The driveway geometry root cause was also fixed separately via `frontageVAtU`.

~~**Known remaining issue:** On diagonal-edged parcels, driveways still fail (warning appears) but the optimizer now returns scored layouts instead of zero results. The root geometry issue — `frontageV` uses the global min-v rather than the actual parcel boundary at the driveway's u-position — is a deeper fix deferred to a future session.~~

**Fixed (current session):** See bug fix table below.

## Bug fixes (all committed)

| Fix | File | What changed |
|-----|------|-------------|
| Driveway geometry on diagonal-edge parcels | arrange.js | Added `frontageVAtU(parcelFt, frame, uCenter)` — scans parcel edges to find the actual boundary v at the driveway's u-position. `realizeDriveway` uses this instead of global `frontageV`. Global min-v only holds at one parcel vertex; elsewhere on slanted parcels the driveway rect started outside the parcel → "No overlap with parcel". |
| Parking stall count underreported | arrange.js | Fixed reverse-calc: was `actualSqFt / 325`, now `actualSqFt / (9 × (stallDepthFt + aisleFt/2))` = `actualSqFt / 270`. Matches forward sizing formula. |
| Parking overflows parcel boundary | arrange.js | `realizeParking` second-clips to `parcelTurf` after clipping to `freeForPark`. The `clearRing` (30ft buffer minus footprint) can extend past parcel edge on close-to-road placements. |
| 2-driveway search ignored user request | optimize.js | `generateCandidates` now pre-filters `drivewaySets` to entries whose `.length === reqs.driveways`. Previously all 4 combos ran regardless, so 3 single-driveway candidates competed against 1 double-driveway candidate. |
| Driveway renders as hair-thin line | arrange.js | Minimum vTarget changed from `vFront + 1` to `vFront + halfWidth*2` (typically 24 ft). `frontageVAtU` correctly computes real parcel edge, but old +1 left a 1 ft deep rectangle when parking abuts road boundary. |
| Scorer blind to missing driveways | score.js | Added `drivewayPresent: 0.4` weight. Previously a layout with no driveway scored 0 on `accessQuality` regardless. |
| accessQuality replaced | score.js | Retired `accessQuality: -0.25` (crude area-ratio penalty). Replaced with `drivewayConnected: 0.4` + `drivewayLength: 0.3`. maxScore 4.55 → 5.25. |

## Known remaining bug (NOT YET FIXED) — JSTS "Unable to complete output ring" on Solve path

**Symptom:** Clicking "Solve Layout" on certain parcels/programs shows the error message:
> `Error: Unable to complete output ring starting at [lng, lat]. Last matching segment found ends at [lng, lat].`

**Root cause:** The turf monkey-patch that converts JSTS throws to `null` (so `?? free` / `?? null` fallbacks kick in) is only applied inside `optimizeArrangement` (which runs in the worker). The direct `realizeArrangement` call from `onSolve` on the main thread has no monkey-patch, so the JSTS coincident-edge throw propagates up, gets caught by `onSolve`'s try/catch, and shows as an error with no layout rendered.

The coincident-edge trigger: the group's bounding-box clearance buffer and the first child's clearance buffer share exactly coincident boundary segments when the child defines the maximum group depth. JSTS's ring-traversal algorithm can't handle these.

**Fix needed:** Apply the same turf monkey-patch inside `realizeArrangement` itself (or in `onSolve` before calling it) so the Solve path is protected exactly like the Optimize path. Pattern to copy from `optimizeArrangement`:
```javascript
const origUnion      = turf.union;
const origDifference = turf.difference;
const origIntersect  = turf.intersect;
turf.union      = (a, b) => { try { return origUnion(a, b);      } catch (_) { return null; } };
turf.difference = (a, b) => { try { return origDifference(a, b); } catch (_) { return null; } };
turf.intersect  = (a, b) => { try { return origIntersect(a, b);  } catch (_) { return null; } };
try {
  // ... realizeArrangement call ...
} finally {
  turf.union      = origUnion;
  turf.difference = origDifference;
  turf.intersect  = origIntersect;
}
```
Best applied inside `realizeArrangement` itself (in arrange.js) so both call sites (onSolve + the optimizer's refineArrangement/scoreAiSeeds) are covered. The `finally` block always restores originals.

## Regulatory Feasibility Gates — Phase 1 COMPLETE

| What | File | Status |
|------|------|--------|
| Export `feetToLocal`, `frontageV`, `buildingLocalBounds` from arrange.js | js/arrange.js | ✅ |
| New module: `RULE_CHECKERS` registry + `deriveContext` + `checkGates` | js/regulatory.js | ✅ |
| `regConfig` block added to `PROFILES.retail` | js/score.js | ✅ |
| Gates wired in all 3 optimizer loops (AI seeds, Phase 1, Phase 2 refine) | js/optimize.js | ✅ |
| `gatedOut` tracked and returned from all loops; forwarded through worker | js/optimize.js + optimizer-worker.js | ✅ |
| `scoreAiSeeds` returns `{ candidates, gatedOut }` (was bare array) | js/optimize.js | ✅ |
| Manual-solve: `checkGates` in `renderLayout`; violations in warnings panel | js/main.js | ✅ |
| `· N gated` in optimizer status line | js/main.js | ✅ |
| `.reg-note` CSS class for jurisdiction disclaimer | styles.css | ✅ |

### Seven retail checkers (all hard gates)
| Rule | Check |
|------|-------|
| `parkingRatioGFA` | stalls ≥ ceil(GFA/1000 × 4.0) |
| `lotCoverage` | (footprint+parking+driveway) / parcel ≤ 80% |
| `buildingCoverage` | footprint / parcel ≤ 40% |
| `setbacks` | front ≥ 25 ft, side ≥ 10 ft, rear ≥ 15 ft (slant-correct via local frame) |
| `aisleWidth` | every driveway widthFt ≥ 24 ft (uses `properties.widthFt` from arranger) |
| `fireLane` | widest driveway ≥ 20 ft |
| `detention` | basin ≥ 0.10 × impervious area (approximate, flagged) |

### Key design choices
- `regConfig` lives in `profile` → crosses worker boundary via `postMessage` for free (no new plumbing)
- `checkGates` loop is data-driven; adding a new use type is a new `regConfig.rules` block + checker registration only
- `jurisdiction: 'UNVERIFIED…'` surfaces in warnings panel whenever a violation is shown
- `severity:'hard'` disqualifies (never ranked); `severity:'soft'` → warning only (reserved for Phase 2)
- `aisleWidth`/`fireLane` fall back to skipping if `properties.widthFt` is absent (legacy solver path)

## Pending tasks

- **Regulatory Gates Phase 2** — ADA accessible stalls, landscape/perimeter buffer, soft penalty terms
- **Tune drivewayLength scoring knobs** — `lo=0.6, hi=1.0, falloff=0.5` are intuition-set.
- **Deploy / key security** — backend proxy for Gemini key; HTTP-referrer restriction on Maps key.
- **Remaining stall shortfall on diagonal parcels**: parking area is legitimately clipped when the parcel's road-facing edge is not a straight line.

---

## API keys
- `window.MAPS_API_KEY` — Google Maps JavaScript API + Static Maps API (config.js, gitignored)
  - Maps JavaScript API: required for interactive satellite map + polygon drawing
  - Static Maps API: required for canvas satellite background in "View Scale Drawing" — SEPARATE enablement
- `window.GEMINI_API_KEY` — Gemini 2.5 Flash for AI hints (config.js, gitignored)

## How to run locally
Right-click `index.html` in VS Code → Open with Live Server → `http://127.0.0.1:5500`

## Git log (recent)
```
(current)  Phase 3 driveway scoring: drivewayConnected + drivewayLength, retire accessQuality, thread road
(previous) WIP: diagonal parcel driveway fixes + road/score/optimize updates (local commit before pull)
23a49ee   Merge origin/main: combine diagonal-parcel driveway fix + length knobs + isCandidateViable
1a12adc   driveway (remote: driveway length knob system)
bc0ecbf   Move project docs to markdow/ subdirectory
77ebaee   Add AI Schema-Proposer Phase 2 + Road Detection Phase 1
6f03ade   Fix maxScore display bug + update SUMMARY for AI Schema-Proposer Phase 1
a0fde25   Add AI schema-proposer Phase 1: proposeArrangements + aiSeeds pipeline
b6290ef   Add schema optimizer Phases 2–3: local refinement + Web Worker UI
```

**All changes are committed. Nothing uncommitted on disk.**
