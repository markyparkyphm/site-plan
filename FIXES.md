# Site Planner — Fixes (post-review)

The solver and rendering are working and correct (containment, scale, carve order all
verified). These are the fixes to take it from "correct but bare" to "looks like a real
plan." Do them in order; each is independently testable. Commit per fix.

---

## Priority 1 — Add the satellite background to the canvas / PNG export

**Problem:** `render.js` draws the plan on a plain dark canvas. The live Google Maps overlay
sits on satellite imagery, but the "View Scale Drawing" canvas and the exported PNG have no
background, so the deliverable reads as an abstract line drawing. This was the missing piece
of Phase 6.

**Fix:** fetch a Google Static Maps satellite image of the parcel and draw it as the bottom
layer of the canvas, with the polygons aligned pixel-perfect on top.

**The alignment catch:** the current `ft2px` transform in `render.js` is a bbox "fit to
canvas" mapping. A Static Maps image is **Web Mercator, centered on a point at a zoom level** —
it will NOT line up with a bbox-fit transform. So the canvas render must switch to a Mercator
pixel projection for *both* the background and the overlays, using the same center + zoom as
the Static Maps request. Then everything aligns by construction.

**Recipe:**

1. Pick center = parcel centroid. Pick the largest integer `zoom` at which the parcel still
   fits inside the canvas (minus padding). World pixel size at a zoom = `256 * 2**zoom`.
   Web-Mercator pixel of a lat/lng:
   ```js
   function lngLatToWorldPx(lng, lat, zoom) {
     const size = 256 * Math.pow(2, zoom);
     const x = (lng + 180) / 360 * size;
     const s = Math.sin(lat * Math.PI / 180);
     const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size;
     return { x, y };
   }
   ```
   Loop zoom from ~20 down; for each, project all parcel vertices, measure pixel width/height
   around the centroid, stop at the first zoom that fits in `(canvasW - 2*PAD, canvasH - 2*PAD)`.

2. Request the image (Static Maps caps each side at 640 px — use `scale=2` for crispness and
   match the canvas aspect ratio, e.g. 640×462 for a 900×650 canvas):
   ```
   https://maps.googleapis.com/maps/api/staticmap
     ?center={lat},{lng}&zoom={zoom}&size={w}x{h}&scale=2
     &maptype=satellite&key={window.MAPS_API_KEY}
   ```

3. Project everything to canvas pixels with the SAME center+zoom. For any lng/lat:
   ```js
   const c = lngLatToWorldPx(centerLng, centerLat, zoom);   // centroid world px
   function project(lng, lat) {
     const p = lngLatToWorldPx(lng, lat, zoom);
     return { cx: canvas.width/2 + (p.x - c.x), cy: canvas.height/2 + (p.y - c.y) };
   }
   ```
   Replace the current `ft2px` usage in `renderLayoutOnCanvas` with this `project`, fed the
   WGS84 coordinates of each polygon (you already have them before converting to feet — skip
   the feet round-trip for the canvas and project lng/lat directly).

4. Draw order: background image first (`ctx.drawImage(img, 0, 0, canvas.width, canvas.height)`),
   then parcel boundary, basin, parking, driveways, buildings, then the scale bar.

5. **Scale bar must change too:** it currently derives from `pixelsPerFoot` of the bbox
   transform. Recompute it from the Mercator zoom instead:
   `metersPerPixel = cos(centerLat) * 2π * 6378137 / (256 * 2**zoom * scale)`, convert to
   feet, then `pixelsPerFoot = 1 / feetPerPixel`. Keep the existing nice-number rounding.

**Async + CORS gotchas (important):**
- Image loading is async. Make `renderLayoutOnCanvas` await the image, or have `onRender` in
  `main.js` preload it (`const img = new Image(); img.onload = …`) and pass it in.
- Set `img.crossOrigin = 'anonymous'` **before** `img.src`, or `canvas.toDataURL()` in
  `export.js` will throw a "tainted canvas" security error and PNG export will silently fail.
  After wiring this, **test the export specifically** — load the plan, download PNG, confirm
  it actually saves with the imagery in it. If it still taints, the fallback is to route the
  Static Maps fetch through a tiny proxy (this is the same backend you'll want for the Gemini
  key anyway).

**Test:** the scale drawing and exported PNG show the parcel over real aerial imagery, with
boundary and blocks aligned to the ground, and a correct scale bar.

---

## Priority 2 — Fix building-to-building spacing (currently half of `clearanceFt`)

**Problem:** in `solver.js` step 5, each placed building is removed from `free` buffered by
`clearance / 2`. Because the next building's center is then eroded by its own reach, the
guaranteed gap between two buildings works out to `clearance / 2`, not `clearance`. With the
default 30 ft you're getting ~15 ft between buildings.

**Fix:** buffer the placed footprint by the **full** `clearance`:
```js
// in solver.js, building placement loop — change clearance / 2 to clearance
const footBuf = turf.buffer(foot, clearance, { units: 'feet' });
```
(The basin/parking/driveway buffers of 5/5/3 ft are separate and define building-to-those
gaps; leave them unless you want those larger too.)

**Test:** place 3–4 buildings close together; measure the gap against the scale bar — it
should now read ~30 ft, not ~15.

---

## Priority 3 — Cleanups (low risk, do together)

- **Sample all of `free`, not just the largest piece.** `gridPointsInside` runs `biggestPoly`
  first, so if `free` splits into two regions a building can be wrongly reported as "doesn't
  fit." Change it to iterate `polysOf(geom)` and sample candidates from every piece.
- **Spread along the parcel's long axis.** `zoneCentroid` always spreads buildings east-west.
  Compare the parcel bbox width vs height (in feet) and split zones along whichever is longer
  so buildings spread the sensible direction on tall parcels.
- **Warn on an undersized basin.** `growCornerClip` can return a basin below target without
  saying so. After it returns, if the basin area is < ~90% of target, push a warning.
- **Make the determinism tie-break explicit.** `SUMMARY.md` claims a "lowest-y then lowest-x"
  tie-break but the sort only compares distance. Add it so it's true, not incidental:
  ```js
  cands.sort((a, b) => dist2(a, target) - dist2(b, target) || a.y - b.y || a.x - b.x);
  ```
- **Remove dead/duplicated code.** Delete the unused `toCanvas` function and the unused
  `computeTransform` offsets in `render.js`. `computeScaleFactors` is defined in
  `projection.js` and re-defined locally in both `render.js` and `solver.js`
  (`computeScaleApprox`) — import the one in `projection.js` everywhere instead.

**Test:** re-run a few layouts; behavior is unchanged except buildings spread better on tall
parcels and the basin warns when it can't hit target.

---

## Not now (future, optional)

- **Real per-orientation fitting.** The `for (const deg of orientations)` loop in `solver.js`
  is currently inert: `reach` (half-diagonal) is identical at 0° and 90°, so the eroded legal
  region is the same and the second orientation is never tried. To make rotation actually help
  a long building fit a narrow space, you'd need anisotropic erosion (rotate `free` by `-deg`,
  treat the building as axis-aligned, erode by half-length and half-width separately). Only
  worth it if you see buildings failing to fit that obviously would if rotated.
