# AI Site Planner — Project Summary

## What this app does
A browser-based civil site-planning tool. The user draws a parcel boundary on a
satellite map, fills in a program (buildings, basin %, parking, driveways), and a
**deterministic geometry solver** places everything so it is guaranteed to fit inside
the boundary with no overlaps. Output renders to scale on a canvas backed by a
satellite imagery background and exports as PNG.

---

## Current status

All Phases 0–7 + post-review fixes + Frontage task + Scoring + Optimizer + Arrange Phase A COMPLETE.

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

### Scoring, Optimizer, Relational Placement (all done — commit 85b1a5e)
| What | File | Status |
|------|------|--------|
| Pure layout scorer, 9 weighted terms | js/score.js | ✅ |
| Score breakdown panel in sidebar | index.html + styles.css + main.js | ✅ |
| Brute-force optimizer over 4 basin corners | js/optimize.js | ✅ |
| "Optimize Layout" button + "Why This Won" ranked panel | index.html + styles.css + main.js | ✅ |
| Export `placeBuilding` from solver.js | js/solver.js | ✅ |
| arrange.js Phase A: local frame + schema parser + topo-sort + building→parcelFrontage | js/arrange.js | ✅ |
| USE_ARRANGER flag + adapters in main.js | js/main.js | ✅ |

---

## File structure (current state)

```
index.html          UI shell — sidebar controls + stats/score/optimizer panels
styles.css          Dark sidebar + map + canvas panel layout + score/optimizer CSS
config.js           API keys — GITIGNORED, never commit
config.example.js   Safe shape reference
SCORING.md          Spec for score.js (implemented)
OPTIMIZER_TASK.md   Spec for optimize.js (implemented)
relational-placement-spec.md  Spec for arrange.js (Phase A implemented; B-E pending)
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
  score.js          score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile)
                    PROFILES.retail — scoring weights + placement defaults
  optimize.js       optimizeLayout(...) — 4 basin corners, keep highest score
  arrange.js        realizeArrangement(schema, parcelLngLat, profile) — Phase A
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

const USE_ARRANGER = false;  // Phase A test flag — set true to route onSolve through
                              // realizeArrangement instead of solveLayout
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
The arranger adapter `layoutFromArrangement(elements)` in main.js converts
`realizeArrangement` output into this same shape so the display pipeline is unchanged.

---

## score.js — Pure layout scorer

### API
```javascript
import { score, PROFILES } from './score.js';

const result = score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, PROFILES.retail);
// result: { total, maxScore, terms }
// terms: { termName: { raw, weight, contribution } }
```

`parcelFt` = `[{x, y}]` in feet from centroid (from `latLngToFeet(parcelLatLng)`).
`parcelAreaSqFt` = shoelace area of parcelFt.
`frontage` must be a resolved 'N'|'S'|'E'|'W' — not 'auto'.

### PROFILES.retail
```javascript
// Scoring weights
buildingsPlaced: 1.0    // fraction of requested buildings placed
parkingMet:      0.9    // gotStalls / reqStalls, capped at 1
parkingInFront:  0.7    // parking center depth < building center depth → in front
roadVisibility:  0.6    // mean building setback in plateau(60, 200, 250) ft band
coverageTarget:  0.5    // building footprint / parcel area in plateau(0.20, 0.25, 0.20)
accessQuality:  -0.25   // PENALTY: driveway area / parcel area / 0.05
basinAccuracy:   0.3    // 1 - |gotBasinSqFt - targetSqFt| / targetSqFt
compactness:     0.15   // 1 - buildingSpread / parcelDiagonal (multi-building only)
openSpace:       0.0    // placeholder (irrelevant for retail)

// Placement defaults (used by arrange.js — read from profile, not hardcoded)
setbackFt:            20    // parcel setback before placement
clearanceFt:          30    // building-to-building clearance gap
maxBuildingDepthFt:   70    // max building depth from road (arrange.js size derivation)
minBuildingAreaSqFt: 400    // minimum viable building size (Phase E feasibility)
stallDepthFt:         18    // parking stall depth (Phase B)
aisleFt:              24    // parking aisle width (Phase B)
drivewayWidthFt:      24    // driveway strip width (Phase C)
gapFt:                10    // gap between elements (Phase D groups)
```

Max score for retail = sum of positive weights = 1.0+0.9+0.7+0.6+0.5+0.3+0.15 = **4.15**.
Score panel shows `total.toFixed(2) / maxScore.toFixed(2)`.

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
const scoreResult = score(layout, reqs, parcelFt, parcelSqFt, resolvedFrontage, PROFILES.retail);
// then populate #score-total and #score-breakdown
```

`renderLayout` 4th parameter `frontageHint` was added this session.
`onSolve` passes `hints.frontage`; `onOptimize` passes the resolved frontage.

---

