# AI Site Planner — Build Plan (from scratch)

A from-zero implementation plan for a browser-based civil site-planning tool. The user
sketches a parcel on a map, enters a program (buildings, basin %, parking, driveways), and
a **deterministic solver** places everything so it is guaranteed to fit inside the boundary,
rendered to scale over the map with an accurate scale bar and exportable as an image.

**Companion file:** the deep placement algorithm lives in `SITE_SOLVER_PLAN.md` (the
erosion / containment-by-construction engine). This document is the whole-app roadmap;
where it says "see solver spec," use that file.

---

## 1. Architecture (one principle)

Two separate engines, never mixed:
- **Geometry engine (deterministic, JavaScript + Turf.js)** computes every coordinate.
  This is what guarantees shapes fit. No AI here.
- **AI layer (optional, a text LLM)** only turns plain-English instructions into a small
  `hints` object (which corner for the basin, setback distance, orientation). It never
  outputs coordinates. Build this last; the app works fully without it.

Everything runs client-side. No backend required for v1. (A backend becomes worthwhile
later only to hide API keys or to run heavy optimization — out of scope now.)

---

## 2. Tech stack

- **HTML / CSS / vanilla JS (ES modules).** No framework needed. Optionally use Vite for a
  dev server and hot reload, but a plain static page works.
- **Map:** Google Maps JavaScript API (map + boundary sketching) and Google Static Maps API
  (satellite background for export). *Alternative:* Mapbox GL JS — cleaner native GeoJSON
  vector layers; pick it if starting fresh and you prefer vector overlays. Keep the map in
  its own module so it is swappable.
- **Geometry:** Turf.js — `buffer`, `difference`, `intersect`, `area`, `booleanContains`,
  `booleanPointInPolygon`.
  `<script src="https://cdnjs.cloudflare.com/ajax/libs/Turf.js/6.5.0/turf.min.js"></script>`
- **Projection:** start with an equirectangular feet projection about the parcel centroid
  (accurate for a few-acre site). Upgrade path: proj4js → UTM/State Plane for large sites.
- **Export:** HTML canvas compositing → PNG. Optional: jsPDF for a PDF sheet.
- **AI (optional, last):** Gemini or Claude text model for `parseInstructions`.

API keys needed: Google Maps JS API + Static Maps API (enable both on the key). LLM key
only if you build the AI layer.

---

## 3. File / module structure

```
index.html          UI shell + script/style includes
styles.css          layout + controls
js/
  main.js           wires UI -> solver -> renderer; owns app state
  map.js            map init, polygon sketching, capture boundary lat/lng + static bg
  projection.js     latLngToFeet / feetToLatLng about parcel centroid
  geometry.js       Turf helpers: toPoly, rectPoly, polysOf, biggestPoly, reach, gridPointsInside
  solver.js         solveLayout(parcelFt, reqs, hints)  <-- the engine (see SITE_SOLVER_PLAN.md)
  render.js         draw layout to canvas over map bg + accurate scale bar
  export.js         composite to PNG (and optional PDF)
  ai.js             OPTIONAL parseInstructions(text) -> hints   (built last)
```

---

## 4. Data model (single source of truth in `main.js` state)

```
parcelLatLng : [{lat,lng}, ...]        // from the map sketch
parcelFt     : [{x,y}, ...]            // projected to feet (origin = centroid)
reqs = {
  buildings:      [{label, length_ft, width_ft}, ...],   // 1–5
  parking_stalls: 50,
  pondPct:        15,                  // OR pondSqFt
  driveways:      2
}
hints = {                              // defaults; AI may override later
  setbackFt: 20, clearanceFt: 30,
  basinCorner: "SW", orientationPreference: "auto", buildingZone: "auto"
}
layout = {                            // solver output; renderer input
  buildings:[{label,length_ft,width_ft,center_x_ft,center_y_ft,orientation_deg}],
  parking_areas:[{center_x_ft,center_y_ft,orientation_deg,stall_count}],
  driveways:[ <polygon ft> ],
  detention_pond:{ <polygon ft> },
  rationale:""
}
```
All geometry is in **feet**. Convert to/from lat/lng only at the map boundary (sketch in,
render out).

---

## 5. Build phases (each is a testable milestone)

Build in order. Do not start a phase until the previous one passes its test.

### Phase 0 — Scaffold + map + sketch
Build: `index.html` shell, load Google Maps, show a satellite map, let the user click to
draw a polygon boundary, store the vertices as `parcelLatLng`, show a "Use boundary" button.
Test: draw a polygon over a real parcel; confirm the vertices are captured (log them).

