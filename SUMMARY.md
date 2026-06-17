# AI Site Planner — Project Summary

## What this app does
A browser-based civil site-planning tool. The user draws a parcel boundary on a
satellite map, fills in a program (buildings, basin %, parking, driveways), and a
**deterministic geometry solver** places everything so it is guaranteed to fit inside
the boundary with no overlaps. Output renders to scale on a canvas backed by a
satellite imagery background and exports as PNG.

---

## Current status: all Phases + post-review fixes + Frontage task COMPLETE.

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

### Post-review fixes (FIXES.md — all done)
| Fix | What changed | Commit |
|-----|-------------|--------|
| P1 | Satellite background on canvas/PNG via Web Mercator projection | 9028b90 |
| P2 | Building clearance: `clearance/2` → `clearance` (was getting ~15 ft gap, now ~30 ft) | 442ddce |
| P3 | gridPointsInside samples all poly pieces; zoneCentroid spreads along long axis; basin undersized warning; determinism tie-break; removed duplicate computeScaleFactors | 11658a4 |

### Frontage task (FRONTAGE_TASK.md — all done)
| Step | What | Status | Commit |
|------|------|--------|--------|
| 1 | Generalize parking placement: `placeAlongFrontageEdge(free, sqFt, centroid, frontage)` | ✅ | 165e183 |
| 2 | Generalize driveways for all 4 directions | ✅ | 165e183 |
| 3 | Basin default corner derived from frontage (S→NE, N→SW, W→SE, E→NW) | ✅ | 165e183 |
| 4 | UI dropdown for Road Frontage in index.html + main.js read | ✅ | this session |
| 5a | ai.js: add `frontage` field to Gemini prompt + VALID_FRONTAGE allowlist | ✅ | 165e183 |
| 5b | main.js: wire `aiHints.frontage` into `onSolve` hints | ✅ | 96d9b13 |
| 5c | main.js `onApplyAI`: reflect parsed frontage back into `#input-frontage` element | ✅ | this session |
| — | Fix: E/W driveway bbox-anchor bug on slanted parcels | ✅ | 781f786 |
| — | Fix: E/W parking multi-lat edge sampling (`sampleEdgeLng`) | ✅ | 35eafbe |
| — | Fix: S/N parking stall loss on slanted/tilted parcels (`sampleEdgeLat` + scan) | ✅ | this session |

---

## File structure (current state)

```
index.html          UI shell — loads Maps API, has sidebar controls
                    Has Road frontage <select id="input-frontage"> after basin-corner
styles.css          Dark sidebar + map + canvas panel layout
config.js           API keys — GITIGNORED, never commit
config.example.js   Safe shape reference
js/
  main.js           App state + wires UI events → solver → renderer
                    onSolve reads hints.frontage from #input-frontage dropdown
                    onApplyAI reflects AI-parsed frontage back into #input-frontage
  map.js            Google Maps init, click-to-draw polygon sketching
  projection.js     computeCentroid, computeScaleFactors, latLngToFeetFromCentroid,
                    feetToLatLngFromCentroid, latLngToFeet, polygonAreaSqFt
  geometry.js       toPoly, rectPoly, polysOf, biggestPoly, reach, gridPointsInside
                    gridPointsInside now samples ALL polysOf(geom), not just biggestPoly
  solver.js         solveLayout(parcelLatLng, reqs, hints) — the geometry engine
                    resolveFrontage, placeAlongFrontageEdge, makeDriveways (all 4 dirs),
                    sampleEdgeLng (multi-lat edge sampling for E/W parking boundary),
                    sampleEdgeLat (multi-lng edge sampling for S/N parking boundary)
  render.js         async renderLayoutOnCanvas(canvas, parcelLatLng, layout, centroid)
                    Web Mercator projection, satellite background, Mercator scale bar
  export.js         exportToPng() — downloads canvas as PNG
  ai.js             parseInstructions(text) → hints via Gemini 2.5 Flash
                    Parses: setbackFt, clearanceFt, basinCorner, orientationPreference, frontage
```

---

