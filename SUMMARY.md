# AI Site Planner — Project Summary

## What this app does
A browser-based civil site-planning tool. The user draws a parcel boundary on a
satellite map, fills in a program (buildings, basin %, parking, driveways), and a
**deterministic geometry solver** places everything so it is guaranteed to fit inside
the boundary with no overlaps. Output renders to scale on a canvas and exports as PNG.

---

## Status: Phases 0–6 complete, 7–8 remaining

### Done
| Phase | What was built | Status |
|-------|---------------|--------|
| 0 | Scaffold + Google Maps + polygon sketching | ✅ |
| 1 | Projection (lat/lng → feet) + acreage display | ✅ |
| 2 | Geometry helpers + setback overlay (blue inset) | ✅ |
| 3 | Detention basin solver (binary-search corner clip) | ✅ |
| 4 | Parking + driveways | ✅ |
| 5 | Building placement via erosion (guaranteed fit, deterministic) | ✅ |
| 6 | Canvas scale drawing + scale bar + PNG export | ✅ |

### Remaining
| Phase | What to build |
|-------|--------------|
| 7 | AI hints layer — `parseInstructions(text) → hints` using Gemini. User types plain English ("put basin NE, 25 ft setback") and it updates hints and re-solves. The AI never outputs coordinates, only the hints JSON. |
| 8 | Polish — stats panel (parcel/footprint/basin % stats), clear infeasibility messages, determinism self-check (solve twice, compare). |

---

## File structure
```
index.html          UI shell, loads Maps API from config.js key
styles.css          Dark sidebar + map + canvas panel layout
config.js           API keys (GITIGNORED — never commit)
config.example.js   Key shape reference (safe to commit)
js/
  main.js           App state + wires all UI events → solver → renderer
  map.js            Google Maps init, click-to-draw polygon sketching
  projection.js     lat/lng ↔ feet conversions, centroid, shoelace area
  geometry.js       Turf helpers: toPoly, rectPoly, polysOf, biggestPoly,
                    reach, gridPointsInside
  solver.js         solveLayout(parcelLatLng, reqs, hints) — the engine
  render.js         renderLayoutOnCanvas() + scale bar
  export.js         exportToPng() — downloads canvas as PNG
  ai.js             NOT YET BUILT (Phase 7)
```

---

## App state (lives in main.js)
```javascript
parcelLatLng  // [{lat, lng}] — raw map vertices
parcelFt      // [{x, y}]    — projected to feet from centroid
centroid      // {lat, lng}  — parcel centroid (reference for all conversions)
lastLayout    // solver output, used by renderer and export
```

---

## Solver inputs (reqs + hints)
```javascript
reqs = {
  buildings:      [{ label, length_ft, width_ft }],  // up to 5
  parking_stalls: 50,
  pondPct:        15,   // % of parcel area
  driveways:      1,
}
hints = {
  setbackFt:             20,
  clearanceFt:           30,
  basinCorner:           'SW',  // SW | SE | NW | NE
  orientationPreference: 'auto', // NS | EW | auto
}
```

## Solver output (layout)
```javascript
{
  buildings:      [{ label, length_ft, width_ft, center_x_ft, center_y_ft, orientation_deg }],
  parking_areas:  [Turf Feature with .properties.stall_count],
  driveways:      [Turf Features],
  detention_pond: Turf Feature,
  warnings:       [],
  rationale:      "All elements placed successfully.",
}
```

---

## Key technical decisions

### Turf.js uses WGS84, not feet
The plan says "work in feet" but Turf's `buffer` and `area` use geographic coordinates
internally. All Turf polygons in this codebase use real `[lng, lat]` WGS84 coordinates.
Feet coordinates are used ONLY for grid sampling, distance output, and rectangle corners
(which get converted to WGS84 via `feetToLatLngFromCentroid` before being passed to Turf).

### Erosion guarantees containment
Buildings can't leak outside the boundary because we erode `free` inward by the building's
reach (half-diagonal) before picking a center. Any center inside the eroded region guarantees
the full building fits. No place-then-check step.

### Determinism
Buildings sorted largest-first. Grid candidates sorted by distance to zone centroid, then
by lowest-y, then lowest-x as a tie-break. Same inputs always produce the same layout.

### Canvas sizing bug (fixed)
`canvas.height = someValue - 44 || 650` is wrong if `someValue` is 0 (hidden panel) —
negative numbers are truthy so the fallback never fires and you get an invalid height.
Fixed by using `requestAnimationFrame` to read dimensions after the panel is shown:
```javascript
panel.style.display = 'flex';
requestAnimationFrame(() => {
  canvas.width  = canvas.offsetWidth  || 900;
  canvas.height = canvas.offsetHeight || 650;
  renderLayoutOnCanvas(...);
});
```

---

## API keys
- `window.MAPS_API_KEY` — personal Google Maps key (restricted to `http://127.0.0.1:5500/*`)
- `window.GEMINI_API_KEY` — boss's Gemini key (in config.js, gitignored)
- Both loaded from `config.js` at runtime, never hardcoded

## How to run locally
Right-click `index.html` in VS Code → Open with Live Server → `http://127.0.0.1:5500`

## Git branches
Single `main` branch. One commit per phase. Clean rollback to any phase via `git checkout`.