### Phase 1 — Projection (prove correctness early)
Build: `projection.js`. `latLngToFeet(parcelLatLng)` → `parcelFt` using equirectangular
projection about the centroid. Display the parcel area in acres
(`turf.area(parcel)` m² → ÷ 4046.86).
Test: draw a parcel of known size; the acreage must match reality within a few percent.
**If this is wrong, everything downstream is wrong — do not proceed until it's right.**

### Phase 2 — Geometry helpers + setback
Build: `geometry.js` (`toPoly`, `rectPoly`, `polysOf`, `biggestPoly`, `reach`,
`gridPointsInside`). Compute `buildable = turf.buffer(parcel, -setbackFt, {units:'feet'})`.
Test: render the buildable polygon inset from the boundary; confirm it shrinks uniformly and
handles a null result (huge setback) without crashing.

### Phase 3 — Solver: basin (conforms + fits)
Build: in `solver.js`, carve the basin from a corner by binary-searching a clip rectangle
intersected with `buildable` until area = target ±5%. Subtract it from `free`.
Test: set basin to 15%; rendered basin area is within 5% of 15% of the parcel and visibly
hugs the irregular boundary.

### Phase 4 — Solver: parking + driveways
Build: parking reserve rectangle (`stalls × 325 ft²`) against the road-frontage edge, clipped
to `free`; driveway strips from that edge to parking. Subtract both (buffered) from `free`.
Test: parking + driveways render inside the boundary and do not overlap the basin.

### Phase 5 — Solver: buildings (THE core — guaranteed fit)
Build: the erosion placement loop (see `SITE_SOLVER_PLAN.md` §5). For each building: erode
`free` by the building's `reach`, pick a center from the eroded region biased to spread
across N zones, then subtract the placed footprint (+ clearance/2) from `free`. Buildings
that don't fit go in `rationale`, no crash.
Test: place 4 buildings on a tight parcel; assert `turf.booleanContains(parcel, footprint)`
is true for every one, no overlaps, ≥ clearance apart. Re-run twice → identical layout
(deterministic). **This phase is the whole point — spend the most time here.**

### Phase 6 — Render to scale + map background + export
Build: `render.js` draws the layout over the captured Static Maps background, in feet-space,
through one `pixelsPerFoot` value; draw the scale bar from that same value (round the bar to
a nice number, recompute on zoom). `export.js` composites map + overlay + scale bar → PNG.
Test: a 200 ft building measures 200 ft against the scale bar; the exported PNG contains
background + boundary + all blocks + scale bar.

### Phase 7 — AI hints layer (optional, last)
Build: `ai.js` `parseInstructions(text) -> hints` (LLM returns ONLY the hints JSON, never
coordinates); a free-text box; a "revise" flow where a revision returns updated `hints`/`reqs`
and re-runs the solver. Default hints if the call fails or the box is empty.
Test: "put the basin in the NE corner, 25 ft setback" changes `basinCorner`/`setbackFt` and
re-solves; the app still works with the box empty.

### Phase 8 — Polish
Build: parcel-area / footprint / basin-% stats panel; clear infeasibility messages; a
"download PNG" button; a determinism self-check (solve twice, compare). 

---

## 6. The solver in one paragraph (so the plan stands alone)

Keep one shrinking `free` region (start = parcel buffered in by the setback). Carve the
basin, then parking, then driveways out of it. Then place buildings largest-first: for each,
erode `free` inward by the building's reach (half its diagonal) to get the legal zone for its
center — **any** point there guarantees the building fits — pick a point biased to spread the
buildings out, then subtract that footprint plus clearance from `free` so the next building
can't overlap it. Containment and non-overlap are true by construction; there is no
place-then-check step that can leak. Full algorithm + edge cases: `SITE_SOLVER_PLAN.md`.

---

## 7. Acceptance criteria (whole app)
- [ ] Parcel acreage matches reality within a few percent (Phase 1).
- [ ] Every building fully inside the parcel with ≥ setback — `booleanContains` true for all.
- [ ] No building overlaps another (≥ clearance) or the basin / parking / driveways.
- [ ] Basin area within ±5% of target and conforms to the boundary.
- [ ] Output building dimensions exactly equal user inputs.
- [ ] Same inputs → identical layout every run (deterministic).
- [ ] Shapes render to scale; scale bar reads a true distance; export PNG includes map bg.
- [ ] Infeasible inputs produce a clear `rationale`, never a broken/empty plan.
- [ ] App fully usable with the AI layer turned off.

---

## 8. Build order summary
Scaffold+map → projection (verify acreage) → setback → basin → parking/driveways →
**buildings (erosion)** → render+scale+export → AI hints → polish.
The first six phases give a working, accurate tool with zero AI. Add intelligence only after
the geometry is provably correct.
