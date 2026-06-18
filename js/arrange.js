// Relational placement engine — Phase A: local frame, schema parser, topo-sort,
// and realizing a single building anchored to parcelFrontage.
//
// Entry point: realizeArrangement(schema, parcelLngLat, profile)
// Returns: { elements: [{id, type, feasible, reason?, ...geomFields}], freeRemaining }
//
// Buildings must stay rectangular → erode-and-fit (no clipping).
// Parking / driveway / basin tolerate clipping → Phase B+ implements them.

import { placeBuilding } from './solver.js';
import { computeCentroid, latLngToFeet } from './projection.js';
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
// Element realizers (Phase A: building → parcelFrontage only)
// ---------------------------------------------------------------------------

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

function realizeElement(el, free, parcelFt, frame, centroid, profile, _realized) {
  if (el.type === 'building') {
    return realizeBuilding(el, free, parcelFt, frame, centroid, profile);
  }
  // Phase B+ types
  return {
    id: el.id, type: el.type, feasible: false,
    reason: `${el.type} not implemented (Phase A: building only)`,
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

    const result = realizeElement(el, free, parcelFt, frame, centroid, profile, realized);
    realized[id] = result;
    results.push(result);

    // Subtract placed building footprint + clearance from free (mirrors solveLayout step 5).
    if (result.feasible && result.type === 'building') {
      const foot = rectPoly(
        result.center_x_ft, result.center_y_ft,
        result.length_ft, result.width_ft,
        result.orientation_deg, centroid
      );
      const buf = turf.buffer(foot, profile.clearanceFt ?? 30, { units: 'feet' });
      if (buf) free = turf.difference(free, buf) ?? free;
    }
  }

  return { elements: results, freeRemaining: free };
}