## optimize.js — Brute-force optimizer

### API
```javascript
import { optimizeLayout } from './optimize.js';

const { best, all } = optimizeLayout(
  parcelLatLng, reqs, baseHints, profile, parcelFt, parcelAreaSqFt, frontage
);
// best: { params: {basinCorner}, layout, total, maxScore, breakdown, unplaced }
// all: array of all 4 candidates sorted by score descending
```

### Key constraint: frontage is FIXED
`frontage` is passed in already resolved and held constant across all 4 candidates.
It is NEVER a search dimension. The scorer's frontage-relative terms trust frontage
completely — if frontage were searched, the optimizer could pick the edge facing away
from the real road. This is the hard architectural rule.

### Search space
4 basin corners (SW, SE, NW, NE) × 1 orientation (NS only — orientation is currently
inert in the solver; adding EW would double the work for zero current benefit).
= **4 solves per optimize call**.

### `baseHints` (what the optimizer injects vs. what it searches)
```javascript
baseHints = {
  setbackFt:   ...,   // from UI
  clearanceFt: ...,   // from aiHints
  // NO basinCorner — searched
  // NO orientationPreference — inert, omitted
  // NO frontage — passed separately and held fixed
};
// Each candidate uses: { ...baseHints, basinCorner, frontage }
```

### Optimizer UI in main.js
- `onOptimize()`: reads frontage dropdown, builds baseHints + reqs, calls optimizeLayout,
  calls `renderLayout(best.layout, reqs, true, frontage)`, then `showOptimizerResult(best, all)`.
