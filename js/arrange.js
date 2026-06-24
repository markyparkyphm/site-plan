// Relational placement engine — Phase D: local frame, schema parser, topo-sort,
// building → parcelFrontage, parking → building face, driveway, group/strip.
//
// Entry point: realizeArrangement(schema, parcelLngLat, profile)
// Returns: { elements: [{id, type, feasible, reason?, ...geomFields}], freeRemaining }
//
// Buildings must stay rectangular → erode-and-fit (no clipping).
// Parking / driveway / basin tolerate clipping → place-then-clip.

import { placeBuilding, growCornerClip } from './solver.js';
import { computeCentroid, latLngToFeet, latLngToFeetFromCentroid, feetToLatLngFromCentroid, polygonAreaSqFt } from './projection.js';
import { toPoly, rectPoly } from './geometry.js';

// ---------------------------------------------------------------------------
// Local frame
// n̂ (n): unit vector pointing inward (perpendicular to frontage, into the lot)
// t̂ (t): unit vector along the frontage edge
// v = depth into lot  (0 at frontage, positive inward)
// u = lateral offset  (0 at parcel centroid, positive in t̂ direction)
// ---------------------------------------------------------------------------

export function buildLocalFrame(frontage) {
  switch (frontage) {
    case 'S': return { n: { x: 0, y:  1 }, t: { x: 1, y:  0 } };
    case 'N': return { n: { x: 0, y: -1 }, t: { x: 1, y:  0 } };
    case 'E': return { n: { x: -1, y: 0 }, t: { x: 0, y:  1 } };
    case 'W': return { n: { x:  1, y: 0 }, t: { x: 0, y:  1 } };
    default:  return { n: { x: 0, y:  1 }, t: { x: 1, y:  0 } }; // fallback = S
  }
}

export function feetToLocal(pt, frame) {
  return {
    u: pt.x * frame.t.x + pt.y * frame.t.y,
    v: pt.x * frame.n.x + pt.y * frame.n.y,
  };
}

function localToFeet(u, v, frame) {
  return {
    x: u * frame.t.x + v * frame.n.x,
    y: u * frame.t.y + v * frame.n.y,
  };
}

// The minimum v across all parcel vertices = the frontage edge in local coords.
export function frontageV(parcelFt, frame) {
  return Math.min(...parcelFt.map(p => feetToLocal(p, frame).v));
}

// Actual parcel-boundary v at a specific u-position, found by scanning parcel edges.
// On irregular/diagonal parcels the frontage edge is not a straight line, so the global
// frontageV is only accurate at one vertex. This function finds the true boundary v at
// the given uCenter — needed so driveways don't fall outside the parcel on slanted lots.
function frontageVAtU(parcelFt, frame, uCenter) {
  const ring = [...parcelFt, parcelFt[0]];
  let minV = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const la = feetToLocal(ring[i], frame);
    const lb = feetToLocal(ring[i + 1], frame);
    const uMin = Math.min(la.u, lb.u);
    const uMax = Math.max(la.u, lb.u);
    if (uCenter < uMin || uCenter > uMax) continue;
    const v = Math.abs(lb.u - la.u) < 0.001
      ? Math.min(la.v, lb.v)
      : la.v + (uCenter - la.u) / (lb.u - la.u) * (lb.v - la.v);
    if (v < minV) minV = v;
  }
  return isFinite(minV) ? minV : frontageV(parcelFt, frame);
}

// ---------------------------------------------------------------------------
// Dependency extraction and topological sort
// ---------------------------------------------------------------------------

const PARCEL_ANCHORS = new Set(['parcelFrontage', 'parcelCorner']);

// Maps semantic corner names (relative to frontage) → geographic cardinal for growCornerClip.
// rear = away from road (high v), front = near road (low v), left = −t̂, right = +t̂
const CORNER_TO_CARDINAL = {
  S: { rearLeft: 'NW', rearRight: 'NE', frontLeft: 'SW', frontRight: 'SE' },
  N: { rearLeft: 'SW', rearRight: 'SE', frontLeft: 'NW', frontRight: 'NE' },
  E: { rearLeft: 'SW', rearRight: 'NW', frontLeft: 'SE', frontRight: 'NE' },
  W: { rearLeft: 'SE', rearRight: 'NE', frontLeft: 'SW', frontRight: 'NW' },
};
const CARDINAL_CORNERS = new Set(['SW', 'SE', 'NW', 'NE']);

function getDeps(element) {
  const p = element.place ?? {};
  const deps = [];
  if (p.anchor   && !PARCEL_ANCHORS.has(p.anchor))   deps.push(p.anchor);
  if (p.to       && !PARCEL_ANCHORS.has(p.to))        deps.push(p.to);
  if (p.connects && !PARCEL_ANCHORS.has(p.connects))  deps.push(p.connects);
  return deps;
}