## App state (lives in main.js module scope)
```javascript
parcelLatLng  // [{lat, lng}]   raw map vertices
parcelFt      // [{x, y}]       projected to feet from centroid (still used as a "has parcel" sentinel)
centroid      // {lat, lng}     parcel centroid, reference for all conversions
lastLayout    // solver output, used by renderer and export
aiHints       // accumulated hints from AI (merged on each Apply AI Hints click)
              // keys: setbackFt, clearanceFt, basinCorner, orientationPreference, frontage
              // NOTE: aiHints.frontage is no longer read directly in onSolve —
              // onApplyAI writes it into the #input-frontage dropdown instead.
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

### Outputs
```javascript
{
  buildings:      [{ label, length_ft, width_ft, center_x_ft, center_y_ft, orientation_deg }],
  parking_areas:  [Turf Feature<Polygon> with .properties { center_x_ft, center_y_ft, orientation_deg, stall_count }],
  driveways:      [Turf Feature<Polygon>],   // may be Polygon or MultiPolygon
  detention_pond: Turf Feature<Polygon> | null,
  warnings:       ['Basin undersized: ...', 'Building X does not fit.', ...],
  rationale:      string,
}
```

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

## Parking placement — full algorithm (`placeAlongFrontageEdge`)

All four directions place a 60 ft deep parking block against the frontage edge of
`biggestPoly(free)`. The hard problem is placing an **axis-aligned rectangle** against
a parcel boundary that may be **slanted or tilted** — the rectangle will be clipped
by the boundary, losing stalls. The solution in each direction is to find the
most-constrained boundary position first, then size and anchor the rectangle to fit
without clipping.

### S and N frontage (added this session — replaces broken bbox approach)

**Root cause of the bug:** The original code computed the parking width from
`parkingSqFt / depthFt` and centered it at `(minLng + maxLng) / 2` of the free-space
bbox. Then it intersected the rectangle with `biggestPoly(free)`. Two failure modes:

1. **Basin cuts into the south band**: The basin might be in the SE corner and extend
   into the 60 ft south band. The bbox center is still in the middle of the parcel,
   so the right half of the parking rectangle falls inside the basin area and gets
   clipped on intersection → fewer stalls.

2. **Tilted/rotated parcel**: For a parcel rotated (e.g.) 30°, `minLat` is the
   **absolute bottom corner tip** — a single point with zero horizontal width. Any
   approach that samples the free space near `minLat` (including the intermediate
   attempts using "mid-depth" at `minLat + 30ft`) still falls within the needle-thin
   sliver near the corner. This caused parking to collapse to near-zero width (9 stalls
   instead of 50 on a 61-acre parcel).

**The fix (two-phase):**

**Phase 1 — find where the frontage actually is:**
Scan in 30 steps across the south half of the free space's lat range (north half for N
frontage), sampling a thin horizontal band at each step. Stop at the **first (southernmost)
lat where the cross-section is wide enough** to fit the needed parking width. This
correctly skips the zero-width corner tip of a tilted parcel and finds the actual
viable frontage latitude. If no single lat has enough width (very narrow parcel), fall
back to the **widest lat seen** so stalls are maximized.

```javascript
// S frontage — scans from minLat upward through 50% of parcel height
for (let i = 0; i <= 30; i++) {
  const lat = minLat + (i / 30) * (maxLat - minLat) * 0.5;
  // ... intersect thin band with biggest, measure width ...
  if (w > bestWidth) { record widest (fallback) }
  if (w >= neededWidthDeg) { record this lat and break }  // southernmost viable
}
```

**Phase 2 — pin to the actual slanted boundary:**
Given the centerLng and halfW determined in Phase 1, call `sampleEdgeLat` to find
the actual south (or north) boundary lat at each longitude within the parking width.
For a slanted boundary, the south edge is at a **different latitude at each longitude**.
Taking the **maximum** (northernmost) south boundary lat across all samples ensures the
parking rectangle's bottom edge sits at or above the boundary everywhere — no clipping.

```javascript
const anchorLat = sampleEdgeLat(biggest, 'S', centerLng, halfW, minLat, maxLat, s);
parkingPoly = [centerLng - halfW, anchorLat, centerLng + halfW, anchorLat + depthDeg];
```

On a slanted parcel, `anchorLat` will be the south boundary at the east end of the
parking (the highest point). The west side has a gap between the parking's south edge
and the parcel boundary; the driveway fills this gap.

For N frontage the logic is symmetric: scan downward from `maxLat`, find northernmost
viable lat, anchor the parking's **north** edge using `sampleEdgeLat('N')` which returns
the **southernmost** north boundary across the parking width.

### E and W frontage (unchanged, already working)

Depth is 60 ft in the lng direction; height (`parkingSqFt / 60` ft) runs in the lat
direction, centered at `(minLat + maxLat) / 2`. `sampleEdgeLng` samples the E or W
boundary at 7 latitudes across the parking height and takes the **most constrained** point:
- W frontage: `max` of all west boundary lngs (rightmost = most inward point)
- E frontage: `min` of all east boundary lngs (leftmost = most inward point)

The rectangle is anchored to that constrained point and extends inward by `depthDeg`.
This prevents clipping on slanted E/W boundaries.

### Summary of helper functions in solver.js

```
sampleEdgeLng(poly, side, centerLat, halfWidthDeg, minLng, maxLng, s)
  → finds most-constrained E or W boundary lng across the parking HEIGHT
  → used by E/W frontage cases

