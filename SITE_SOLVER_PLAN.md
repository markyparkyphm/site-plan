# Site Planner — Auto-Solver Engine (containment by construction)

## Goal

Replace AI-driven placement in `index.html` with a **deterministic auto-solver** that
places buildings, a detention basin, parking, and driveways so that **every shape is
guaranteed inside the parcel boundary and never overlaps another shape**. The current
tool leaks shapes past the boundary because it places first and checks/nudges after.
This engine makes containment true *by construction*, so there is nothing to repair.

Stay client-side (JavaScript + Turf.js). No Python backend.

This document supersedes the placement section of any earlier plan. It is self-contained.

---

## Core principle (read first)

A building's *center* cannot legally go just anywhere in the parcel — it must stay far
enough from every edge that the building's own body still fits. So we **shrink the legal
area before placing**, never after:

1. Shrink the parcel inward by the setback → `buildable`.
2. Carve out the basin, parking, and driveways → `free` (the remaining space).
3. For each building, shrink `free` inward by that building's *reach* (half its diagonal)
   → `legalCenters`. **Any** point inside `legalCenters` guarantees the whole building
   fits with no rotation worries.
4. Place the center, then subtract the building's footprint (plus clearance) from `free`.

Half-diagonal erosion is slightly conservative (it leaves a little corner space unused)
but it is **mathematically impossible** for the result to cross the boundary. Use it for
v1. A tighter orientation-specific erosion is a later optimization (see Note 3).

---

## What to KEEP (unchanged)
- `renderLayoutOnCanvas(canvas, parcelFt, layout, bgCanvas, tileInfo)` — the renderer.
- `drawScaleBar(...)`, `projectToFeet(...)`, Static Maps capture, `tileInfo`, all sketch/KML/UI.
- The `layout` JSON schema the renderer consumes (see "Output" below). The solver must
  produce exactly this shape.

## What to REMOVE
- All `gemini-*-image-*` models; default `selectedModelId` → a text model (`gemini-2.5-flash`).
- The image branch of `handleResponse()` and any image-based revision round-trip.
- `buildLayoutPrompt()` (it asked the AI for coordinates) and the AI-coordinate path.

## What to ADD
- Turf.js via CDN:
  `<script src="https://cdnjs.cloudflare.com/ajax/libs/Turf.js/6.5.0/turf.min.js"></script>`
- The deterministic `solveLayout(parcelFt, reqs, hints)` engine below.
- (Optional, light) an AI `parseInstructions(text) -> hints` helper. The AI only ever
  returns hints (corner, setback, orientation, zone) — never coordinates.

---

## Data model

- Work entirely in **feet**, using Turf with `{units:'feet'}` on every distance call.
- `parcelFt`: array of `{x,y}` in feet (already produced by `projectToFeet`).
- Build a Turf polygon `parcel = turf.polygon([ringClosed(parcelFt)])`.
- `free`: a Turf Polygon **or MultiPolygon** of remaining space. Always handle both —
  negative buffers and differences can split a region into several pieces or return null.

Helpers to add:
```
toPoly(ptsFt)                      // closed Turf polygon from [{x,y}]
rectPoly(cx, cy, lenFt, widFt, deg)// Turf polygon for a rotated rectangle footprint
polysOf(geom)                      // -> array of Turf polygons (handles null / Multi)
biggestPoly(geom)                  // largest-area polygon piece, or null
reach(lenFt, widFt)                // = Math.hypot(lenFt, widFt) / 2
```

---

## `solveLayout(parcelFt, reqs, hints)` — step by step

Compute in this exact order. Order matters: basin/parking/driveways are carved out
**before** buildings so buildings can never land on them.

### 1. Buildable area (setback)
```
const setback = hints.setbackFt ?? 20;
let buildable = turf.buffer(parcel, -setback, {units:'feet'});
if (!buildable) return infeasible("Setback too large for this parcel.");
```

### 2. Detention basin (conforms to the boundary, fits by construction)
- Target area `A = reqs.pondSqFt ?? (reqs.pondPct/100) * turf.area(parcel)*10.7639` (m²→ft²
  if needed — keep units consistent; `turf.area` returns m², so convert once).
- Anchor at `hints.basinCorner` (default the corner nearest the road, e.g. "SW").
- Grow a clip rectangle from that corner and intersect with `buildable`; **binary-search**
  the rectangle size until `turf.area(intersection)` is within ±5% of `A`.
- Because it is an intersection with `buildable`, the basin automatically follows the
  irregular boundary and cannot exceed it.
```
const basin = growCornerClip(buildable, hints.basinCorner, A); // binary search
let free = turf.difference(buildable, turf.buffer(basin, 5, {units:'feet'})); // 5ft gap
```

### 3. Parking reserve (area-based, against road frontage)
- Required area `P = reqs.parking_stalls * 325`  (≈325 ft²/stall incl. aisles).
- Place a rectangle against the south/road-frontage edge sized to `P`, then clip to `free`.
- Emit one `parking_areas` entry carrying the real `stall_count`.
```
const parking = placeAlongSouthEdge(free, P);            // rect ∩ free near frontage
free = turf.difference(free, turf.buffer(parking, 5, {units:'feet'}));
```

### 4. Driveways
- For `reqs.driveways` (default 1): a strip from the south parcel edge up to the parking
  reserve. Carve each from `free` too.
```
const driveways = makeDriveways(parcel, parking, reqs.driveways ?? 1);
driveways.forEach(d => { free = turf.difference(free, turf.buffer(d,3,{units:'feet'})); });
```