- `showOptimizerResult(best, all)`: populates `#optimizer-panel` with winner label +
  ranked candidate rows (green highlighted for rank #1, red for unplaced buildings).
- Regular `onSolve` hides the optimizer panel (stale results cleared).
- `onClear` hides and disables everything.

---

## arrange.js — Relational placement engine

### Spec file
`relational-placement-spec.md` — read this before implementing any phase.

### Current status: Phase A COMPLETE (tested 2026-06-18)

### Entry point
```javascript
import { realizeArrangement } from './arrange.js';

const { elements, freeRemaining } = realizeArrangement(schema, parcelLngLat, profile);
// elements: [{id, type, feasible, reason?, ...geomFields}]
// freeRemaining: Turf polygon of remaining free space after placement
```

### Schema format (what AI / optimizer will eventually emit)
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
  = the v-coordinate of the frontage edge (most inward = most negative or zero)
```

### Topological sort
Dependencies extracted from `place.anchor`, `place.to`, `place.connects` (excluding
parcel-level anchors: `parcelFrontage`, `parcelCorner`). DFS topo-sort; cycle → all
involved elements return `{feasible: false, reason: 'Dependency cycle'}`.

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

**For a 200×100 ft building in the existing UI:** areaSqFt=20000, maxDepthFt=100 →
depthFt=100, faceFt=200 → bSpec: length_ft=200, width_ft=100. Exact round-trip. ✓

**Target point derivation:**
```javascript
vFront  = frontageV(parcelFt, frame)          // v-coord of frontage edge
halfDepth = bSpec.width_ft / 2                // shorter side faces road at orient=0
targetV = vFront + setbackFt + halfDepth      // building center depth
targetU = 0                                    // alignU:'center' → at parcel centroid
targetPt = localToFeet(targetU, targetV, frame)
```

For `alignU: 'left'|'right'`: targetU = parcel u-extent min/max ± (setbackFt + length/2).

**Placement:**
```javascript
const placed = placeBuilding(free, bSpec, targetPt, [0, 90], centroid);
// placeBuilding is the exported function from solver.js
// erodes free by reach, grids legal space, snaps to closest candidate to targetPt
```

**Free space update (mirrors solveLayout step 5):**
```javascript
const foot = rectPoly(result.center_x_ft, result.center_y_ft,
                      result.length_ft, result.width_ft,
                      result.orientation_deg, centroid);
const buf = turf.buffer(foot, profile.clearanceFt ?? 30, { units: 'feet' });
if (buf) free = turf.difference(free, buf) ?? free;
```

### Element output shape (Phase A buildings)
```javascript
{
  id:              'b1',
  type:            'building',
  feasible:        true,
  label:           'b1',        // same as id in Phase A; groups will provide child labels
  length_ft:       200,
  width_ft:        100,
  center_x_ft:     ...,         // feet from parcel centroid
  center_y_ft:     ...,
  orientation_deg: 0,           // 0 = length along x (E-W); 90 = length along y (N-S)
}
// If infeasible:
{ id, type, feasible: false, reason: 'No valid position found at parcelFrontage anchor' }
```

Non-building types (parking, driveway, basin) return `{feasible: false, reason: '... not implemented (Phase A: building only)'}`.

### Adapter in main.js
```javascript
function layoutFromArrangement(elements) {
  return {
    buildings: elements
      .filter(e => e.type === 'building' && e.feasible)
      .map(e => ({ label: e.label ?? e.id, length_ft: e.length_ft, width_ft: e.width_ft,
                   center_x_ft: e.center_x_ft, center_y_ft: e.center_y_ft,
                   orientation_deg: e.orientation_deg ?? 0 })),
    parking_areas: [],
    driveways: [],
    detention_pond: null,
    warnings: elements.filter(e => !e.feasible)
                      .map(e => `[arrange] ${e.id}: ${e.reason ?? 'infeasible'}`),
    rationale: 'realizeArrangement (Phase A)',
  };
}
```

### Test schema builder in main.js
```javascript
function buildTestSchema(reqs, frontage, setbackFt) {
  return {
    frontage,
    elements: reqs.buildings.map(b => ({
      id:    b.label || 'b',
      type:  'building',
      size:  { areaSqFt: b.length_ft * b.width_ft, maxDepthFt: Math.min(b.length_ft, b.width_ft) },
      place: { anchor: 'parcelFrontage', setbackFt, alignU: 'center' },
    })),
  };
}
```

### USE_ARRANGER flag
`const USE_ARRANGER = false;` at top of main.js.
When `true`, `onSolve` builds the test schema and routes through `realizeArrangement`.
When `false` (default/live), existing `solveLayout → renderLayout` path runs unchanged.
The optimizer (`onOptimize`) always uses `solveLayout` directly, unaffected by flag.

---

## solver.js — placeBuilding export (added for arrange.js)

The building placement loop in `solveLayout` was refactored to call a new exported function:

```javascript
// Exported from solver.js — used by both solveLayout and arrange.js
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

`solveLayout` now calls `placeBuilding(free, b, zoneCentroid(...), orientations, centroid)`.
Behavior is IDENTICAL to before — pure refactor, no logic changes.

---

## Frontage parameter — how it works

`resolveFrontage(parcelLatLng, hints)` in solver.js is the single resolver:
- `hints.frontage` = 'N'|'S'|'E'|'W' → use that direction
- anything else (undefined, 'auto') → returns `'S'`

**Basin default corner** (Step 3): when `hints.basinCorner` is undefined, the solver
derives the default from frontage: `S→NE, N→SW, W→SE, E→NW` (opposite the road).
**IMPORTANT**: the UI basin-corner `<select>` always sends an explicit value (SW/SE/NW/NE),
so this default only fires when `basinCorner` is absent from hints — i.e. AI-only flows
or programmatic calls where basinCorner is omitted.

---

## Parking placement algorithm (`placeAlongFrontageEdge`)

All four directions place a 60 ft deep parking block against the frontage edge of
`biggestPoly(free)`. The challenge is placing an **axis-aligned rectangle** against
a boundary that may be **slanted** — the rectangle will be clipped, losing stalls.

### S and N frontage (two-phase scan + anchor)

**Root cause of original bug:** Centering parking at the bbox midpoint and anchoring
to `minLat`/`maxLat` fails for tilted parcels (`minLat` = the corner tip with zero
width → any sample near it gives near-zero parking width). Also fails when basin clips
the south band (bbox center extends into basin area).

**Phase 1 — find where the frontage actually is (30-step scan):**
Scan in 30 steps across the south 50% of the free space's lat range (or north 50% for
N frontage). At each step, intersect a thin band with `biggest`, measure cross-section
width. Stop at the **first (southernmost) lat where width ≥ needed parking width**.
Fall back to widest lat seen if no single lat is wide enough.

**Phase 2 — pin to slanted boundary (`sampleEdgeLat`):**
Given the centerLng and halfW, call `sampleEdgeLat(biggest, 'S', centerLng, halfW, ...)`.
This samples the south boundary at 7 longitudes across the parking width, returns the
**northernmost (highest) south boundary lat** — so the parking rectangle's south edge
sits at or above the actual boundary everywhere. No clipping.

```javascript
function sampleEdgeLat(poly, side, centerLng, halfWidthDeg, minLat, maxLat, s) {
  const SAMPLES = 7;
  const bandHalf = 10 / s.lngToFt;
  let result = side === 'S' ? -Infinity : Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const lng = centerLng - halfWidthDeg + (i / (SAMPLES-1)) * 2 * halfWidthDeg;
    const band = turf.bboxPolygon([lng - bandHalf, minLat - 1, lng + bandHalf, maxLat + 1]);
    const slice = turf.intersect(poly, band);
    if (!slice) continue;
    const bb = turf.bbox(biggestPoly(slice));
    if (side === 'S') result = Math.max(result, bb[1]);  // northernmost south edge
    else              result = Math.min(result, bb[3]);  // southernmost north edge
  }
  return isFinite(result) ? result : null;
}
```