// Returns an ordered array of element ids (dependencies first), or null on cycle.
// childToGroup: map from child-id → parent-group-id so that deps on group children
// resolve to the group (which must be realized before the child exists in `realized`).
function topoSort(elements, childToGroup = {}) {
  const resolveDep = id => childToGroup[id] ?? id;
  const deps = Object.fromEntries(elements.map(e => [
    e.id,
    getDeps(e).map(resolveDep).filter(d => d !== e.id),
  ]));
  const visited  = new Set();
  const visiting = new Set();
  const order    = [];

  function visit(id) {
    if (visited.has(id))  return true;
    if (visiting.has(id)) return false; // cycle
    visiting.add(id);
    for (const dep of deps[id] ?? []) {
      if (!visit(dep)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
    return true;
  }

  for (const el of elements) {
    if (!visit(el.id)) return null;
  }
  return order;
}

// ---------------------------------------------------------------------------
// Element realizers (Phase C: building → parcelFrontage, parking → building face,
//                             driveway connects parcelFrontage → parking)
// ---------------------------------------------------------------------------

// Compute a building's (uMin, uMax, vMin, vMax) in local frame from its placed geometry.
// vMin = front face (closest to road), vMax = rear face.
export function buildingLocalBounds(b, frame) {
  const rad = (b.orientation_deg ?? 0) * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const hl = b.length_ft / 2, hw = b.width_ft / 2;
  const cx = b.center_x_ft, cy = b.center_y_ft;
  const cornersFt = [
    { x: cx - hl*cos + hw*sin, y: cy - hl*sin - hw*cos },
    { x: cx + hl*cos + hw*sin, y: cy + hl*sin - hw*cos },
    { x: cx + hl*cos - hw*sin, y: cy + hl*sin + hw*cos },
    { x: cx - hl*cos - hw*sin, y: cy - hl*sin + hw*cos },
  ];
  const local = cornersFt.map(p => feetToLocal(p, frame));
  return {
    uMin: Math.min(...local.map(p => p.u)),
    uMax: Math.max(...local.map(p => p.u)),
    vMin: Math.min(...local.map(p => p.v)),
    vMax: Math.max(...local.map(p => p.v)),
  };
}

// Return local-frame bounds for any realized element.
// Parking stores exact pre-clip bounds in localBounds; buildings use corner math;
// other clippable types fall back to bbox approximation.
function elementLocalBounds(el, frame, centroid) {
  if (el.localBounds) {
    return { uMin: el.localBounds.uMin, uMax: el.localBounds.uMax,
             vMin: el.localBounds.vMin, vMax: el.localBounds.vMax };
  }
  if (el.type === 'building') return buildingLocalBounds(el, frame);
  if (el.feature) {
    const [minLng, minLat, maxLng, maxLat] = turf.bbox(el.feature);
    const corners = [
      { lat: minLat, lng: minLng }, { lat: minLat, lng: maxLng },
      { lat: maxLat, lng: minLng }, { lat: maxLat, lng: maxLng },
    ].map(ll => feetToLocal(latLngToFeetFromCentroid(ll, centroid), frame));
    return {
      uMin: Math.min(...corners.map(p => p.u)), uMax: Math.max(...corners.map(p => p.u)),
      vMin: Math.min(...corners.map(p => p.v)), vMax: Math.max(...corners.map(p => p.v)),
    };
  }
  return null;
}

// ADA Standards Table 208.2 — required accessible stalls by total count.
function _adaRequired(n) {
  if (n <= 25)   return 1;
  if (n <= 50)   return 2;
  if (n <= 75)   return 3;
  if (n <= 100)  return 4;
  if (n <= 150)  return 5;
  if (n <= 200)  return 6;
  if (n <= 300)  return 7;
  if (n <= 400)  return 8;
  if (n <= 500)  return 9;
  if (n <= 1000) return Math.ceil(n * 0.02);
  return 20 + Math.ceil((n - 1000) / 100);
}

function realizeParking(el, free, parcelFt, parcelTurf, frame, centroid, profile, realized) {
  const place = el.place ?? {};
  const size  = el.size  ?? {};
  const anchorId = place.anchor;
  const face     = place.face ?? 'front';

  if (!anchorId || PARCEL_ANCHORS.has(anchorId)) {
    return { id: el.id, type: 'parking', feasible: false,
             reason: 'parking requires an element anchor (e.g., anchor: "b1")' };
  }
  const anchorEl = realized[anchorId];
  if (!anchorEl) {
    return { id: el.id, type: 'parking', feasible: false,
             reason: `anchor '${anchorId}' not found` };
  }
  if (!anchorEl.feasible) {
    return { id: el.id, type: 'parking', feasible: false,
             reason: `anchor '${anchorId}' is infeasible` };
  }

  // Get building's local-frame bounds; front face = vMin (closest to road).
  const ab      = buildingLocalBounds(anchorEl, frame);
  // Lateral faces (left/right) span the building's v-depth; axial (front/rear) span u-width.
  const lateral = (face === 'left' || face === 'right');
  const faceFt  = lateral ? (ab.vMax - ab.vMin) : (ab.uMax - ab.uMin);

  // Size depth from stall target.
  // One row = stallDepthFt stalls + aisleFt/2 (half-aisle shared with the next row).
  const targetStalls    = size.stalls ?? 20;
  const stallSpacingFt  = 9;
  const stallRowDepthFt = (profile.stallDepthFt ?? 18) + (profile.aisleFt ?? 24) / 2;
  const stallsPerRow    = Math.max(1, Math.floor(faceFt / stallSpacingFt));
  const rows            = Math.ceil(targetStalls / stallsPerRow);
  const depthFt         = rows * stallRowDepthFt;

  // Build the pre-clip rectangle and localBounds in local (u, v) coordinates.
  // front/rear: rectangle spans building u-width, extends in v toward/away from road.
  // left/right: rectangle spans building v-depth, extends in u off the side face.
  let uvRing, localBounds;
  if (!lateral) {
    const vFace = face === 'rear' ? ab.vMax : ab.vMin;
    const vNear = face === 'rear' ? vFace           : vFace - depthFt;
    const vFar  = face === 'rear' ? vFace + depthFt : vFace;
    uvRing = [[ab.uMin, vNear], [ab.uMax, vNear], [ab.uMax, vFar], [ab.uMin, vFar], [ab.uMin, vNear]];
    localBounds = { uMin: ab.uMin, uMax: ab.uMax, vMin: vNear, vMax: vFar };
  } else {
    const uFace = face === 'right' ? ab.uMax : ab.uMin;
    const uNear = face === 'right' ? uFace           : uFace - depthFt;
    const uFar  = face === 'right' ? uFace + depthFt : uFace;
    uvRing = [[uNear, ab.vMin], [uFar, ab.vMin], [uFar, ab.vMax], [uNear, ab.vMax], [uNear, ab.vMin]];
    localBounds = { uMin: uNear, uMax: uFar, vMin: ab.vMin, vMax: ab.vMax };
  }

  // Unproject local rectangle corners to WGS84.
  const ring = uvRing.map(([u, v]) => {
    const ft = localToFeet(u, v, frame);
    const ll = feetToLatLngFromCentroid(ft, centroid);
    return [ll.lng, ll.lat];
  });
  const parkRect = turf.polygon([ring]);

  // Clip to free — parking tolerates partial coverage.
  // Exception: restore the anchor building's clearance zone so parking can touch the
  // building face. clearanceFt is for building-to-building spacing, not building-to-parking.
  const clearanceFt = profile.clearanceFt ?? 30;
  const anchorFoot  = rectPoly(
    anchorEl.center_x_ft, anchorEl.center_y_ft,
    anchorEl.length_ft, anchorEl.width_ft,
    anchorEl.orientation_deg ?? 0, centroid
  );
  const anchorBuf   = turf.buffer(anchorFoot, clearanceFt, { units: 'feet' });
  const clearRing   = anchorBuf ? (turf.difference(anchorBuf, anchorFoot) ?? anchorBuf) : null;
  const freeForPark = clearRing ? (turf.union(free, clearRing) ?? free) : free;
  // Intersect with parkRect first, then clip to parcelTurf.
  // The clearRing buffer around the building can extend beyond the parcel boundary; without
  // the parcelTurf clip the parking polygon escapes the lot on close-to-road placements.
  const rawClipped = turf.intersect(freeForPark, parkRect);
  const clipped    = rawClipped ? (turf.intersect(parcelTurf, rawClipped) ?? rawClipped) : null;
  if (!clipped) {
    return { id: el.id, type: 'parking', feasible: false, reason: 'No overlap with free space' };
  }
  const actualSqFt = turf.area(clipped) * 10.7639;
  if (actualSqFt < (profile.minBuildingAreaSqFt ?? 400)) {
    return { id: el.id, type: 'parking', feasible: false,
             reason: `Parking too small after clipping (${Math.round(actualSqFt)} sq ft)` };
  }

  const sqFtPerStall = 9 * ((profile.stallDepthFt ?? 18) + (profile.aisleFt ?? 24) / 2);
  const actualStalls     = Math.floor(actualSqFt / sqFtPerStall);
  const accessibleStalls = _adaRequired(actualStalls);
  const [cMinLng, cMinLat, cMaxLng, cMaxLat] = turf.bbox(clipped);
  const cFt = latLngToFeetFromCentroid(
    { lat: (cMinLat + cMaxLat) / 2, lng: (cMinLng + cMaxLng) / 2 }, centroid
  );
  clipped.properties = {
    center_x_ft: cFt.x, center_y_ft: cFt.y,
    orientation_deg: 0, stall_count: actualStalls, accessibleStalls,
  };

  return {
    id: el.id, type: 'parking', feasible: true,
    feature: clipped, stall_count: actualStalls,
    // Store exact pre-clip local bounds so driveway placement is accurate.
    localBounds,
  };
}

function realizeDriveway(el, parcelFt, parcelTurf, frame, centroid, profile, realized) {
  const place = el.place ?? {};
  const size  = el.size  ?? {};

  const connectsTo = place.connects ?? 'parcelFrontage';
  const toId       = place.to;
  const entryU     = place.entryU ?? 'center';
  const halfWidth  = (size.widthFt ?? profile.drivewayWidthFt ?? 24) / 2;

  if (connectsTo !== 'parcelFrontage') {
    return { id: el.id, type: 'driveway', feasible: false,
             reason: `connects '${connectsTo}' not supported (Phase C: parcelFrontage only)` };
  }

  // Resolve target element bounds
  let targetBounds;
  if (toId && !PARCEL_ANCHORS.has(toId)) {
    const targetEl = realized[toId];
    if (!targetEl || !targetEl.feasible) {
      return { id: el.id, type: 'driveway', feasible: false,
               reason: `target '${toId}' is not realized or infeasible` };
    }
    targetBounds = elementLocalBounds(targetEl, frame, centroid);
    if (!targetBounds) {
      return { id: el.id, type: 'driveway', feasible: false,
               reason: `cannot compute local bounds for target '${toId}'` };
    }
  } else {
    const us = parcelFt.map(p => feetToLocal(p, frame).u);
    const vFront = frontageV(parcelFt, frame);
    targetBounds = { uMin: Math.min(...us), uMax: Math.max(...us), vMin: vFront, vMax: vFront };
  }

  // u-center of the driveway, aligned to the target's u-extent
  let uCenter;
  switch (entryU) {
    case 'left':  uCenter = targetBounds.uMin + halfWidth; break;
    case 'right': uCenter = targetBounds.uMax - halfWidth; break;
    default:      uCenter = (targetBounds.uMin + targetBounds.uMax) / 2; break;
  }

  // frontageVAtU finds the actual parcel boundary v at this driveway's u-position, needed
  // for diagonal/irregular parcels where global frontageV is only accurate at one vertex.
  const vFront = frontageVAtU(parcelFt, frame, uCenter);

  // Functional default: span from road edge to the served element's far edge.
  // When no target element (parcelFrontage-only), vMax === vFront → functionalLenFt = 0
  // → vTarget = vFront+1, matching original behavior.
  const functionalLenFt = Number.isFinite(targetBounds.vMax)
    ? (targetBounds.vMax - vFront)
    : (targetBounds.vMin - vFront);

  // Knob priority: schema size.lengthFt > profile.defaultDriveLengthFt > functional default.
  const reqLenFt = (Number.isFinite(size.lengthFt)              ? size.lengthFt
                 : Number.isFinite(profile.defaultDriveLengthFt) ? profile.defaultDriveLengthFt
                 : functionalLenFt);

  // No upper clamp to parcelVMax: clamping creates an edge exactly coincident with the
  // parcel boundary, which triggers a JSTS "Unable to complete output ring" error in
  // turf.intersect. The intersect clip below trims the rectangle to the parcel anyway,
  // just as the -50 ft over-extension already does on the road side.
  const vTarget = Math.max(vFront + 1, vFront + reqLenFt);

  const ring = [
    [uCenter - halfWidth, vFront - 50],
    [uCenter + halfWidth, vFront - 50],
    [uCenter + halfWidth, vTarget],
    [uCenter - halfWidth, vTarget],
    [uCenter - halfWidth, vFront - 50],
  ].map(([u, v]) => {
    const ft = localToFeet(u, v, frame);
    const ll = feetToLatLngFromCentroid(ft, centroid);
    return [ll.lng, ll.lat];
  });
  const dwRect = turf.polygon([ring]);

  // Clip to parcel (not free — driveways pass through the setback zone below parking).
  let clipped;
  try {
    clipped = turf.intersect(parcelTurf, dwRect);
  } catch (_) {
    clipped = null;
  }
  if (!clipped) {
    return { id: el.id, type: 'driveway', feasible: false, reason: 'No overlap with parcel' };
  }

  const realizedLenFt = vTarget - vFront;
  clipped.properties = {
    ...(clipped.properties ?? {}),
    lengthFt: realizedLenFt,
    widthFt:  halfWidth * 2,
    entryU,
  };
  return {
    id: el.id, type: 'driveway', feasible: true,
    feature: clipped,
    lengthFt: realizedLenFt,
  };
}

// Find a position for a W×D (local frame) rectangle in `free`, scanning forward
// (deeper into the lot) from (startU, startV) in 10 ft steps.
// Uses direct polygon containment instead of circumradius erosion so that wide,
// shallow groups (e.g., three 150 ft buildings side-by-side) still fit in typical parcels.
// Returns { center_x_ft, center_y_ft } or null.
function scanGroupPlacement(free, parcelFt, frame, centroid, totalFaceFt, groupDepthFt, startU, startV) {
  const halfFace  = totalFaceFt  / 2;
  const halfDepth = groupDepthFt / 2;

  const makeBox = (u, v) => {
    const ring = [
      [u - halfFace, v - halfDepth], [u + halfFace, v - halfDepth],
      [u + halfFace, v + halfDepth], [u - halfFace, v + halfDepth],
      [u - halfFace, v - halfDepth],
    ].map(([uu, vv]) => {
      const ft = localToFeet(uu, vv, frame);
      const ll = feetToLatLngFromCentroid(ft, centroid);
      return [ll.lng, ll.lat];
    });
    return turf.polygon([ring]);
  };

  const boxArea = turf.area(makeBox(startU, startV)); // constant across positions
  const fits    = (u, v) => {
    const isect = turf.intersect(free, makeBox(u, v));
    return isect != null && turf.area(isect) >= boxArea * 0.999;
  };

  // Try the exact target first, then scan forward in 10 ft steps.
  // At each depth, also try small lateral shifts to work around slanted parcel edges.
  const vs      = parcelFt.map(p => feetToLocal(p, frame).v);
  const vMax    = Math.max(...vs);
  const uShifts = [0, halfFace * 0.25, -halfFace * 0.25, halfFace * 0.5, -halfFace * 0.5];

  for (let vi = 0; vi < 80; vi++) {
    const testV = startV + vi * 10;
    if (testV + halfDepth > vMax) break;
    for (const uOff of uShifts) {
      if (fits(startU + uOff, testV)) {
        const ft = localToFeet(startU + uOff, testV, frame);
        return { center_x_ft: ft.x, center_y_ft: ft.y };
      }
    }
  }
  return null;
}

// Fallback: when the strip group is too wide for one row, pack children into multiple
// rows using scanGroupPlacement (direct containment — not circumradius erosion).
// Row 1 sits at bSetbackFt from the road; subsequent rows stack behind it.
// Returns a group result with individualFallback:true so realizeArrangement adopts
// the already-updated free space rather than subtracting a nonexistent single bbox.
function realizeGroupFallback(el, childSpecs, free, parcelFt, frame, centroid, profile, setbackFt, vFront, tIsX) {
  const clearanceFt = profile.clearanceFt ?? 30;
  const gapFt       = el.gapFt ?? 0;

  // Split children into rows that each fit within the parcel's u-extent (≤95%).
  // First child of each row is always included even if it alone exceeds the parcel —
  // scanGroupPlacement will still find the best available position.
  const parcelUs = parcelFt.map(p => feetToLocal(p, frame).u);
  const uExtent  = Math.max(...parcelUs) - Math.min(...parcelUs);

  const rows = [];
  let remaining = [...childSpecs];
  while (remaining.length > 0) {
    const row  = [];
    let faceFt = 0;
    for (const spec of remaining) {
      const newFace = row.length === 0 ? spec.faceFt : faceFt + gapFt + spec.faceFt;
      if (newFace <= uExtent * 0.95 || row.length === 0) {
        row.push(spec);
        faceFt = newFace;
      } else {
        break;
      }
    }
    rows.push({ specs: row, faceFt });
    remaining = remaining.slice(row.length);
  }

  let localFree = free;
  const childResults = [];
  let currentV = vFront + setbackFt;

  for (const row of rows) {
    const rowDepthFt = Math.max(...row.specs.map(s => s.depthFt));
    const targetV    = currentV + rowDepthFt / 2;

    const rowCenter = scanGroupPlacement(
      localFree, parcelFt, frame, centroid, row.faceFt, rowDepthFt, 0, targetV,
    );

    if (!rowCenter) {
      // No room for this row — mark its children infeasible and advance.
      for (const cSpec of row.specs) {
        childResults.push({
          id: cSpec.id, type: 'building', feasible: false, label: cSpec.id,
          reason: 'No space for building row in parcel',
        });
      }
      currentV += rowDepthFt + clearanceFt;
      continue;
    }

    // Distribute children along t̂ within this row (same logic as the normal strip).
    const placedLocal = feetToLocal({ x: rowCenter.center_x_ft, y: rowCenter.center_y_ft }, frame);
    const rowFrontV   = placedLocal.v - rowDepthFt / 2;
    let   uCursor     = placedLocal.u - row.faceFt / 2;

    for (const cSpec of row.specs) {
      const childU         = uCursor + cSpec.faceFt / 2;
      uCursor             += cSpec.faceFt + gapFt;
      const childV         = rowFrontV + cSpec.depthFt / 2;
      const childFt        = localToFeet(childU, childV, frame);
      const faceIsLonger   = cSpec.faceFt >= cSpec.depthFt;
      const childOrientDeg = tIsX ? (faceIsLonger ? 0 : 90) : (faceIsLonger ? 90 : 0);
      childResults.push({
        id:              cSpec.id,
        type:            'building',
        feasible:        true,
        label:           cSpec.id,
        length_ft:       Math.max(cSpec.faceFt, cSpec.depthFt),
        width_ft:        Math.min(cSpec.faceFt, cSpec.depthFt),
        center_x_ft:     childFt.x,
        center_y_ft:     childFt.y,
        orientation_deg: childOrientDeg,
      });
    }

    // Subtract this row's bounding box + clearance from free.
    const faceIsLonger = row.faceFt >= rowDepthFt;
    const rowFoot = rectPoly(
      rowCenter.center_x_ft, rowCenter.center_y_ft,
      Math.max(row.faceFt, rowDepthFt), Math.min(row.faceFt, rowDepthFt),
      tIsX ? (faceIsLonger ? 0 : 90) : (faceIsLonger ? 90 : 0),
      centroid,
    );
    const buf = turf.buffer(rowFoot, clearanceFt, { units: 'feet' });
    if (buf) localFree = turf.difference(localFree, buf) ?? localFree;

    // Advance currentV past the rear face + clearance gap so the next row starts there.
    currentV = placedLocal.v + rowDepthFt / 2 + clearanceFt;
  }

  const anyFeasible = childResults.some(c => c.feasible);
  return {
    id:                 el.id,
    type:               'group',
    feasible:           anyFeasible,
    reason:             anyFeasible ? undefined : 'No buildings could be placed in rows',
    childResults,
    freeAfter:          localFree,
    individualFallback: true,
  };
}

// Place a strip group at parcelFrontage and distribute children along t̂.
// Children share the group's front face; shorter children leave open space behind them.
// The group bounding box (not individual children) is the unit subtracted from free.
function realizeGroup(el, free, parcelFt, frame, centroid, profile) {
  const place    = el.place    ?? {};
  const gapFt    = el.gapFt   ?? 0;
  const children = el.children ?? [];
  const anchor   = place.anchor ?? 'parcelFrontage';

  const failAll = (reason) => ({
    id: el.id, type: 'group', feasible: false, reason,
    childResults: children.map(c => ({
      id: c.id, type: 'building', feasible: false,
      reason: `Parent group infeasible: ${reason}`,
    })),
  });

  if (anchor !== 'parcelFrontage') return failAll(`anchor '${anchor}' not supported (Phase D: parcelFrontage only)`);
  if (children.length === 0) return failAll('Group has no children');

  const setbackFt = place.setbackFt ?? (profile.setbackFt ?? 20);

  // Derive each child's local dimensions: depthFt along n̂, faceFt along t̂.
  const childSpecs = children.map(c => {
    const areaSqFt   = c.size?.areaSqFt   ?? (profile.defaultBuildingAreaSqFt ?? 12000);
    const maxDepthFt = c.size?.maxDepthFt ?? (profile.maxBuildingDepthFt ?? 70);
    const depthFt    = Math.min(maxDepthFt, Math.sqrt(areaSqFt));
    const faceFt     = areaSqFt / depthFt;
    return { id: c.id, depthFt, faceFt };
  });

  const N           = children.length;
  const groupLayout = el.layout ?? 'strip';

  // Compute group bounding box dimensions based on layout.
  // strip: all children in one row along t̂ (face = total width, depth = tallest child).
  // stacked: R rows along n̂ (face = widest row, depth = R*rowDepth + gaps).
  let totalFaceFt, groupDepthFt, stackedR, stackedCols, stackedRowDepthFt;
  if (groupLayout === 'stacked') {
    stackedR        = Math.ceil(Math.sqrt(N));
    stackedCols     = Math.ceil(N / stackedR);
    stackedRowDepthFt = Math.max(...childSpecs.map(c => c.depthFt));
    groupDepthFt    = stackedR * stackedRowDepthFt + Math.max(0, stackedR - 1) * gapFt;
    totalFaceFt     = 0;
    for (let r = 0; r < stackedR; r++) {
      const rowKids = childSpecs.slice(r * stackedCols, (r + 1) * stackedCols);
      const rowW = rowKids.reduce((s, c) => s + c.faceFt, 0) + Math.max(0, rowKids.length - 1) * gapFt;
      if (rowW > totalFaceFt) totalFaceFt = rowW;
    }
  } else {
    totalFaceFt  = childSpecs.reduce((s, c) => s + c.faceFt, 0) + gapFt * (N - 1);
    groupDepthFt = Math.max(...childSpecs.map(c => c.depthFt));
  }

  // Orient bSpec so that length_ft aligns with t̂ (the strip direction).
  // t̂ = x (S/N): orient 0 → length along x; orient 90 → length along y (= n̂).
  // t̂ = y (E/W): orient 90 → length along y; orient 0 → length along x (= n̂).
  const tIsX           = Math.abs(frame.t.x) > 0.5;
  const faceIsLonger   = totalFaceFt >= groupDepthFt;
  const groupOrientDeg = tIsX ? (faceIsLonger ? 0 : 90) : (faceIsLonger ? 90 : 0);

  const bSpec = {
    label:     el.id,
    length_ft: Math.max(totalFaceFt, groupDepthFt),
    width_ft:  Math.min(totalFaceFt, groupDepthFt),
  };

  const vFront  = frontageV(parcelFt, frame);
  const targetV = vFront + setbackFt + groupDepthFt / 2;

  // Lateral start from alignU: numeric = direct u-feet, strings map to parcel extents.
  const alignU = place.alignU ?? 'center';
  let startU = 0;
  if (typeof alignU === 'number') {
    startU = alignU;
  } else if (alignU === 'left' || alignU === 'right') {
    const us   = parcelFt.map(p => feetToLocal(p, frame).u);
    const uMin = Math.min(...us), uMax = Math.max(...us);
    startU = alignU === 'left' ? uMin + totalFaceFt / 2 : uMax - totalFaceFt / 2;
  }

  // Use direct bbox containment scan instead of placeBuilding's circumradius erosion.
  // placeBuilding erodes by reach = hypot(totalFaceFt, groupDepthFt)/2, which for a
  // 300×80 group yields ~155 ft — often exceeding the parcel's available depth. Direct
  // scan only needs halfDepth (40 ft) clearance from N/S boundaries.
  const groupCenter = scanGroupPlacement(
    free, parcelFt, frame, centroid, totalFaceFt, groupDepthFt, startU, targetV,
  );
  // Group doesn't fit — fall back to placing each building individually using
  // erosion-based placement. This handles oversized strips and deep stacked configs.
  if (!groupCenter) {
    return realizeGroupFallback(el, childSpecs, free, parcelFt, frame, centroid, profile, setbackFt, vFront, tIsX);
  }
  const placed = { ...bSpec, ...groupCenter };

  const placedLocal = feetToLocal({ x: placed.center_x_ft, y: placed.center_y_ft }, frame);
  const groupFrontV = placedLocal.v - groupDepthFt / 2;

  // Distribute children into the placed bounding box.
  // strip: one row along t̂, all front faces aligned.
  // stacked: R rows along n̂; within each row, children distributed along t̂, front-face aligned.
  const childResults = [];
  if (groupLayout === 'stacked') {
    for (let r = 0; r < stackedR; r++) {
      const rowKids  = childSpecs.slice(r * stackedCols, (r + 1) * stackedCols);
      const rowFrontV = groupFrontV + r * (stackedRowDepthFt + gapFt);
      let uCursor    = placedLocal.u - totalFaceFt / 2;
      for (const cSpec of rowKids) {
        const childU  = uCursor + cSpec.faceFt / 2;
        uCursor      += cSpec.faceFt + gapFt;
        const childV  = rowFrontV + cSpec.depthFt / 2;
        const childFt = localToFeet(childU, childV, frame);
        const childFaceIsLonger = cSpec.faceFt >= cSpec.depthFt;
        const childOrientDeg    = tIsX ? (childFaceIsLonger ? 0 : 90) : (childFaceIsLonger ? 90 : 0);
        childResults.push({
          id: cSpec.id, type: 'building', feasible: true, label: cSpec.id,
          length_ft: Math.max(cSpec.faceFt, cSpec.depthFt),
          width_ft:  Math.min(cSpec.faceFt, cSpec.depthFt),
          center_x_ft: childFt.x, center_y_ft: childFt.y,
          orientation_deg: childOrientDeg,
        });
      }
    }
  } else {
    // strip: all children's front faces aligned to the group's front face.
    let uCursor = placedLocal.u - totalFaceFt / 2;
    for (const cSpec of childSpecs) {
      const childU  = uCursor + cSpec.faceFt / 2;
      uCursor      += cSpec.faceFt + gapFt;
      const childV  = groupFrontV + cSpec.depthFt / 2;
      const childFt = localToFeet(childU, childV, frame);
      const childFaceIsLonger = cSpec.faceFt >= cSpec.depthFt;
      const childOrientDeg    = tIsX ? (childFaceIsLonger ? 0 : 90) : (childFaceIsLonger ? 90 : 0);
      childResults.push({
        id: cSpec.id, type: 'building', feasible: true, label: cSpec.id,
        length_ft: Math.max(cSpec.faceFt, cSpec.depthFt),
        width_ft:  Math.min(cSpec.faceFt, cSpec.depthFt),
        center_x_ft: childFt.x, center_y_ft: childFt.y,
        orientation_deg: childOrientDeg,
      });
    }
  }

  return {
    id:              el.id,
    type:            'group',
    feasible:        true,
    placed,
    orientation_deg: groupOrientDeg,
    childResults,
  };
}

// Phase E — place a detention basin clipped from a parcel corner.
// anchor: 'parcelCorner', corner: 'rearLeft'|'rearRight'|'frontLeft'|'frontRight'
//   OR a literal cardinal 'SW'|'SE'|'NW'|'NE' (passed through from the UI dropdown).
function realizeBasin(el, free, parcelFt, centroid, frontage) {
  const place = el.place ?? {};
  const size  = el.size  ?? {};
  const anchor = place.anchor ?? 'parcelCorner';

  if (anchor !== 'parcelCorner') {
    return { id: el.id, type: 'basin', feasible: false,
             reason: `anchor '${anchor}' not supported (Phase E: parcelCorner only)` };
  }

  const cornerName = place.corner ?? 'rearRight';
  let cardinal;
  if (CARDINAL_CORNERS.has(cornerName)) {
    cardinal = cornerName;
  } else {
    cardinal = (CORNER_TO_CARDINAL[frontage] ?? CORNER_TO_CARDINAL.S)[cornerName];
    if (!cardinal) {
      return { id: el.id, type: 'basin', feasible: false,
               reason: `Unknown corner '${cornerName}'` };
    }
  }

  const parcelAreaSqFt = polygonAreaSqFt(parcelFt);
  const pctOfParcel    = size.pctOfParcel ?? 0.08;
  const targetSqFt     = size.sqFt ?? (pctOfParcel * parcelAreaSqFt);

  const clipped = growCornerClip(free, cardinal, targetSqFt, centroid);
  if (!clipped) {
    return { id: el.id, type: 'basin', feasible: false,
             reason: 'Could not fit basin in corner' };
  }

  const actualSqFt = turf.area(clipped) * 10.7639;
  if (actualSqFt < targetSqFt * 0.5) {
    return { id: el.id, type: 'basin', feasible: false,
             reason: `Basin undersized: got ${Math.round(actualSqFt).toLocaleString()} sq ft, ` +
                     `target ${Math.round(targetSqFt).toLocaleString()} sq ft` };
  }

  return { id: el.id, type: 'basin', feasible: true, feature: clipped };
}

function realizeBuilding(el, free, parcelFt, frame, centroid, profile) {
  const place = el.place ?? {};
  const size  = el.size  ?? {};
  const anchor = place.anchor ?? 'parcelFrontage';

  if (anchor !== 'parcelFrontage') {
    return {
      id: el.id, type: 'building', feasible: false,
      reason: `anchor '${anchor}' not implemented (Phase A supports parcelFrontage only)`,
    };
  }

  // Derive building dimensions from the size spec.
  // depthFt  = dimension along n̂ (into the lot), capped at maxBuildingDepthFt
  // faceFt   = dimension along t̂ (along the frontage), derived from area
  const areaSqFt   = size.areaSqFt   ?? (profile.defaultBuildingAreaSqFt ?? 12000);
  const maxDepthFt = size.maxDepthFt ?? (profile.maxBuildingDepthFt ?? 70);
  const depthFt = Math.min(maxDepthFt, Math.sqrt(areaSqFt));
  const faceFt  = areaSqFt / depthFt;

  // bSpec uses solver.js field names: length_ft = longer side, width_ft = shorter side.
  // At orientation_deg=0 the solver places length along x-axis (east-west = t̂ for S/N).
  const bSpec = {
    label:     el.id,
    length_ft: Math.max(depthFt, faceFt),
    width_ft:  Math.min(depthFt, faceFt),
  };

  const setbackFt = place.setbackFt ?? (profile.setbackFt ?? 20);
  const alignU    = place.alignU    ?? 'center';
  const vFront    = frontageV(parcelFt, frame);

  // Target: building center placed at setbackFt + half-depth from the frontage edge.
  // bSpec.width_ft is the shorter (depth) side — faces inward at orientation 0°.
  const halfDepth = bSpec.width_ft / 2;
  const targetV   = vFront + setbackFt + halfDepth;

  let targetU = 0; // default: parcel centroid's u-coordinate (centered)
  if (typeof alignU === 'number') {
    targetU = alignU; // direct local-frame u-coordinate in feet
  } else if (alignU === 'left' || alignU === 'right') {
    const us  = parcelFt.map(p => feetToLocal(p, frame).u);
    const uMin = Math.min(...us), uMax = Math.max(...us);
    const pad  = setbackFt + bSpec.length_ft / 2;
    targetU = alignU === 'left' ? uMin + pad : uMax - pad;
  }

  const targetPt    = localToFeet(targetU, targetV, frame);
  const placed = placeBuilding(free, bSpec, targetPt, [0, 90], centroid);

  if (!placed) {
    return {
      id: el.id, type: 'building', feasible: false,
      reason: 'No valid position found at parcelFrontage anchor',
    };
  }

  return {
    id: el.id, type: 'building', feasible: true,
    label:           el.id,
    length_ft:       placed.length_ft,
    width_ft:        placed.width_ft,
    center_x_ft:     placed.center_x_ft,
    center_y_ft:     placed.center_y_ft,
    orientation_deg: placed.orientation_deg,
  };
}

function realizeElement(el, free, parcelFt, parcelTurf, frame, centroid, profile, realized, frontage) {
  if (el.type === 'building') return realizeBuilding(el, free, parcelFt, frame, centroid, profile);
  if (el.type === 'parking')  return realizeParking(el, free, parcelFt, parcelTurf, frame, centroid, profile, realized);
  if (el.type === 'driveway') return realizeDriveway(el, parcelFt, parcelTurf, frame, centroid, profile, realized);
  if (el.type === 'group')    return realizeGroup(el, free, parcelFt, frame, centroid, profile);
  if (el.type === 'basin')    return realizeBasin(el, free, parcelFt, centroid, frontage);
  return {
    id: el.id, type: el.type, feasible: false,
    reason: `${el.type} not implemented`,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

// schema: { frontage: 'N'|'S'|'E'|'W', elements: [...] }
// parcelLngLat: [{lat, lng}]
// profile: PROFILES.retail (from score.js)
// Returns: { elements: [{id, type, feasible, reason?, ...geomFields}], freeRemaining }
export function realizeArrangement(schema, parcelLngLat, profile) {
  const frontage   = schema.frontage ?? 'S';
  const centroid   = computeCentroid(parcelLngLat);
  const parcelFt   = latLngToFeet(parcelLngLat);
  const parcelTurf = toPoly(parcelLngLat);
  const frame      = buildLocalFrame(frontage);

  // Erode by setback — mirrors solveLayout step 1
  const setback = profile.setbackFt ?? 20;
  const free0   = turf.buffer(parcelTurf, -setback, { units: 'feet' });
  if (!free0) {
    return {
      elements: schema.elements.map(e => ({
        id: e.id, type: e.type, feasible: false, reason: 'Setback too large',
      })),
      freeRemaining: null,
    };
  }

  // Build child→group map so topo-sort can resolve dependencies on group children
  // (e.g., parking anchoring to "b1" that lives inside group "g1") to the group itself.
  const childToGroup = {};
  for (const el of schema.elements) {
    if (el.type === 'group' && el.children) {
      for (const child of el.children) childToGroup[child.id] = el.id;
    }
  }

  // Topological sort on declared dependencies
  const order = topoSort(schema.elements, childToGroup);
  if (order === null) {
    return {
      elements: schema.elements.map(e => ({
        id: e.id, type: e.type, feasible: false, reason: 'Dependency cycle',
      })),
      freeRemaining: free0,
    };
  }

  const elementMap = Object.fromEntries(schema.elements.map(e => [e.id, e]));
  const realized   = {};
  const results    = [];
  let   free       = free0;

  // JSTS "output ring" guard: multi-building groups create exactly coincident boundary
  // segments between the group clearance buffer and child building clearance buffers
  // (hit in realizeParking's turf.union). Same patch as optimizeArrangement; always
  // restored in finally so nothing outside realizeArrangement is affected.
  const origUnion      = turf.union;
  const origDifference = turf.difference;
  const origIntersect  = turf.intersect;
  turf.union      = (a, b) => { try { return origUnion(a, b);      } catch (_) { return null; } };
  turf.difference = (a, b) => { try { return origDifference(a, b); } catch (_) { return null; } };
  turf.intersect  = (a, b) => { try { return origIntersect(a, b);  } catch (_) { return null; } };

  try {
  for (const id of order) {
    const el = elementMap[id];
    if (!el) continue;

    const result = realizeElement(el, free, parcelFt, parcelTurf, frame, centroid, profile, realized, frontage);
    realized[id] = result;
    results.push(result);

    // Register group children in realized so downstream elements can anchor to them.
    if (result.childResults) {
      for (const child of result.childResults) {
        realized[child.id] = child;
        results.push(child);
      }
    }

    // Subtract placed footprint from free.
    if (result.feasible && result.type === 'building') {
      // Buildings: subtract footprint + clearance buffer (mirrors solveLayout step 5).
      const foot = rectPoly(
        result.center_x_ft, result.center_y_ft,
        result.length_ft, result.width_ft,
        result.orientation_deg, centroid
      );
      const buf = turf.buffer(foot, profile.clearanceFt ?? 30, { units: 'feet' });
      if (buf) free = turf.difference(free, buf) ?? free;
    } else if (result.feasible && result.type === 'group') {
      if (result.individualFallback) {
        // Free space was already updated per-child inside realizeGroupFallback; adopt it.
        if (result.freeAfter) free = result.freeAfter;
      } else {
        // Normal strip group: subtract the bounding box as a unit — clearance applied once, not per child.
        const p    = result.placed;
        const foot = rectPoly(p.center_x_ft, p.center_y_ft, p.length_ft, p.width_ft, result.orientation_deg, centroid);
        const buf  = turf.buffer(foot, profile.clearanceFt ?? 30, { units: 'feet' });
        if (buf) free = turf.difference(free, buf) ?? free;
      }
    } else if (result.feasible && result.type === 'parking') {
      // Parking: subtract clipped footprint + small gap buffer.
      const buf = turf.buffer(result.feature, profile.gapFt ?? 10, { units: 'feet' });
      if (buf) free = turf.difference(free, buf) ?? free;
    } else if (result.feasible && result.type === 'driveway') {
      // Driveways: subtract with a small buffer so buildings don't land in the lane.
      const buf = turf.buffer(result.feature, 3, { units: 'feet' });
      if (buf) free = turf.difference(free, buf) ?? free;
    } else if (result.feasible && result.type === 'basin') {
      // Basin: subtract with 5 ft buffer, matching solver.js.
      const buf = turf.buffer(result.feature, 5, { units: 'feet' });
      if (buf) free = turf.difference(free, buf) ?? free;
    }
  }

  return { elements: results, freeRemaining: free };
  } finally {
    turf.union      = origUnion;
    turf.difference = origDifference;
    turf.intersect  = origIntersect;
  }
}