### 5. Buildings (the guaranteed-fit core)
Sort buildings largest-first. Split the parcel's longer axis into N equal **zones** (one
per building) so buildings spread out instead of clustering. For building `i`:
```
const clearance = hints.clearanceFt ?? 30;
const orientations = preferredFirst(hints.orientationPreference); // e.g. [0,90] or [90,0]
let placed = null;

for (const deg of orientations) {
  const r = reach(b.length_ft, b.width_ft);
  const legal = turf.buffer(free, -r, {units:'feet'});   // erode by reach
  if (!legal) continue;                                   // no room at this orientation

  // candidate centers: grid over legal's bbox, kept only if inside legal
  const target = zoneCentroid(parcel, i, N);              // spread target for building i
  const cands = gridPointsInside(legal, 10)               // 10 ft step
                  .sort(byDistanceTo(target));            // nearest-to-zone first (deterministic)
  if (cands.length === 0) continue;

  const c = cands[0];
  placed = { ...b, center_x_ft:c.x, center_y_ft:c.y, orientation_deg:deg };
  const foot = rectPoly(c.x, c.y, b.length_ft, b.width_ft, deg);
  free = turf.difference(free, turf.buffer(foot, clearance/2, {units:'feet'}));
  break;
}

if (!placed) warnings.push(`${b.label} (${b.length_ft}×${b.width_ft} ft) does not fit.`);
else layout.buildings.push(placed);
```
Notes:
- `turf.buffer(free, -reach)` is what guarantees the footprint stays inside `free` ⊆
  `buildable` ⊆ `parcel`. No `booleanContains` check is needed because containment is
  built in — but you MAY keep one `console.assert(turf.booleanContains(parcel, foot))`
  during development as a tripwire.
- Subtracting each placed footprint (buffered by `clearance/2`) from `free` is what
  guarantees ≥ `clearance` separation between buildings.
- `b.length_ft` / `b.width_ft` come straight from `reqs` and are never recomputed.

### 6. Output
Return the layout JSON in the existing schema (the renderer already understands it):
```json
{
  "buildings":      [{"label":"A","length_ft":200,"width_ft":100,"center_x_ft":0,"center_y_ft":0,"orientation_deg":0}],
  "parking_areas":  [{"center_x_ft":0,"center_y_ft":0,"orientation_deg":0,"stall_count":50}],
  "driveways":      [ /* polygon or strip in ft */ ],
  "detention_pond": { /* polygon in ft */ },
  "rationale":      "Plain-English summary; list anything that did not fit."
}
```

---

## Wiring it in

- `generate()`:
  1. `const hints = inputText ? await parseInstructions(inputText) : defaultHints();`
  2. `const layout = solveLayout(parcelFt, reqs, hints);`
  3. `renderLayoutOnCanvas(canvas, parcelFt, layout, bgCanvas, tileInfo);`
  - `validateAndFixLayout` can stay as a dev-time assertion but should never need to fix anything.
- `revise()`: send the revision text to the text model, get back an **updated `hints`/`reqs`**
  (e.g. bigger basin → bump `pondPct`; "spread north" → set `buildingZone`), then re-run
  `solveLayout` + `renderLayoutOnCanvas`. No image round-trips.
- `parseInstructions(text)` prompt: "Return ONLY this JSON, no prose:
  `{setbackFt, clearanceFt, basinCorner, orientationPreference, buildingZone, notes}`.
  Never output coordinates." Fall back to defaults if the call fails or text is empty.

---

## Robustness / edge cases (implement these)
- `turf.buffer(x, -d)` may return `null` (region vanished) or a MultiPolygon — always run
  results through `polysOf()` and skip empty/`null`.
- Drop sliver polygons below ~50 ft² before sampling candidates.
- Binary search the basin size with a max iteration cap (~25) and a ±5% area tolerance.
- If a building won't fit at any orientation, do not crash — record it in `warnings` /
  `rationale`. Optionally retry the whole solve once with `clearance` reduced to 20 ft.
- Keep all geometry in feet; convert `turf.area` (m²) to ft² exactly once where used.

---

## Acceptance criteria
- [ ] No `gemini-*-image-*` model is selectable; no generated image is ever shown as the plan.
- [ ] Every building is fully inside the parcel with ≥ setback from all edges — verified by
      `turf.booleanContains(parcel, footprint)` returning true for every building.
- [ ] No two buildings overlap; edge-to-edge clearance ≥ `clearanceFt` (default 30).
- [ ] No building overlaps the basin, parking, or driveways.
- [ ] Basin area within ±5% of target and visibly conforms to the parcel boundary.
- [ ] Output `length_ft`/`width_ft` exactly equal the user inputs.
- [ ] Same inputs produce the **same** layout every run (deterministic ordering + tie-breaks).
- [ ] Infeasible inputs return a clear `rationale`, not a broken or empty plan.
- [ ] Scale bar + map background still render correctly (renderer untouched).

---

## Notes
1. **Determinism**: fix the iteration order (buildings largest-first; orientations in a
   fixed list; candidate tie-break = nearest-to-zone then lowest y then lowest x). This is
   what makes re-runs reproducible — a property the old AI path could never have.
2. **Projection**: `projectToFeet` is a flat approximation, fine for a few-acre parcel.
   Revisit only for very large or high-latitude sites.
3. **Tighter packing (future)**: half-diagonal erosion wastes some corner area. For a
   tighter fit per orientation, rotate `free` by `-deg`, treat the building as axis-aligned,
   and erode by half-length and half-width separately (anisotropic Minkowski erosion), then
   rotate candidates back. Only do this if v1 leaves obviously usable space empty.
4. **Optimization ceiling**: the grid-scan solver is great for 1–5 buildings. Many buildings
   or provably-optimal packing is the only real reason to add a Python + OR-Tools backend —
   not before.
