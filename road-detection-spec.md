# Road Detection — Spec

## Goal

After the parcel boundary closes, query OpenStreetMap (Overpass) for nearby roads, pick the nearest most-parallel one as the frontage road, pre-fill the `#input-frontage` dropdown with its cardinal (overridable), and **store the chosen road as a first-class object** the upcoming driveway-connection scoring will read. Runs on demand, never blocks, degrades to "no suggestion" on any failure.

New module: `road.js`, entry `async detectRoad(parcelLatLng, centroid) → roadResult | null`. Network + geometry live here. `main.js` wires the trigger, the pre-fill, and the map draw.

**Scope note:** this is the *store-the-geometry* version, not pre-fill-only. The road object is kept in state because "rank by whether the driveway connects to a road" (next spec) needs a road to measure against. Pre-fill alone can't satisfy that.

---

## 1. Query Overpass

- Build the parcel Turf polygon with the existing `toPoly(parcelLatLng)`; `turf.bbox` it.
- Expand the bbox by a margin (`roadConfig.bboxMarginFt`, default ~150 ft). Convert ft→degrees with the existing `computeScaleFactors(centroid)`: `padLat = marginFt / latToFt`, `padLng = marginFt / lngToFt`.
- POST to a public Overpass endpoint (`https://overpass-api.de/api/interpreter`). Query (bbox order is south,west,north,east = minLat,minLng,maxLat,maxLng):

  ```
  [out:json][timeout:25];
  way["highway"](minLat,minLng,maxLat,maxLng);
  out geom;
  ```

  `out geom;` returns inline node coords — no second lookup.
- Public Overpass supports CORS but rate-limits. Fire **only** from `detectRoad` (after boundary close), never on map move. Wrap the fetch in a timeout (`roadConfig.timeoutMs`, default ~8000); on timeout/non-2xx/network error → resolve `null`.

---

## 2. Convert + filter

- Each returned way has `geometry: [{lat, lon}, …]`. Map to a Turf `LineString` of `[lon, lat]` (matches your WGS84 `[lng,lat]` convention).
- **Filter to drivable roads** client-side on the `highway` tag: drop `footway|path|cycleway|steps|pedestrian|track|bridleway|corridor`. Keep the rest (motorway/trunk/primary/secondary/tertiary/residential/unclassified/service). Whitelist/blacklist lives in `roadConfig.highwayExclude`.
- Discard ways with < 2 nodes.

---

## 3. Pick the nearest most-parallel road

For each candidate road:
- `turf.nearestPointOnLine(road, centroidPoint, { units: 'feet' })` → nearest point + `properties.dist` (ft) + `properties.index` (segment).
- Drop roads beyond `roadConfig.maxDistFt` (default ~300 ft).
- **Parallelism gate** (this is what rejects cross-streets):
  - Road segment bearing: `turf.bearing` of the two vertices of the segment at `properties.index`.
  - Nearest parcel edge: of the parcel's boundary edges (consecutive vertex pairs), the one whose nearest point to the road's nearest point is smallest; its bearing via `turf.bearing` of its endpoints.
  - `bearingDiff = fold to 0–90` of the difference mod 180.
  - Reject if `bearingDiff > roadConfig.maxBearingDiffDeg` (default ~35°).
- Among survivors, choose **smallest distance**. (Nearest, among the roughly-parallel.)
- No survivors → resolve `null`.

---

## 4. Map to cardinal

- `turf.bearing(centroid → nearestPointOnChosenRoad)`, normalize to 0–360, snap to nearest of `{0:'N', 90:'E', 180:'S', 270:'W'}`. This is the side the road sits on = the frontage cardinal, consistent with how `arrange.js`'s local frame interprets frontage.

---

## 5. Return shape (first-class road object)

Stable contract — the driveway-connection scoring spec consumes this:

```js
{
  cardinal:   'S',                 // pre-fill value for #input-frontage
  line:       <Turf LineString>,   // chosen road, WGS84 [lng,lat]
  nearestPt:  <Turf Point>,        // nearest point on road to centroid
  distanceFt: 42.0,                // centroid→road distance
  bearingDiffDeg: 6.0,             // parallelism of chosen road vs frontage edge
  source:     'overpass'
}
```

`detectRoad` resolves this object, or `null` on any failure/none-found. It never throws.

---

## 6. Wiring in `main.js`

- In `onBoundaryClosed`, after `centroid` is set, call `detectRoad(parcelLatLng, centroid)` **without awaiting the UI on it** (fire-and-handle): boundary-close UI must not wait on the network.
- On resolve:
  - **`null`** → status line "No nearby road detected — set frontage manually." Leave the dropdown as-is. Store `detectedRoad = null`.
  - **object** → store module-level `detectedRoad = result`. Pre-fill the dropdown **only if it's currently `'auto'`** (never clobber a manual N/S/E/W the user already chose). Draw the road line on the map (distinct color, e.g. a thin magenta polyline) so the user can see what was detected and override. Status: "Detected road on <cardinal> side — override in the Road frontage dropdown."
- Add `detectedRoad` to the module state cleared in `onClear` (and clear the drawn road polyline).
- Frontage resolution at solve/optimize time is unchanged — it reads the dropdown, and detection just sets the dropdown. Manual override wins by construction.

---

## 7. Knobs (knob-not-weld)

All in a `roadConfig` (in the retail profile, or a standalone exported config):
`bboxMarginFt` (150), `maxDistFt` (300), `maxBearingDiffDeg` (35), `timeoutMs` (8000), `highwayExclude` (the pedestrian list above), `overpassUrl`. No magic numbers in `road.js`.

---

## 8. Honest limits

- Overpass coverage varies; rural/new parcels may return nothing → `null` is a normal outcome, not an error. The manual dropdown is always the fallback.
- The cardinal snap assumes a roughly axis-aligned parcel/road. A diagonal road still snaps to the nearest of N/E/S/W — fine for the frontage param, which is itself only 4-valued. Don't over-engineer past the 4 cardinals.
- This sets/stores frontage; it does **not** change scoring yet. The connection + length scoring that uses `detectedRoad.line` is the next spec.

---

## Phases — stop and test after each

**Phase 1 — detect, pre-fill, draw.** `road.js` with query + convert + filter + nearest-most-parallel pick + cardinal mapping; wire into `onBoundaryClosed` to pre-fill (only when dropdown is `'auto'`) and draw the detected road. Graceful `null` on failure/none. *Test on several real parcels: the correct road is chosen, the right cardinal pre-fills, the line draws on the map; a parcel with no nearby road leaves the dropdown untouched with a clear status; a cross-street is rejected by the parallelism gate.*

**Phase 2 — store + harden.** Finalize the §5 object in module state (the shape the driveway-scoring spec reads), expose all `roadConfig` knobs, handle corner lots (two near-parallel roads on different edges — pick nearest; both available in a `candidates` array on the result for later use). *Test: object shape is stable and populated; tweaking `maxBearingDiffDeg`/`maxDistFt` changes selection predictably; a corner lot resolves to the nearer road and lists the other.*
