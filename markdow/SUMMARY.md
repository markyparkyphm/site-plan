# AI Site Planner — Project Summary

## What this app does
Browser-based civil site-planning tool. User draws a parcel on a satellite map, enters a building program, and a deterministic geometry solver places buildings/parking/driveways/basin guaranteed to fit inside the boundary. Output renders to scale on canvas and exports as PNG.

---

## Everything that's built (all complete)

- Phases 0–7: scaffold, projection, geometry, basin solver, parking/driveways, building placement (erosion), canvas/PNG export, AI hints (Gemini)
- Frontage task: parking/driveways/basin generalized for all 4 cardinal directions; road-frontage UI dropdown; AI frontage reflection
- Scoring: `score()` with 10 weighted terms, score breakdown panel
- arrange.js Phases A–E: relational placement engine — buildings, parking, driveways, groups/strips, basins; local frame; topo-sort; scanGroupPlacement; JSTS monkey-patch
- Schema optimizer Phases 1–3: exhaustive discrete search + local refinement (Phase 2) + Web Worker off main thread with streaming best-so-far (Phase 3)
- AI Schema-Proposer Phases 1–2: `proposeArrangements` via Gemini (3 bias templates in parallel); seeds scored on main thread and merged into ranked list
- Road detection Phases 1–2: Overpass query, cardinal snap, dedup by direction, corner-lot multi-candidate, frontage pre-fill, magenta road overlay
- Driveway length knob + scoring: functional vTarget, knob priority chain, `drivewayConnected` + `drivewayLength` scoring terms replacing `accessQuality`
- **Regulatory gates Phases 1–2**: `js/regulatory.js` — 9 checkers (7 hard, 1 soft, 1 opt-in), `regConfig` in profile, gates wired in all 3 optimizer loops + manual-solve warnings panel
- **Widen arrangement Phase 1**: side/rear parking faces (`left`, `right`, `rear`, `front+rear`) in `realizeParking`; `stacked` group layout in `realizeGroup`; `searchConfig.parkingFaces` ×5, `layout` ×2, `maxCandidates` 3000; truncation flag in optimizer status line
- **Widen arrangement Phase 2a**: wrapped parking `front+left` and `front+right` — `buildCandidateSchema` splits `+` and pushes one parking element per face; `searchConfig.parkingFaces` now ×7
- **Widen arrangement Phase 2b**: L-group layout in `realizeGroup` — leg 1 strips along t̂ at front face, leg 2 stacks along n̂ at left edge; `searchConfig.layout` ×3; `maxCandidates` 6500
- **Widen arrangement Phase 2c**: U-group layout in `realizeGroup` — leg 1 across front, legs 2+3 down each side forming courtyard; gated to N≥3 buildings in generator; `searchConfig.layout` ×4; `maxCandidates` 8000
- **Optimizer label fix**: layout knob now shown in winner line and all candidate rows
- **drivewayConnected fix**: when road exists but no driveway placed, score is 0 (not neutral 1); neutral only when no road detected
- **road.js reliability**: `bboxMarginFt` 150→300, `maxDistFt` 300→500, `maxBearingDiffDeg` 35→45; automatic retry on timeout (12s then 18s); console diagnostics log which gate rejects each candidate road
- **Styled 2D rendering** (`render.js` + `arrange.js`): buildings render with drop shadow, slate roof fill, inset parapet line, entry marker, haloed label; parking renders as dark asphalt field with white stall stripes (clipped per polygon, lateral reorder for left/right faces) + lighter aisle lines + stall-count label; driveways render as paved asphalt with dashed yellow centerline; basin renders as teal water body with inset waterline rings. `arrange.js` now exposes stall grid on `clipped.properties` (ring, rows, stallsPerRow, stallDepthFt, aisleFt) for the renderer.
- **Driveway fixes** (`optimize.js` + `ai.js` + `main.js`): (1) `buildCandidateSchema` previously only added driveway elements when `face === 'front'` — left/right/rear parking had no driveway, costing −0.80 in score. Fixed: left face → `entryU:'left'`, right face → `entryU:'right'`, rear/front → full `driveways` knob. (2) `parseInstructions` now recognises `drivewaySide` (`'left'|'center'|'right'`) so user hints like "put driveway on west side" map correctly; `buildTestSchema` uses it to override the default `entryU`.
- **Parking distribution Phase 1** (`score.js`): `parkingMet` sums `stall_count` across ALL `parking_areas` (was `[0]` only); `parkingInFront` uses stall-weighted mean depth across all lots (was first lot only). Fixes silent under-scoring of `front+rear` and multi-lot layouts.
- **Parking distribution Phase 2** (`optimize.js` `buildCandidateSchema`): added `splitStallsByGFA` helper — allocates total stalls across buildings proportional to GFA via largest-remainder integer rounding. Each face now emits one parking element per building anchored to that building, sized to its share. `bSetbackFt` derives from max per-building front-parking depth (not total stalls over building A's face). Driveways remain tied to `reqs.driveways`, anchored to the first funded lot per face. Multi-building strip now produces a continuous frontage band of lots instead of one oversized lot clipped against free space.
- **Building row remove button** (`index.html`, `main.js`, `styles.css`): each building row in the sidebar has a `×` button; clicking it removes the row (guarded to keep at least one). Fixed `width: auto` override on the global `button { width: 100% }` rule to prevent layout breakage.
- **Program-fit check + honest status** (`js/feasibility.js`, `optimize.js`, `main.js`): `splitStallsByGFA` is now exported from `optimize.js`. New `js/feasibility.js` exports `checkProgramFits(reqs, parcelFt, parcelAreaSqFt, frontage, profile)` — pure, deterministic advisory check returning `{ fits, blockers, warnings, metrics }`. Wired into both `onSolve` and `onOptimize`: if blockers exist, the solve is blocked and the warnings panel shows actionable ⛔ messages with concrete numbers; solve never runs. On the success path, feasibility warnings (⚠) and degraded-winner notes are appended after `renderLayout` — reports unplaced buildings, parking shortfall, and stranded parking (no driveway when road exists). Status line gains ` · ⚠ partial layout` suffix when degraded.

---

## File structure

```
index.html            UI shell — sidebar controls + stats/score/optimizer panels
styles.css            Dark sidebar + map + canvas panel + score/optimizer/reg CSS
config.js             API keys — GITIGNORED
js/
  main.js             App state + UI event wiring → solver → renderer → scorer
  map.js              Google Maps init, click-to-draw polygon
  projection.js       computeCentroid, computeScaleFactors, latLngToFeet,
                      feetToLatLngFromCentroid, latLngToFeetFromCentroid, polygonAreaSqFt
  geometry.js         toPoly, rectPoly, polysOf, biggestPoly, reach, gridPointsInside
  solver.js           solveLayout() — legacy deterministic engine (USE_ARRANGER=false path)
                      export: placeBuilding, growCornerClip
  arrange.js          realizeArrangement(schema, parcelLngLat, profile) — live solver
                      export: buildLocalFrame, feetToLocal, frontageV, buildingLocalBounds
  render.js           async renderLayoutOnCanvas(canvas, parcelLatLng, layout, centroid)
  export.js           exportToPng()
  ai.js               parseInstructions(text) → hints; proposeArrangements(...) → knob-sets
  score.js            score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile, road)
                      PROFILES.retail — weights + placement defaults + searchConfig + regConfig
  optimize.js         optimizeArrangement(...) — schema optimizer (LIVE)
                      optimizeLayout(...) — legacy 4-basin-corner search (behind flag)
                      buildCandidateSchema, generateCandidates, refineArrangement,
                      scoreAiSeeds, knobSig
  optimizer-worker.js Web Worker: runs optimizeArrangement off main thread
  road.js             detectRoad(parcelLatLng, centroid) → roadResult | null
  regulatory.js       checkGates(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile)
                      → { pass, violations }
markdow/              Spec files and this summary
```

---

## App state (`main.js` module scope)

```javascript
parcelLatLng  // [{lat, lng}]   raw map vertices
parcelFt      // [{x, y}]       projected to feet from centroid
centroid      // {lat, lng}     parcel centroid, reference for all conversions
lastLayout    // last solver/optimizer/arranger output
aiHints       // accumulated hints from AI
detectedRoad  // roadResult from road.js, or null

const USE_ARRANGER         = true;   // Solve routes through realizeArrangement
const USE_SCHEMA_OPTIMIZER = true;   // Optimize routes through optimizeArrangement
```

---

## Solver API

### Inputs
```javascript
reqs = {
  buildings:      [{ label, length_ft, width_ft }],
  parking_stalls: 50,
  pondPct:        15,
  driveways:      1,
}
hints = {
  setbackFt:             20,
  clearanceFt:           30,
  basinCorner:           'SW',          // SW|SE|NW|NE
  orientationPreference: 'auto',        // NS|EW|auto
  frontage:              'S',           // N|S|E|W|auto
}
```

### Layout output (the contract — used by render.js, score.js, and the arranger adapter)
```javascript
{
  buildings:      [{ label, length_ft, width_ft, center_x_ft, center_y_ft, orientation_deg }],
  parking_areas:  [Turf Feature<Polygon> with .properties { center_x_ft, center_y_ft, orientation_deg, stall_count }],
  driveways:      [Turf Feature<Polygon> with .properties { lengthFt, widthFt, entryU }],
  detention_pond: Turf Feature<Polygon> | null,
  warnings:       string[],
  rationale:      string,
}
```

---

## score.js

### API
```javascript
score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile, road = null)
// road = detectedRoad | null (neutral scoring when null)
// returns { total, maxScore, terms }
// terms: { termName: { raw, weight, contribution } }
```

### PROFILES.retail — scoring weights (maxScore = 5.25)
```javascript
buildingsPlaced:   1.0    // fraction of requested buildings placed
parkingMet:        0.9    // gotStalls / reqStalls, capped at 1
parkingInFront:    0.7    // parking depth < building depth
roadVisibility:    0.6    // mean building setback in plateau(60, 200, 250)
coverageTarget:    0.5    // footprint/parcel in plateau(0.20, 0.25, 0.20)
drivewayConnected: 0.4    // fraction of driveways intersecting 30ft road buffer
drivewayPresent:   0.4    // 1 if any driveway placed
drivewayLength:    0.3    // plateau(realizedLen/meanBldgDepth, lo=0.6, hi=1.0, falloff=0.5)
basinAccuracy:     0.3    // 1 - |gotBasin - target| / target
compactness:       0.15   // 1 - buildingSpread/parcelDiagonal (multi-building only)
openSpace:         0.0    // placeholder
```

### PROFILES.retail — placement defaults
```javascript
setbackFt: 20, clearanceFt: 30, maxBuildingDepthFt: 70, minBuildingAreaSqFt: 400,
stallDepthFt: 18, aisleFt: 24, drivewayWidthFt: 24, defaultDriveLengthFt: null,
drivewayConnectThreshFt: 30, drivewayLengthLo: 0.6, drivewayLengthHi: 1.0,
drivewayLengthFalloff: 0.5, gapFt: 10,
```

### PROFILES.retail — searchConfig (optimizer knob space)
```javascript
searchConfig: {
  layout:        ['strip', 'stacked', 'L', 'U'],   // U gated to N≥3 in generator
  gapFt:         [0, 20],
  parkingFaces:  ['front', 'rear', 'left', 'right', 'front+rear', 'front+left', 'front+right'],
  driveways:     [['left'], ['center'], ['right'], ['left', 'right']],
  // filtered to sets whose .length === reqs.driveways before search
  basinCorner:   ['rearLeft', 'rearRight', 'frontLeft', 'frontRight'],
  setbackFt:     [15, 25, 35],
  alignU:        ['left', 'center', 'right'],
  maxCandidates: 8000, topK: 4, displayK: 10,
  refineConfig: {
    setbackStep: 2, setbackRange: 9,
    alignOffsetsFt: [-60, -30, 0, 30, 60],
    driveLengthOffsetsFt: [-40, -20, 0, 20, 40],
  },
}
```

### PROFILES.retail — regConfig (regulatory gates)
```javascript
regConfig: {
  useType:      'retail',
  jurisdiction: 'UNVERIFIED — representative defaults, not an adopted code',
  rules: {
    parkingRatioGFA:  { enabled: true, severity: 'hard', per1000: 4.0 },
    lotCoverage:      { enabled: true, severity: 'hard', max: 0.80 },
    buildingCoverage: { enabled: true, severity: 'hard', max: 0.40 },
    setbacks:         { enabled: true, severity: 'hard', frontFt: 25, sideFt: 10, rearFt: 15 },
    aisleWidth:       { enabled: true, severity: 'hard', minFt: 24 },
    fireLane:         { enabled: true, severity: 'hard', minFt: 20 },
    detention:        { enabled: true, severity: 'hard', areaPerImpervFt: 0.10, approximate: true },
  },
}
```

---

## arrange.js — Relational placement engine

### Entry point
```javascript
const { elements, freeRemaining } = realizeArrangement(schema, parcelLngLat, profile);
// elements: [{id, type, feasible, reason?, ...geomFields}]
```

### Schema format
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

### Local frame
```
n̂ = unit vector inward (into lot), t̂ = unit vector along frontage edge
v = depth into lot (0 at frontage), u = lateral offset (0 at parcel centroid)

S: n̂={x:0,y:1}   t̂={x:1,y:0}    N: n̂={x:0,y:-1}  t̂={x:1,y:0}
E: n̂={x:-1,y:0}  t̂={x:0,y:1}    W: n̂={x:1,y:0}   t̂={x:0,y:1}

frontageV(parcelFt, frame) = min(v for all parcel vertices)
frontageVAtU(parcelFt, frame, uCenter) = actual boundary v at u (diagonal-parcel safe)
```

### Semantic corner → cardinal
```
rearLeft:  S→NW  N→SE  E→SW  W→NE
rearRight: S→NE  N→SW  E→NW  W→SE
```

### Key behaviors
- Buildings: erode-and-fit (`placeBuilding`) — rectangular, never clipped
- Groups (multi-building): `scanGroupPlacement` (direct bbox containment, not circumradius erosion); `realizeGroupFallback` for oversized strips
- Parking: clip-to-free; clears anchor building's own clearance zone before clipping; second-clips to parcelTurf; stores `localBounds` (pre-clip) for driveway positioning
- Driveways: clip to parcelTurf (not free); `frontageVAtU` for diagonal-parcel safety; knob priority `size.lengthFt > profile.defaultDriveLengthFt > functional`
- Basin: `growCornerClip` binary-search to target area
- JSTS monkey-patch inside `realizeArrangement` try/finally: `turf.union/difference/intersect` return null instead of throwing on coincident edges

---

## optimize.js

### `optimizeArrangement` (LIVE path)
```javascript
optimizeArrangement(parcelLngLat, reqs, frontage, profile, onProgress, aiSeeds, road)
// Returns { ranked, totalTried, gatedOut }
// Phase 1: discrete cross-product (~72–288 candidates depending on reqs.driveways)
// Phase 2: fine setback grid ±9ft + numeric alignU offsets + driveway length offsets
//          around top topK=4 Phase 1 winners (~900 additional candidates)
// Gates: checkGates applied after layoutFromElements, before score() in all 3 loops
// gatedOut: count of candidates failing regulatory hard gates (never enters ranked)
```

### `scoreAiSeeds`
```javascript
scoreAiSeeds(seeds, parcelLngLat, reqs, frontage, profile, road)
// Returns { candidates, gatedOut }
// Called on main thread after worker finishes; merged into ranked list deduped by knobSig
```

### `buildCandidateSchema(reqs, frontage, knobs)`
Assembles one schema from a knob-value point. `bSetbackFt = setbackFt + parkDepthFt` (front parking depth from first building's face width). All `parkingFaces` split on `+`; each face gets its own parking element anchored to `firstBuildingId` (all stalls → building A). Every face also gets driveway elements: left face → `entryU:'left'`, right face → `entryU:'right'`, front/rear → full `driveways` knob. **Phase 2 of parking-distribution-spec will replace the single-anchor allocation with per-building proportional lots** — use Plan Mode.

### `knobSig(k)`
Stable dedup key: `layout|gapFt|parkingFaces|driveways(sorted)|basinCorner|setbackFt|alignU|dl`

### Feasibility gate
```javascript
function isCandidateViable(elements) {
  return elements.filter(e => e.type === 'building').some(e => e.feasible);
}
// Only building failures disqualify. Parking/driveway/basin failures reduce score.
```

### JSTS monkey-patch (in worker)
Worker spreads frozen Turf namespace into a mutable plain object (`globalThis.turf = { ...turfNS }`) so `optimizeArrangement` can reassign `turf.union/difference/intersect`.

---

## regulatory.js

### API
```javascript
checkGates(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile)
// Returns { pass: bool, violations: [{rule, detail, severity}] }
// pass: false if any hard violation exists
// No-op when profile.regConfig is absent
```

### Architecture
- `RULE_CHECKERS` registry: each entry is `(layout, ctx, params) => { detail } | null`
- `deriveContext` computes gfa, footprint, imperv, stalls, basin, frame, parcel u/v extents once
- Adding a new use type = new `regConfig.rules` block + register checker(s); `checkGates` loop unchanged
- `severity:'hard'` → disqualified (optimizer `continue`, never ranked); `severity:'soft'` → warning only

### Wiring
| Location | Behavior |
|---|---|
| `optimize.js` Phase 1/AI-seeds/Phase 2 loops | `if (!checkGates(...).pass) { gatedOut++; continue; }` after `layoutFromElements` |
| `main.js renderLayout` | Call `checkGates`; show violations in warnings panel with jurisdiction note; always render |
| Optimizer status line | `· N gated` suffix when `totalGated > 0` |

---

## ai.js

### `proposeArrangements(parcelSummary, reqs, frontage, profile)`
- 3 bias templates (visibility/parking/compact) fired concurrently via `Promise.allSettled`
- 4 s `AbortController` timeout per call; `temperature: 0.3`
- Returns validated `knobSet[]`; returns `[]` on any error
- **Main thread only** — workers have no `window.GEMINI_API_KEY`
- Runs concurrently with worker spawn to hide latency

### `parseInstructions(text)`
Returns `{ setbackFt?, clearanceFt?, basinCorner?, orientationPreference?, frontage?, drivewaySide? }` via Gemini.
`drivewaySide` is `'left'|'center'|'right'` — lateral position of driveway entrance along the frontage. Used by `buildTestSchema` to override the default `entryU`. The AI prompt explains cardinal→relative mapping (e.g. "west" on N/S frontage = `'left'`).

---

## road.js

### `detectRoad(parcelLatLng, centroid)` → `roadResult | null`
- Overpass query `way["highway"]` in parcel bbox + 300 ft margin; retries once (12s → 18s) on failure
- Distance gate: min vertex→road ≤ 500 ft (not centroid→road, so large parcels work)
- Parallelism gate: road bearing vs nearest parcel edge ≤ 45° (handles diagonal parcel edges)
- Console logs each road's pass/fail reason for diagnostics
- Dedup by cardinal (nearest per direction) → `candidates[]` sorted by distance
- `candidates[0]` = winner; `candidates.length > 1` = corner lot
- Never throws

```javascript
// Return shape
{ cardinal, line, nearestPt, distanceFt, bearingDiffDeg, source: 'overpass', candidates }
```

---

## Key technical invariants

- **Turf uses WGS84 `[lng, lat]`** throughout. Feet coords only for grid sampling and building corners.
- **Erosion guarantees containment**: erode free by `reach = hypot(length,width)/2`; any center inside fits.
- **Buildings erode-and-fit; parking/driveway/basin clip-to-free.**
- **Driveway clips to parcelTurf, not free** — spans the setback zone already eroded from free.
- **parking.localBounds stores pre-clip extents** so `realizeDriveway` positions against the full intended rectangle.
- **Groups use scanGroupPlacement** (direct containment) not `placeBuilding` (circumradius erosion).
- **bSetbackFt must include parking depth**: `setbackFt + parkRows × 30`.
- **Parking clearance must be restored** before clipping: `turf.union(free, clearRing)` in `realizeParking`.
- **Turf is a CDN global on main thread** (v6.5.0). Workers import from `esm.sh` and spread into a mutable plain object.
- **`realizeArrangement` never throws** — all failures return `{ feasible: false, reason }`.
- **`checkGates` never throws** — all checkers are wrapped; missing checker → soft violation.
- **Regulatory gates operate on realized layout**, not schema — checks are about actual quantities.
- **regConfig crosses the worker boundary for free** — lives in profile which is already postMessage'd.

---

## API keys
- `window.MAPS_API_KEY` — Google Maps JavaScript API + Static Maps API (separate enablement required for Static Maps)
- `window.GEMINI_API_KEY` — Gemini 2.5 Flash; main thread only

## How to run
Right-click `index.html` → Open with Live Server → `http://127.0.0.1:5500`

---

## Pending tasks

### Subsequent
- **Decision B (AI-proposer navigation)** — only once cap fires routinely; hand region-selection to AI proposer instead of brute-force enumeration; tune `topK`/refinement to spend budget on AI-suggested neighborhoods
- **Perimeter / field lots** — new parking archetype: distribute stalls along parcel edges rather than anchoring to a building face
- **Tune drivewayLength scoring knobs** — `lo=0.6, hi=1.0, falloff=0.5` are intuition-set; all are profile knobs
- **Deploy / key security** — backend proxy for Gemini key; HTTP-referrer restriction on Maps key
- **Remaining stall shortfall on diagonal parcels** — parking area legitimately clipped by parcel shape; optimizer penalizes via `parkingMet`
