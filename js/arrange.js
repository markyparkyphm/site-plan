// Relational placement engine — Phase B: local frame, schema parser, topo-sort,
// building → parcelFrontage, and parking → building face.
//
// Entry point: realizeArrangement(schema, parcelLngLat, profile)
// Returns: { elements: [{id, type, feasible, reason?, ...geomFields}], freeRemaining }
//
// Buildings must stay rectangular → erode-and-fit (no clipping).
// Parking / driveway / basin tolerate clipping → place-then-clip.

import { placeBuilding } from './solver.js';
import { computeCentroid, latLngToFeet, latLngToFeetFromCentroid, feetToLatLngFromCentroid } from './projection.js';
import { toPoly, rectPoly } from './geometry.js';

// ---------------------------------------------------------------------------
// Local frame
// n̂ (n): unit vector pointing inward (perpendicular to frontage, into the lot)
// t̂ (t): unit vector along the frontage edge
// v = depth into lot  (0 at frontage, positive inward)
// u = lateral offset  (0 at parcel centroid, positive in t̂ direction)
// ---------------------------------------------------------------------------

function buildLocalFrame(frontage) {
  switch (frontage) {
    case 'S': return { n: { x: 0, y:  1 }, t: { x: 1, y:  0 } };
    case 'N': return { n: { x: 0, y: -1 }, t: { x: 1, y:  0 } };
    case 'E': return { n: { x: -1, y: 0 }, t: { x: 0, y:  1 } };
    case 'W': return { n: { x:  1, y: 0 }, t: { x: 0, y:  1 } };
    default:  return { n: { x: 0, y:  1 }, t: { x: 1, y:  0 } }; // fallback = S
  }
}

