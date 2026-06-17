# AI Site Planner — Project Summary

## What this app does
A browser-based civil site-planning tool. The user draws a parcel boundary on a
satellite map, fills in a program (buildings, basin %, parking, driveways), and a
**deterministic geometry solver** places everything so it is guaranteed to fit inside
the boundary with no overlaps. Output renders to scale on a canvas backed by a
satellite imagery background and exports as PNG.

---

## Current status: all Phases + post-review fixes complete. Frontage UI (Step 4) pending.

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

### Frontage task (FRONTAGE_TASK.md)
| Step | What | Status | Commit |
|------|------|--------|--------|
| 1 | Generalize parking placement: `placeAlongFrontageEdge(free, sqFt, centroid, frontage)` | ✅ | 165e183 |
| 2 | Generalize driveways for all 4 directions | ✅ | 165e183 |
| 3 | Basin default corner derived from frontage (S→NE, N→SW, W→SE, E→NW) | ✅ | 165e183 |
| 4 | **UI dropdown for Road Frontage in index.html + main.js read** | ❌ NOT DONE | — |
| 5a | ai.js: add `frontage` field to Gemini prompt + VALID_FRONTAGE allowlist | ✅ | 165e183 |
| 5b | main.js: wire `aiHints.frontage` into `onSolve` hints | ✅ | 96d9b13 |
| 5c | main.js `onApplyAI`: reflect parsed frontage back into `#input-frontage` element | ❌ NOT DONE (needs Step 4 UI element first) | — |
| — | Fix: E/W driveway bbox-anchor bug on slanted parcels | ✅ | 781f786 |
| — | Fix: E/W parking multi-lat edge sampling (`sampleEdgeLng`) | ✅ | 35eafbe |

---

## File structure (current state)

```
index.html          UI shell — loads Maps API, has sidebar controls
                    MISSING: Road frontage <select> (Step 4 of FRONTAGE_TASK.md)
styles.css          Dark sidebar + map + canvas panel layout
config.js           API keys — GITIGNORED, never commit
config.example.js   Safe shape reference
js/
  main.js           App state + wires UI events → solver → renderer
                    aiHints accumulates AI-parsed fields; onSolve reads them all into hints
                    MISSING: read #input-frontage into hints.frontage (Step 4)
                    MISSING: onApplyAI reflect hints.frontage → #input-frontage (Step 5c)
  map.js            Google Maps init, click-to-draw polygon sketching
  projection.js     computeCentroid, computeScaleFactors, latLngToFeetFromCentroid,
                    feetToLatLngFromCentroid, latLngToFeet, polygonAreaSqFt
  geometry.js       toPoly, rectPoly, polysOf, biggestPoly, reach, gridPointsInside
                    gridPointsInside now samples ALL polysOf(geom), not just biggestPoly
  solver.js         solveLayout(parcelLatLng, reqs, hints) — the geometry engine
                    resolveFrontage, placeAlongFrontageEdge, makeDriveways (all 4 dirs),
                    sampleEdgeLng (multi-lat edge sampling for E/W parking)
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
**IMPORTANT**: the UI basin-corner `<select>` always sends an explicit value, so this
default only fires when `basinCorner` is absent from hints — i.e. for AI-only flows
or programmatic calls. Step 4 should either add 'auto' to basin corner select, or
not send basinCorner when frontage is explicitly set.

**Parking** (`placeAlongFrontageEdge`): 60 ft deep, `parkingSqFt/60` ft wide.
- S/N: depth in lat, width in lng, orientation=0
- E/W: depth in lng, width in lat, orientation=90
- E/W uses `sampleEdgeLng()`: samples the free-space boundary at 7 latitudes across
  the full parking height and anchors to the most-constrained point. This prevents the
  parking rectangle from extending past a slanted boundary and losing stalls.

**Driveways** (`makeDriveways`): 24 ft wide access strip from parcel boundary to parking.
- S/N: bbox strip approach (works for horizontal edges)
- E/W: slices the parcel and parking at the driveway's lat strip, reads `pkBbox[2/0]`
  (parking east/west at that specific lat) as the inner boundary, then clips the parcel
  cross-section to the road-facing half. This correctly follows slanted boundaries.

**Current limitation on very slanted E/W parcels**: parking is pushed inward so it
doesn't get clipped, so it won't touch the parcel's extreme corner. The driveway fills
the gap between parking and parcel edge. Stall count should be close to the target.

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

---

## Pending work (in priority order)

### 1. Step 4: Road frontage UI (index.html + main.js)
Add to `index.html` sidebar, after the basin-corner label:
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
In `main.js` `onSolve`, add to hints:
```javascript
frontage: document.getElementById('input-frontage').value,
```
(Remove the current `aiHints.frontage ?? 'auto'` line — the dropdown becomes the
source of truth; AI still populates it via `onApplyAI`.)

### 2. Step 5c: Reflect AI-parsed frontage into the dropdown
In `main.js` `onApplyAI`:
```javascript
if (hints.frontage !== undefined) {
  document.getElementById('input-frontage').value = hints.frontage;
}
```
(Mirrors how `basinCorner` is reflected into `#input-basin-corner`.)

### 3. Optional: basin corner 'auto' option
Currently the basin-corner dropdown always sends an explicit value (SW/SE/NW/NE),
so the frontage-derived basin default (Step 3) never fires from the UI. Consider
adding `<option value="auto">Auto (opposite road)</option>` and in `onSolve` only
pass `basinCorner` to hints when the value is not 'auto'.

---

## API keys
- `window.MAPS_API_KEY` — Google Maps + Static Maps key (in config.js, gitignored)
- `window.GEMINI_API_KEY` — Gemini 2.5 Flash key (in config.js, gitignored)
- Both loaded from `config.js` at runtime. `config.example.js` is safe to commit.

## How to run locally
Right-click `index.html` in VS Code → Open with Live Server → `http://127.0.0.1:5500`

## Git log (recent)
```
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