For N frontage: scan downward from `maxLat`, anchor parking's **north** edge using
`sampleEdgeLat('N')` which returns southernmost north boundary → parking extends south.

### E and W frontage (unchanged)
60 ft depth in lng; centered at `(minLat + maxLat) / 2`. `sampleEdgeLng` samples
E/W boundary at 7 latitudes, returns most-constrained point. Rectangle anchored there.

---

## Driveways (`makeDriveways`)

24 ft wide strips from parcel boundary to parking edge.

**S/N**: horizontal bbox strip between parcel south/north and parking south/north edge,
intersected with parcel polygon, distributed evenly across parking width.

**E/W**: lat strip intersected with parcel AND parking. Parking cross-section `pkBbox[2/0]`
used as inner boundary (not bbox), so driveways correctly follow slanted parcel boundaries.

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

---

## Key technical invariants

- **Turf uses WGS84** `[lng, lat]`. Feet coords only for grid sampling and building corners.
- **Erosion guarantees containment**: erode free by `reach` = half-diagonal; any center
  inside the eroded region guarantees the full rectangle fits. No place-then-check.
- **Determinism**: buildings sorted largest-first; candidates sorted by dist2 then y then x.
  Solver runs twice per solve; warns if outputs differ. Arranger is deterministic by construction.
- **placeBuilding caller updates free**: the function returns the placed spec; the caller
  subtracts footprint + clearance from free. Both `solveLayout` and `arrange.js` do this.
- **USE_ARRANGER = false by default**: all live traffic uses the existing solver path.

---

## What's next: arrange.js Phase B

**Phase B: `parking → building front face`**

Schema element:
```json
{ "id": "p1", "type": "parking",
  "size": { "stalls": 60 },
  "place": { "anchor": "b1", "face": "front", "depthRowsFt": "auto" } }
```

Implementation notes from the spec:
- Resolve `anchor: "b1"` → look up realized element `b1` in `realized` map
- `face: "front"` → the element's low-v edge in local frame (closest to frontage)
- Get the building's u-extent in local frame; the parking rectangle spans that u-range
- `size.stalls` → derive depth: `depth = ceil(stalls / (faceFt / stallSpacingFt)) * stallRowDepthFt`
  where `stallRowDepthFt = profile.stallDepthFt + profile.aisleFt / 2` (one row + half aisle)
  and `stallSpacingFt = 9` (standard stall width)
- Candidate parking rect: `[uMin, vFace - depth, uMax, vFace]` in local, then unproject to lng/lat
- Clip to `free` (`turf.intersect(free, parkingRect)`) — parking tolerates clipping
- If clipped area < `minViable` → `{feasible: false}`
- Attach `.properties = { center_x_ft, center_y_ft, stall_count }` to the Turf feature
  (matching what `score.js` and `render.js` expect for `parking_areas[0].properties`)
- Subtract clipped parking + profile.gapFt buffer from free

**Key: buildings must use erode-and-fit (no clipping). Parking/driveway/basin use clip-to-free.**
This distinction is deliberate and is already stated in arrange.js comments.

---

## Phase roadmap (arrange.js)

| Phase | Scope | Status |
|-------|-------|--------|
| A | Local frame, schema parser, topo-sort, building → parcelFrontage | ✅ Done |
| B | parking → building face, stall-count sizing, clip-to-free | ⬜ Next |
| C | driveway connects frontage → parking, entryU | ⬜ |
| D | group/strip: children laid along t̂, gapFt, child faces as anchors | ⬜ |
| E | basin → parcelCorner, full feasibility flags, multi-element schemas | ⬜ |

---

## API keys
- `window.MAPS_API_KEY` — Google Maps + Static Maps (config.js, gitignored)
- `window.GEMINI_API_KEY` — Gemini 2.5 Flash (config.js, gitignored)

## How to run locally
Right-click `index.html` in VS Code → Open with Live Server → `http://127.0.0.1:5500`

## Git log (recent)
```
85b1a5e Add scoring, optimizer, and Phase A relational placement engine
189c475 Add frontage UI, fix S/N parking on slanted/tilted parcels
10e6584 Update SUMMARY.md with full session context
35eafbe Fix E/W parking stall loss on slanted boundaries via multi-lat edge sampling
30b322f Fix E/W parking placement on slanted parcels
781f786 Fix E/W driveway: use parking cross-section as inner boundary, not bbox
96d9b13 Wire aiHints.frontage through to solver in onSolve
165e183 Add road frontage parameter (steps 1-3 + AI parsing)
11658a4 P3: cleanups — multi-region sampling, long-axis spread, basin warn, tie-break
442ddce P2: fix building-to-building clearance (was clearance/2, now full clearance)
9028b90 P1: satellite background on canvas/PNG via Mercator projection
69cdd48 Phase 7: AI hints layer via Gemini (parseInstructions → hints → re-solve)
```