sampleEdgeLat(poly, side, centerLng, halfWidthDeg, minLat, maxLat, s)
  → finds most-constrained S or N boundary lat across the parking WIDTH
  → used by S/N frontage cases (added this session)
  → 'S': returns northernmost (highest) south edge lat
  → 'N': returns southernmost (lowest) north edge lat
```

Both functions use `biggestPoly(slice)` at each sample point so they correctly ignore
the smaller piece when a basin or difference operation has split the free space.

---

## Driveways (`makeDriveways`)

24 ft wide access strip from parcel boundary to parking south/north/east/west edge.

**S/N frontage**: simple horizontal bbox strip between `parMinLat`/`parMaxLat` and
`pMinLat`/`pMaxLat` (parking south/north edge), intersected with the parcel to clip
to actual boundary. Strips distributed evenly across the parking width at
`(i+1)/(count+1)` spacing.

**E/W frontage**: for each driveway strip, the lat strip is intersected with both the
parcel AND the parking at that specific lat. The parking cross-section's `pkBbox[2/0]`
(east/west extent at that lat, not the parking bbox) is used as the inner boundary.
Then the parcel cross-section is clipped to the road-facing half. This correctly
follows slanted parcel boundaries — the old bbox-anchor approach produced driveways
that extended outside the parcel on slanted E/W parcels.

---

## Road Frontage UI (added this session)

### index.html change
A new `<select id="input-frontage">` was added to the sidebar immediately after the
basin-corner select:
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

### main.js changes

**`onSolve`**: `hints.frontage` now reads directly from the dropdown:
```javascript
frontage: document.getElementById('input-frontage').value,
```
The previous `aiHints.frontage ?? 'auto'` line was removed. The dropdown is the
single source of truth; AI updates the dropdown rather than a hidden variable.

**`onApplyAI`**: When Gemini parses a frontage hint, it is reflected into the dropdown
(mirrors the existing `basinCorner` reflection):
```javascript
if (hints.frontage !== undefined) {
  document.getElementById('input-frontage').value = hints.frontage;
}
```
This means typing "driveway on the north side" → Gemini returns `{frontage:'N'}` →
dropdown switches to North → solver re-runs with North frontage.

---

## Render pipeline (render.js — fully rewritten P1)

`renderLayoutOnCanvas` is **async**. Called as:
```javascript
await renderLayoutOnCanvas(canvas, parcelLatLng, layout, centroid)
```
(Note: takes `parcelLatLng`, NOT `parcelFt` — signature changed from the original.)

### Mercator projection
```javascript
function lngLatToWorldPx(lng, lat, zoom) {
  const size = 256 * Math.pow(2, zoom);
  const x = (lng + 180) / 360 * size;
  const s = Math.sin(lat * Math.PI / 180);
  const y = (0.5 - Math.log((1+s)/(1-s)) / (4*Math.PI)) * size;
  return { x, y };
}
```
Zoom is auto-selected: largest integer zoom at which the parcel fits in the canvas
minus PAD=40px. `mercScale = canvas.width / 640` maps world-px to canvas-px.

### Satellite tile
```
GET https://maps.googleapis.com/maps/api/staticmap
  ?center={lat},{lng}&zoom={zoom}&size=640x{h}&scale=2&maptype=satellite&key=...