function feetToLocal(pt, frame) {
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
function frontageV(parcelFt, frame) {
  return Math.min(...parcelFt.map(p => feetToLocal(p, frame).v));
}

// ---------------------------------------------------------------------------
// Dependency extraction and topological sort
// ---------------------------------------------------------------------------

const PARCEL_ANCHORS = new Set(['parcelFrontage', 'parcelCorner']);

function getDeps(element) {
  const p = element.place ?? {};
  const deps = [];
  if (p.anchor   && !PARCEL_ANCHORS.has(p.anchor))   deps.push(p.anchor);
  if (p.to       && !PARCEL_ANCHORS.has(p.to))        deps.push(p.to);
  if (p.connects && !PARCEL_ANCHORS.has(p.connects))  deps.push(p.connects);
  return deps;
}

// Returns an ordered array of element ids (dependencies first), or null on cycle.
function topoSort(elements) {
  const deps = Object.fromEntries(elements.map(e => [e.id, getDeps(e)]));
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
function buildingLocalBounds(b, frame) {
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

function realizeParking(el, free, parcelFt, frame, centroid, profile, realized) {
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
  const ab     = buildingLocalBounds(anchorEl, frame);
  const faceFt = ab.uMax - ab.uMin;
  const vFace  = face === 'rear' ? ab.vMax : ab.vMin;

  // Size depth from stall target.
  // One row = stallDepthFt stalls + aisleFt/2 (half-aisle shared with the next row).
  const targetStalls    = size.stalls ?? 20;
  const stallSpacingFt  = 9;
  const stallRowDepthFt = (profile.stallDepthFt ?? 18) + (profile.aisleFt ?? 24) / 2;
  const stallsPerRow    = Math.max(1, Math.floor(faceFt / stallSpacingFt));
  const rows            = Math.ceil(targetStalls / stallsPerRow);
  const depthFt         = rows * stallRowDepthFt;

  // Parking extends from building face toward frontage ('front') or rearward ('rear').
  // front: vNear = vFace - depthFt (smaller v = closer to road)
  const vNear = face === 'rear' ? vFace           : vFace - depthFt;
  const vFar  = face === 'rear' ? vFace + depthFt : vFace;

  // Unproject local rectangle corners to WGS84.
  const ring = [
    [ab.uMin, vNear], [ab.uMax, vNear],
    [ab.uMax, vFar],  [ab.uMin, vFar],
    [ab.uMin, vNear],
  ].map(([u, v]) => {
    const ft = localToFeet(u, v, frame);
    const ll = feetToLatLngFromCentroid(ft, centroid);
    return [ll.lng, ll.lat];
  });
  const parkRect = turf.polygon([ring]);

  // Clip to free — parking tolerates partial coverage.
  const clipped = turf.intersect(free, parkRect);
  if (!clipped) {
    return { id: el.id, type: 'parking', feasible: false, reason: 'No overlap with free space' };
  }
  const actualSqFt = turf.area(clipped) * 10.7639;
  if (actualSqFt < (profile.minBuildingAreaSqFt ?? 400)) {
    return { id: el.id, type: 'parking', feasible: false,
             reason: `Parking too small after clipping (${Math.round(actualSqFt)} sq ft)` };
  }

  const actualStalls = Math.floor(actualSqFt / 325);
  const [cMinLng, cMinLat, cMaxLng, cMaxLat] = turf.bbox(clipped);
  const cFt = latLngToFeetFromCentroid(
    { lat: (cMinLat + cMaxLat) / 2, lng: (cMinLng + cMaxLng) / 2 }, centroid
  );
  clipped.properties = {
    center_x_ft: cFt.x, center_y_ft: cFt.y,
    orientation_deg: 0, stall_count: actualStalls,
  };

  return {
    id: el.id, type: 'parking', feasible: true,
    feature: clipped, stall_count: actualStalls,
    // Store exact pre-clip local bounds so driveway placement is accurate.
    localBounds: { uMin: ab.uMin, uMax: ab.uMax, vMin: vNear, vMax: vFar },
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

  // v range: from the parcel frontage edge (with a 50 ft over-extension so the clip
  // to parcel trims it exactly to the boundary) down to the target's near edge.
  const vFront  = frontageV(parcelFt, frame);
  const vTarget = targetBounds.vMin;

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
  const clipped = turf.intersect(parcelTurf, dwRect);
  if (!clipped) {
    return { id: el.id, type: 'driveway', feasible: false, reason: 'No overlap with parcel' };
  }

  return { id: el.id, type: 'driveway', feasible: true, feature: clipped };
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
  if (alignU === 'left' || alignU === 'right') {
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

function realizeElement(el, free, parcelFt, parcelTurf, frame, centroid, profile, realized) {
  if (el.type === 'building') return realizeBuilding(el, free, parcelFt, frame, centroid, profile);
  if (el.type === 'parking')  return realizeParking(el, free, parcelFt, frame, centroid, profile, realized);
  if (el.type === 'driveway') return realizeDriveway(el, parcelFt, parcelTurf, frame, centroid, profile, realized);
  // Phase D+ types
  return {
    id: el.id, type: el.type, feasible: false,
    reason: `${el.type} not implemented (Phase C: building + parking + driveway only)`,
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

  // Topological sort on declared dependencies
  const order = topoSort(schema.elements);
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

  for (const id of order) {
    const el = elementMap[id];
    if (!el) continue;

    const result = realizeElement(el, free, parcelFt, parcelTurf, frame, centroid, profile, realized);
    realized[id] = result;
    results.push(result);

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
    } else if (result.feasible && result.type === 'parking') {
      // Parking: subtract clipped footprint + small gap buffer.
      const buf = turf.buffer(result.feature, profile.gapFt ?? 10, { units: 'feet' });
      if (buf) free = turf.difference(free, buf) ?? free;
    } else if (result.feasible && result.type === 'driveway') {
      // Driveways: subtract with a small buffer so buildings don't land in the lane.
      const buf = turf.buffer(result.feature, 3, { units: 'feet' });
      if (buf) free = turf.difference(free, buf) ?? free;
    }
  }

  return { elements: results, freeRemaining: free };
}
