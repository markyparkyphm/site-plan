# Site Planner — Task: Road Frontage (parameterize the "south" assumption)

## Why this task / design intent

The solver currently hardcodes "the road is on the south edge" in three places
(`placeAlongSouthEdge`, `makeDriveways` running off the parcel's min-latitude edge, and
parking pinned to that edge). A parcel that fronts a road on the east or north gets a
driveway pointing into the back of the site.

**Goal of this change: turn that hidden assumption into an exposed parameter — a "knob," not
a "weld."** Frontage becomes a value the system *reads*, with a sensible default so the tool
still runs untouched, and an override for when the user (or later, the AI) knows better.

This is deliberately the same pattern as `basinCorner`: a parameter the solver consumes,
filled today by a UI control and later by automatic detection or the AI hints layer — without
changing the geometry engine. Do NOT replace "south" with a new hardcoded direction; route
everything through one frontage parameter.

---

## The parameter

Add `frontage` to `hints`:
```
frontage: 'auto' | 'N' | 'S' | 'E' | 'W'   // which parcel edge fronts the road
```
- Default `'auto'`. For now `'auto'` resolves to `'S'` (preserves current behavior — nothing
  breaks). Later, `'auto'` will call a detection function (see "Optional follow-on").
- A single resolver decides the working value:
```js
function resolveFrontage(parcelLatLng, hints) {
  if (['N','S','E','W'].includes(hints.frontage)) return hints.frontage;
  return 'S'; // 'auto' placeholder until road detection lands
}
```
Everything downstream reads this one resolved value.

---

## Step 1 — Generalize parking placement

Replace `placeAlongSouthEdge(free, parkingSqFt, centroid)` with
`placeAlongFrontageEdge(free, parkingSqFt, centroid, frontage)`. Same logic, but pick the
edge and the perpendicular (inward) direction from `frontage` instead of always min-latitude:

- `'S'`: anchor at `minLat`; depth runs `+lat`; width spans `lng` (current behavior).
- `'N'`: anchor at `maxLat`; depth runs `-lat`; width spans `lng`.
- `'W'`: anchor at `minLng`; depth runs `+lng`; width spans `lat`.
- `'E'`: anchor at `maxLng`; depth runs `-lng`; width spans `lat`.

Keep the 60 ft depth and `parkingSqFt / depth` width. For E/W frontage, swap which axis is
"depth" vs "width" and set the parking `orientation_deg` to 90 (so the stored orientation
reflects the aisle direction). Clip to `biggestPoly(free)` exactly as now.

## Step 2 — Generalize driveways

In `makeDriveways(parcel, parking, count, centroid)`, the driveway strips currently run from
the parcel's min-latitude edge up to the parking block. Re-anchor them to the **frontage
edge** and run inward:

- A driveway is an access point from the *road* into the site, so anchor each strip on the
  resolved frontage edge of the **parcel** (not the parking block) and run it perpendicular
  inward until it reaches parking (or a fixed depth if no parking).
- For `'S'`/`'N'` frontage the strips are vertical (24 ft wide in `lng`); for `'E'`/`'W'` they
  are horizontal (24 ft wide in `lat`). Distribute `count` strips evenly along the frontage
  span, same `(i+1)/(count+1)` spacing you already use.

## Step 3 — Basin default derives from frontage

So the basin doesn't land on the road frontage, make its default corner depend on frontage
(still overridable by `basinCorner`):
```
frontage 'S' -> default basinCorner 'NE'   // opposite the road
frontage 'N' -> default 'SW'
frontage 'W' -> default 'SE'
frontage 'E' -> default 'NW'
```
Only apply this when the user hasn't explicitly set `basinCorner`.

## Step 4 — UI control

In `index.html`, add a frontage selector next to the basin-corner one:
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
In `main.js` `onSolve`, read it into `hints.frontage`:
```js
frontage: document.getElementById('input-frontage').value,
```

## Step 5 — Wire it into the AI hints layer (the autonomy hook)

This is the slot the AI inherits. In `ai.js`:
- Add `frontage` to the allowed fields in `PROMPT` ("one of N | S | E | W — which edge fronts
  the road").
- Add `const VALID_FRONTAGE = ['N','S','E','W'];` and accept `parsed.frontage` if valid.
- In `main.js` `onApplyAI`, reflect a parsed `frontage` back into `#input-frontage` (mirror the
  way `basinCorner` is reflected today).

Now "put the driveway on the east road" → `{frontage:'E'}` flows through the exact same
resolver the dropdown uses. Same knob, different filler.

---

## Tests
- Draw a parcel and set frontage to each of S/N/E/W in turn: parking and driveways move to the
  selected edge and driveways run inward from it; basin defaults to the opposite corner.
- With frontage `'auto'` and no AI, output is identical to today (regression check).
- Type "driveway on the north side" into the AI box → frontage flips to N and re-solves.
- Everything still sits inside the boundary (the erosion guarantees are untouched).

---

## Optional follow-on (later, additive — do NOT block this task on it)

Auto-detect frontage so `'auto'` resolves to a real suggestion instead of `'S'`:
- Query nearby road geometry around the parcel — OpenStreetMap via the Overpass API is free
  and good for this, or Google's roads data.
- For each parcel edge, measure distance and parallelism to nearby road lines; the closest,
  most-parallel edge is the suggested frontage.
- Return it as a **suggestion that pre-fills the dropdown**, never a locked answer — corner
  lots front two roads and only the engineer knows which one the access uses.

This is purely an upgrade to `resolveFrontage`'s `'auto'` branch. Nothing else changes,
because frontage is already a parameter — which is the whole point of building it this way.
