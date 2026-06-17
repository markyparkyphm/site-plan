import { toPoly, biggestPoly, rectPoly, reach, gridPointsInside } from './geometry.js';
import { computeCentroid, latLngToFeetFromCentroid } from './projection.js';

// Entry point — called by main.js after boundary + reqs are set
export function solveLayout(parcelLatLng, reqs, hints) {
  const centroid = computeCentroid(parcelLatLng);
  const parcel = toPoly(parcelLatLng);
  const setback = hints.setbackFt ?? 20;
  const warnings = [];

  // 1. Buildable area
  const buildable = turf.buffer(parcel, -setback, { units: 'feet' });
  if (!buildable) return infeasible('Setback too large for this parcel.');

  // 2. Detention basin
  const parcelAreaSqFt = turf.area(parcel) * 10.7639;
  const targetSqFt = reqs.pondSqFt ?? (reqs.pondPct / 100) * parcelAreaSqFt;
  const basin = growCornerClip(buildable, hints.basinCorner ?? 'SW', targetSqFt, centroid);
  if (!basin) {
    warnings.push('Could not fit detention basin at target size.');
  }

  let free = buildable;
  if (basin) {
    const basinBuf = turf.buffer(basin, 5, { units: 'feet' });
    free = turf.difference(free, basinBuf) ?? free;
  }

  // 3. Parking
  const parkingSqFt = (reqs.parking_stalls ?? 0) * 325;
  let parking = null;
  if (parkingSqFt > 0) {
    parking = placeAlongSouthEdge(free, parkingSqFt, centroid);
    if (parking) {
      free = turf.difference(free, turf.buffer(parking, 5, { units: 'feet' })) ?? free;
    }
  }

  // 4. Driveways
  const driveways = [];
  if (parking && (reqs.driveways ?? 1) > 0) {
    const dws = makeDriveways(parcel, parking, reqs.driveways ?? 1, centroid);
    dws.forEach(d => {
      driveways.push(d);
      free = turf.difference(free, turf.buffer(d, 3, { units: 'feet' })) ?? free;
    });
  }

  // 5. Buildings — largest first, erosion placement
  const clearance = hints.clearanceFt ?? 30;
  const orientations = preferredOrientations(hints.orientationPreference);
  const buildings = [...(reqs.buildings ?? [])].sort(
    (a, b) => (b.length_ft * b.width_ft) - (a.length_ft * a.width_ft)
  );
  const N = buildings.length;
  const placedBuildings = [];

  buildings.forEach((b, i) => {
    let placed = null;

    for (const deg of orientations) {
      const r = reach(b.length_ft, b.width_ft);
      const legal = turf.buffer(free, -r, { units: 'feet' });
      if (!legal) continue;

      const cands = gridPointsInside(legal, 10, centroid);
      if (cands.length === 0) continue;

      const target = zoneCentroid(parcelLatLng, i, N, centroid);
      cands.sort((a, b) => dist2(a, target) - dist2(b, target));

      const c = cands[0];
      placed = { ...b, center_x_ft: c.x, center_y_ft: c.y, orientation_deg: deg };

      const foot = rectPoly(c.x, c.y, b.length_ft, b.width_ft, deg, centroid);
      const footBuf = turf.buffer(foot, clearance / 2, { units: 'feet' });
      if (footBuf) free = turf.difference(free, footBuf) ?? free;
      break;
    }

    if (!placed) {
      warnings.push(`${b.label} (${b.length_ft}×${b.width_ft} ft) does not fit.`);
    } else {
      placedBuildings.push(placed);
    }
  });

  return {
    buildings: placedBuildings,
    parking_areas: parking ? [parking] : [],
    driveways,
    detention_pond: basin ?? null,
    warnings,
    rationale: warnings.length ? warnings.join(' ') : 'All elements placed successfully.',
  };
}

// Binary-search a clip rectangle from the given corner until area ≈ target
function growCornerClip(buildable, corner, targetSqFt, centroid) {
  const [minLng, minLat, maxLng, maxLat] = turf.bbox(buildable);

  const anchorLng = corner.includes('E') ? maxLng : minLng;
  const anchorLat = corner.includes('N') ? maxLat : minLat;
  const oppLng    = corner.includes('E') ? minLng : maxLng;
  const oppLat    = corner.includes('N') ? minLat : maxLat;

  let lo = 0, hi = 1, best = null;

  for (let iter = 0; iter < 30; iter++) {
    const t = (lo + hi) / 2;
    const clipLng = anchorLng + t * (oppLng - anchorLng);
    const clipLat = anchorLat + t * (oppLat - anchorLat);

    const clipRect = turf.bboxPolygon([
      Math.min(anchorLng, clipLng), Math.min(anchorLat, clipLat),
      Math.max(anchorLng, clipLng), Math.max(anchorLat, clipLat),
    ]);

    const intersection = turf.intersect(buildable, clipRect);
    if (!intersection) { lo = t; continue; }

    const areaSqFt = turf.area(intersection) * 10.7639;
    const ratio = areaSqFt / targetSqFt;

    if (Math.abs(ratio - 1) < 0.05) { best = intersection; break; }
    if (ratio < 1) lo = t; else hi = t;
    best = intersection;
  }

  return best;
}

