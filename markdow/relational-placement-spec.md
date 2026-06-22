# Relational Placement — Engine Spec

## Goal

Replace independent block-dropping with **relational placement**: elements are positioned relative to the parcel frontage and to each other (parking against a building face, driveway connecting frontage to lot, buildings grouped/shared-wall). The engine takes a symbolic **arrangement schema** and *realizes* it into valid coordinates. Containment-by-construction is preserved. The AI/optimizer never touches coordinates — they only emit/search schemas.

New module: `arrange.js`, entry point `realizeArrangement(schema, parcelLngLat, profile)`. Reuses `projection.js` (centroid feet), `solver.js` building erode-and-place, `geometry.js`. Returns realized geometry + per-element `feasible` flags. **Never throws, never emits invalid geometry** — infeasible elements are flagged, not forced.

---

## 1. Local frame (the foundation everything else uses)

All relations are defined in a parcel-local frame so semantics are independent of N/E/S/W.

In feet (via `projection.js`), from `frontage` cardinal compute two unit vectors about the centroid:

- `n̂` (**inward**): perpendicular to the frontage edge, pointing *into* the parcel.
- `t̂` (**along**): parallel to the frontage edge.

Define local coords for any point `p`: `u = (p−centroid)·t̂` (along-frontage), `v = (p−centroid)·n̂` (depth into lot). Then:

- **front** = toward frontage = smaller `v`
- **rear** = larger `v`
- **beside / left / right** = ±`u`

Every relation below resolves to `(u, v)` ranges, then unprojects back to `[lng,lat]`. This is the only place cardinal direction enters.

---

## 2. Arrangement schema (the thing AI/optimizer emit)

Plain JSON. Declarative. Realization order is derived from `relativeTo` dependencies (topological sort), not array order.

```json
{
  "frontage": "S",
  "elements": [
    { "id": "b1", "type": "building",
      "size": { "areaSqFt": 12000, "maxDepthFt": 70 },
      "place": { "anchor": "parcelFrontage", "setbackFt": 25, "alignU": "center" } },

    { "id": "p1", "type": "parking",
      "size": { "stalls": 60 },
      "place": { "anchor": "b1", "face": "front", "depthRowsFt": "auto" } },

    { "id": "d1", "type": "driveway",
      "size": { "widthFt": 24 },
      "place": { "connects": "parcelFrontage", "to": "p1", "entryU": "left" } },

    { "id": "bn1", "type": "basin",
      "size": { "pctOfParcel": 0.08 },
      "place": { "anchor": "parcelCorner", "corner": "rearLeft" } }
  ]
}
```

**Every `*Ft`, `setback`, `widthFt`, `depthRows`, `alignU`, `entryU` is a knob with a default.** Defaults live in the profile so the optimizer can search them and the AI can omit them.

---

## 3. Relations (resolver definitions)

Anchors resolve to a segment or region in local `(u,v)`:

- `parcelFrontage` → the frontage edge, `v ≈ vMin`.
- `parcelCorner` + `corner: rearLeft|rearRight|frontLeft|frontRight` → corner region.
- `<elementId>` + `face: front|rear|left|right` → that element's named face segment (front = its low-`v` edge, etc., in the local frame).

Placement relations:

- **building → parcelFrontage**: rectangle, width along `t̂`, depth along `n̂` capped at `maxDepthFt`, offset from frontage by `setbackFt`, positioned in `u` by `alignU` (`left|center|right`).
- **building → building (`adjacentTo`)**: share a face; `gapFt:0` = shared wall. Used for groups (§4).
- **parking → building face**: rectangle spanning that face's `u`-extent, depth = `rows × (stallDepth + aisle/2)` sized to hit `stalls` (use profile's 5/1,000 sf etc.). `depthRowsFt:"auto"` derives depth from stall target.
- **driveway → `connects` frontage `to` target**: corridor of `widthFt` from a frontage entry point (`entryU: left|center|right`) to the target's nearest edge. Multiple driveways = multiple driveway elements with different `entryU`.
- **basin → parcelCorner**: rectangle/wedge in the corner sized by `pctOfParcel` (current basin logic, re-expressed in schema).