```
- `img.crossOrigin = 'anonymous'` must be set BEFORE `img.src` or `canvas.toDataURL()`
  taints the canvas and PNG export silently fails.
- Falls back to dark `#1a1a2e` fill if image fails to load.

### Scale bar
Derived from Mercator geometry:
```javascript
metersPerWorldPx = cos(lat * π/180) * 2π * 6378137 / (256 * 2**zoom)
pixelsPerFoot = mercScale / (metersPerWorldPx * 3.28084)
```

---

## Key technical decisions

### Turf.js uses WGS84, not feet
All Turf polygons use real `[lng, lat]` WGS84. Feet coords are only used for
grid sampling, distance outputs, and building rectangle corners (converted via
`feetToLatLngFromCentroid` before passing to Turf). Never mix up the two.

### Erosion guarantees containment
Buildings placed by eroding `free` inward by the building's reach (half-diagonal).
Any center inside the eroded region → full rectangle fits. No place-then-check step.

### Determinism
Buildings sorted largest-first. Candidates sorted by:
`dist2(a, target) - dist2(b, target) || a.y - b.y || a.x - b.x`
The y/x tie-break is explicit (not incidental). Solver is run twice on every solve
and a warning fires if outputs differ.

### computeScaleFactors lives in projection.js only
`solver.js` and `geometry.js` both import from `projection.js`. The duplicate
`computeScaleApprox` that used to live in `solver.js` was deleted in P3.

### gridPointsInside samples all polygon pieces
After `turf.difference` operations, `free` can split into two disjoint regions.
`gridPointsInside` iterates `polysOf(geom)` so building candidates from both
pieces are considered — previously it only searched `biggestPoly` and buildings
could be falsely reported as not fitting.

### Parking placement uses scan + sampleEdgeLat, not bbox
The old approach of centering parking at the bbox midpoint fails for tilted parcels
(corner tip has zero width) and for basin-clipped south bands (bbox extends into the
basin). The current approach scans the south/north half of the free space in 30 steps
to find where there is actually room, then pins the rectangle to the slanted boundary
via `sampleEdgeLat`. This is symmetric with how E/W uses `sampleEdgeLng`. The
rectangle is constructed to fit without clipping, so `turf.intersect` returns
essentially the full parking area and the stall count matches the target.

---

## Pending work

### Optional: basin corner 'auto' option
Currently the basin-corner dropdown always sends an explicit value (SW/SE/NW/NE),
so the frontage-derived basin default (Step 3, `S→NE, N→SW, W→SE, E→NW`) never fires
from the UI — it only fires in AI-only or programmatic flows where `basinCorner` is
absent from hints. Consider adding `<option value="auto">Auto (opposite road)</option>`
and in `onSolve` only passing `basinCorner` to hints when the dropdown value is not 'auto'.

---

## API keys
- `window.MAPS_API_KEY` — Google Maps + Static Maps key (in config.js, gitignored)
- `window.GEMINI_API_KEY` — Gemini 2.5 Flash key (in config.js, gitignored)
- Both loaded from `config.js` at runtime. `config.example.js` is safe to commit.

## How to run locally
Right-click `index.html` in VS Code → Open with Live Server → `http://127.0.0.1:5500`

## Git log (recent)
```
[this session] Fix S/N parking stall loss on slanted/tilted parcels (scan+sampleEdgeLat)
[this session] Add Road Frontage UI dropdown (Step 4) + reflect AI frontage (Step 5c)
35eafbe Fix E/W parking stall loss on slanted boundaries via multi-lat edge sampling
30b322f Fix E/W parking placement on slanted parcels
781f786 Fix E/W driveway: use parking cross-section as inner boundary, not bbox
67495be Fix E/W driveway geometry on slanted parcel boundaries
96d9b13 Wire aiHints.frontage through to solver in onSolve
165e183 Add road frontage parameter (steps 1-3 + AI parsing)
11658a4 P3: cleanups — multi-region sampling, long-axis spread, basin warn, tie-break
442ddce P2: fix building-to-building clearance (was clearance/2, now full clearance)
9028b90 P1: satellite background on canvas/PNG via Mercator projection
69cdd48 Phase 7: AI hints layer via Gemini (parseInstructions → hints → re-solve)
```