// Place a parking rectangle against the south edge of free using fixed 60 ft depth
function placeAlongSouthEdge(free, parkingSqFt, centroid) {
  const biggest = biggestPoly(free);
  if (!biggest) return null;

  const s = computeScaleApprox(centroid);
  const [minLng, minLat, maxLng] = turf.bbox(biggest);

  // Fixed 60 ft depth (2 rows + aisle); compute width needed
  const depthFt = 60;
  const depthDeg = depthFt / s.latToFt;
  const widthFt = parkingSqFt / depthFt;
  const widthDeg = widthFt / s.lngToFt;

  // Center the parking rectangle along the south edge
  const centerLng = (minLng + maxLng) / 2;
  const parkingPoly = turf.bboxPolygon([
    centerLng - widthDeg / 2, minLat,
    centerLng + widthDeg / 2, minLat + depthDeg,
  ]);

  const clipped = turf.intersect(biggest, parkingPoly);

  const actualSqFt = clipped ? turf.area(clipped) * 10.7639 : 0;
  const stallCount = Math.floor(actualSqFt / 325);

  if (!clipped || stallCount < 1) return null;

  // Compute center in feet for the output schema
  const [cMinLng, cMinLat, cMaxLng, cMaxLat] = turf.bbox(clipped);
  const cx_ft = latLngToFeetFromCentroid({ lat: (cMinLat + cMaxLat) / 2, lng: (cMinLng + cMaxLng) / 2 }, centroid).x;
  const cy_ft = latLngToFeetFromCentroid({ lat: (cMinLat + cMaxLat) / 2, lng: (cMinLng + cMaxLng) / 2 }, centroid).y;

  clipped.properties = { center_x_ft: cx_ft, center_y_ft: cy_ft, orientation_deg: 0, stall_count: stallCount };
  return clipped;
}

function makeDriveways(parcel, parking, count, centroid) {
  const [pMinLng, pMinLat, pMaxLng] = turf.bbox(parking);
  const [,  parMinLat] = turf.bbox(parcel);
  const driveways = [];
  const drivewayWidthDeg = 24 / computeScaleApprox(centroid).lngToFt;

  for (let i = 0; i < count; i++) {
    const offset = (i + 1) / (count + 1);
    const centerLng = pMinLng + offset * (pMaxLng - pMinLng);
    const dw = turf.bboxPolygon([
      centerLng - drivewayWidthDeg / 2, parMinLat,
      centerLng + drivewayWidthDeg / 2, pMinLat,
    ]);
    const clipped = turf.intersect(parcel, dw);
    if (clipped) driveways.push(clipped);
  }
  return driveways;
}

function preferredOrientations(pref) {
  if (pref === 'NS') return [0, 90];
  if (pref === 'EW') return [90, 0];
  return [0, 90];
}

function zoneCentroid(parcelLatLng, i, N, centroid) {
  if (N <= 1) return { x: 0, y: 0 };
  const lngs = parcelLatLng.map(p => p.lng);
  const lats = parcelLatLng.map(p => p.lat);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const t = (i + 0.5) / N;
  const lng = minLng + t * (maxLng - minLng);
  const lat = (minLat + maxLat) / 2;
  return latLngToFeetFromCentroid({ lat, lng }, centroid);
}

function dist2(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function computeScaleApprox(centroid) {
  const METERS_PER_DEGREE_LAT = 111320;
  const FEET_PER_METER = 3.28084;
  return {
    latToFt: METERS_PER_DEGREE_LAT * FEET_PER_METER,
    lngToFt: METERS_PER_DEGREE_LAT * Math.cos(centroid.lat * Math.PI / 180) * FEET_PER_METER,
  };
}

function infeasible(reason) {
  return { buildings: [], parking_areas: [], driveways: [], detention_pond: null,
           warnings: [reason], rationale: reason };
}