---

## 4. Building groups

A `group` element holds child buildings + a layout so the AI can say "strip of 3 along frontage" in one node:

```json
{ "id": "g1", "type": "group", "layout": "strip",
  "place": { "anchor": "parcelFrontage", "setbackFt": 25 },
  "gapFt": 0,
  "children": [
    { "id": "b1", "size": { "areaSqFt": 8000 } },
    { "id": "b2", "size": { "areaSqFt": 8000 } },
    { "id": "b3", "size": { "areaSqFt": 8000 } }
  ] }
```

- `layout: "strip"` → children laid along `t̂`, `gapFt` between (0 = shared walls).
- Group is realized as a unit (its bounding extent placed by `place`), then children distributed inside. Child faces remain valid anchors for parking/driveways (`anchor: "b2"`, `face: "front"`).

---

## 5. Realization pipeline (`realizeArrangement`)

1. Project parcel to feet about centroid (`projection.js`).
2. Build local frame from `frontage` (§1).
3. `free = parcelPolygon` (feet).
4. Topologically order elements by `relativeTo` (`anchor`/`to`/`connects` targets). Cycle → mark involved elements `feasible:false`.
5. For each element in order:
   - Resolve anchor → local region (§3).
   - Compute candidate footprint from `size` + relation + offsets.
   - **Constrain to `free`:**
     - **building** → use `solver.js` erode-by-reach into `free`; if it doesn't fit at the anchor, slide along `t̂` then shrink toward `minSize`; if still no fit → `feasible:false`.
     - **parking / driveway / basin** → clip rectangle to `free` (these may be non-rectangular after clip; that's valid). If clipped area < `minViable` → `feasible:false`.
   - Subtract footprint **+ its clearance** from `free`.
6. Unproject all footprints to `[lng,lat]` for `render.js` / `score.js`.
7. Return `{ elements: [{id, type, polygonLngLat, feasible, reason?}], freeRemaining }`.

**Building vs. clippable distinction is deliberate:** buildings must stay rectangular → erode-and-fit (no clipping). Parking/driveway/basin tolerate clipping → place-then-clip. State this in code comments.

---

## 6. Feasibility

No exceptions. Every element returns `feasible:true|false` + `reason`. A schema with infeasible elements still returns valid geometry for the feasible ones. This is what lets the optimizer fire thousands of schemas safely and lets the (later) gated scorer disqualify on `feasible:false`.

---

## Implementation phases — stop and test after each

**Phase A — frame + parser + single building.** Local frame, schema parser, topo-order, realize one `building → parcelFrontage`. *Test: single building matches current placement, sits inside parcel at correct setback/cardinal.*

**Phase B — parking on a face.** `parking → building front`, stall-count sizing, clip-to-free. *Test: parking abuts building front edge, inside bounds, stall count ≈ target.*

**Phase C — driveway connect.** `driveway connects frontage → parking`, `entryU`. *Test: corridor links road frontage to parking, width correct, inside bounds.*

**Phase D — groups.** `group/strip`, `gapFt` (incl. 0 = shared wall), child faces usable as anchors. *Test: 3-building strip along frontage, parking anchors to a named child.*

**Phase E — basin + multiples + feasibility.** Basin into schema, wrap parking (front+side), 2 driveways, `feasible` flags wired. *Test: full schema realizes; force an oversized building and confirm `feasible:false` with valid output for the rest.*

After Phase E the optimizer can enumerate schema variants (layout, driveway count, parking sides, group type, offsets) and the AI can emit schemas — neither touching coordinates. Both are separate, later specs.

---

## Integration notes / open knobs

- Wire `realizeArrangement` output into existing `render.js` and `score.js` element shapes — confirm field names match before Phase A.
- Defaults (`setbackFt`, `stallDepth`, `aisle`, `driveway widthFt`, `gapFt`, `minSize`, clearances) go in the **profile**, not `arrange.js`.
- The current 144-candidate optimizer keeps working unchanged until the schema optimizer replaces it; don't rip it out in this spec.
