import { toPoly, biggestPoly, rectPoly, reach, gridPointsInside } from './geometry.js';
import { computeCentroid, latLngToFeetFromCentroid, computeScaleFactors } from './projection.js';

// Resolve the working frontage from hints; 'auto' defaults to 'S' until detection lands
function resolveFrontage(parcelLatLng, hints) {
  if (['N', 'S', 'E', 'W'].includes(hints.frontage)) return hints.frontage;
  return 'S';
}

const FRONTAGE_TO_BASIN_CORNER = { S: 'NE', N: 'SW', W: 'SE', E: 'NW' };

// Entry point — called by main.js after boundary + reqs are set
export function solveLayout(parcelLatLng, reqs, hints) {
  const centroid = computeCentroid(parcelLatLng);
  const parcel = toPoly(parcelLatLng);
  const setback = hints.setbackFt ?? 20;
  const frontage = resolveFrontage(parcelLatLng, hints);
  const warnings = [];

  // 1. Buildable area
  const buildable = turf.buffer(parcel, -setback, { units: 'feet' });
  if (!buildable) return infeasible('Setback too large for this parcel.');

  // 2. Detention basin — default corner is opposite the frontage edge
  const parcelAreaSqFt = turf.area(parcel) * 10.7639;
  const targetSqFt = reqs.pondSqFt ?? (reqs.pondPct / 100) * parcelAreaSqFt;
  const basinCorner = hints.basinCorner ?? FRONTAGE_TO_BASIN_CORNER[frontage];
  const basin = growCornerClip(buildable, basinCorner, targetSqFt, centroid);
  if (!basin) {
    warnings.push('Could not fit detention basin at target size.');
  } else {
    const basinAreaSqFt = turf.area(basin) * 10.7639;
    if (basinAreaSqFt < targetSqFt * 0.9) {
      warnings.push(`Basin undersized: got ${Math.round(basinAreaSqFt).toLocaleString()} sq ft, target ${Math.round(targetSqFt).toLocaleString()} sq ft.`);
    }
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
    parking = placeAlongFrontageEdge(free, parkingSqFt, centroid, frontage);
    if (parking) {
      free = turf.difference(free, turf.buffer(parking, 5, { units: 'feet' })) ?? free;
    }
  }

  // 4. Driveways
  const driveways = [];
  if (parking && (reqs.driveways ?? 1) > 0) {
    const dws = makeDriveways(parcel, parking, reqs.driveways ?? 1, centroid, frontage);
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
      cands.sort((a, b) => dist2(a, target) - dist2(b, target) || a.y - b.y || a.x - b.x);

      const c = cands[0];
      placed = { ...b, center_x_ft: c.x, center_y_ft: c.y, orientation_deg: deg };

      const foot = rectPoly(c.x, c.y, b.length_ft, b.width_ft, deg, centroid);
      const footBuf = turf.buffer(foot, clearance, { units: 'feet' });
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

// Place a parking block against the frontage edge of free, 60 ft deep, clipped to free
function placeAlongFrontageEdge(free, parkingSqFt, centroid, frontage) {
  const biggest = biggestPoly(free);
  if (!biggest) return null;

  const s = computeScaleFactors(centroid);
  const [minLng, minLat, maxLng, maxLat] = turf.bbox(biggest);
  const depthFt = 60;
  let parkingPoly;
  let orientationDeg = 0;

  if (frontage === 'S') {
    const depthDeg = depthFt / s.latToFt;
    const widthDeg = (parkingSqFt / depthFt) / s.lngToFt;
    const centerLng = (minLng + maxLng) / 2;
    parkingPoly = turf.bboxPolygon([
      centerLng - widthDeg / 2, minLat,
      centerLng + widthDeg / 2, minLat + depthDeg,
    ]);
  } else if (frontage === 'N') {
    const depthDeg = depthFt / s.latToFt;
    const widthDeg = (parkingSqFt / depthFt) / s.lngToFt;
    const centerLng = (minLng + maxLng) / 2;
    parkingPoly = turf.bboxPolygon([
      centerLng - widthDeg / 2, maxLat - depthDeg,
      centerLng + widthDeg / 2, maxLat,
    ]);
  } else if (frontage === 'W') {
    const depthDeg = depthFt / s.lngToFt;
    const widthDeg = (parkingSqFt / depthFt) / s.latToFt;
    const centerLat = (minLat + maxLat) / 2;
    // Sample the actual free-space west extent at centerLat; the bbox minLng may
    // be at a corner far from where the boundary sits at this latitude.
    const band = turf.bboxPolygon([minLng - 1, centerLat - 50 / s.latToFt, maxLng + 1, centerLat + 50 / s.latToFt]);
    const freeAtCenter = turf.intersect(biggest, band);
    const edgeLng = freeAtCenter ? turf.bbox(freeAtCenter)[0] : minLng;
    parkingPoly = turf.bboxPolygon([
      edgeLng, centerLat - widthDeg / 2,
      edgeLng + depthDeg, centerLat + widthDeg / 2,
    ]);
    orientationDeg = 90;
  } else { // 'E'
    const depthDeg = depthFt / s.lngToFt;
    const widthDeg = (parkingSqFt / depthFt) / s.latToFt;
    const centerLat = (minLat + maxLat) / 2;
    // Sample the actual free-space east extent at centerLat; the bbox maxLng may
    // be at a corner far from where the boundary sits at this latitude.
    const band = turf.bboxPolygon([minLng - 1, centerLat - 50 / s.latToFt, maxLng + 1, centerLat + 50 / s.latToFt]);
    const freeAtCenter = turf.intersect(biggest, band);
    const edgeLng = freeAtCenter ? turf.bbox(freeAtCenter)[2] : maxLng;
    parkingPoly = turf.bboxPolygon([
      edgeLng - depthDeg, centerLat - widthDeg / 2,
      edgeLng, centerLat + widthDeg / 2,
    ]);
    orientationDeg = 90;
  }

  const clipped = turf.intersect(biggest, parkingPoly);
  const actualSqFt = clipped ? turf.area(clipped) * 10.7639 : 0;
  const stallCount = Math.floor(actualSqFt / 325);
  if (!clipped || stallCount < 1) return null;

  const [cMinLng, cMinLat, cMaxLng, cMaxLat] = turf.bbox(clipped);
  const cx_ft = latLngToFeetFromCentroid({ lat: (cMinLat + cMaxLat) / 2, lng: (cMinLng + cMaxLng) / 2 }, centroid).x;
  const cy_ft = latLngToFeetFromCentroid({ lat: (cMinLat + cMaxLat) / 2, lng: (cMinLng + cMaxLng) / 2 }, centroid).y;
  clipped.properties = { center_x_ft: cx_ft, center_y_ft: cy_ft, orientation_deg: orientationDeg, stall_count: stallCount };
  return clipped;
}

// Driveway strips from the frontage edge of the parcel inward to the parking block.
// For S/N: simple bbox strip (parcel south/north edge is typically axis-aligned).
// For E/W: intersect the lat strip with the actual parcel polygon then subtract the
// buildable zone — this correctly follows slanted parcel boundaries instead of
// anchoring to a bbox max/min that may be outside the parcel at the driveway latitude.
function makeDriveways(parcel, parking, count, centroid, frontage) {
  const s = computeScaleFactors(centroid);
  const [pMinLng, pMinLat, pMaxLng, pMaxLat] = turf.bbox(parking);
  const [parMinLng, parMinLat, parMaxLng, parMaxLat] = turf.bbox(parcel);
  const driveways = [];
  const BIG = 1; // 1 degree — safely beyond any parcel

  if (frontage === 'S' || frontage === 'N') {
    const widthDeg = 24 / s.lngToFt;
    const outerLat = frontage === 'S' ? parMinLat : parMaxLat;
    const innerLat = frontage === 'S' ? pMinLat   : pMaxLat;
    for (let i = 0; i < count; i++) {
      const offset = (i + 1) / (count + 1);
      const centerLng = pMinLng + offset * (pMaxLng - pMinLng);
      const dw = turf.bboxPolygon([
        centerLng - widthDeg / 2, Math.min(innerLat, outerLat),
        centerLng + widthDeg / 2, Math.max(innerLat, outerLat),
      ]);
      const clipped = turf.intersect(parcel, dw);
      if (clipped) driveways.push(clipped);
    }
  } else { // 'W' or 'E'
    const widthDeg = 24 / s.latToFt;

    for (let i = 0; i < count; i++) {
      const offset = (i + 1) / (count + 1);
      const centerLat = pMinLat + offset * (pMaxLat - pMinLat);

      // Slice both parcel and parking at this lat — the parking cross-section
      // gives the actual inner boundary at this specific latitude, avoiding the
      // bbox-anchor bug that clips away the driveway on slanted boundaries.
      const latStrip = turf.bboxPolygon([
        parMinLng - BIG, centerLat - widthDeg / 2,
        parMaxLng + BIG, centerLat + widthDeg / 2,
      ]);
      const parcelCross = turf.intersect(parcel, latStrip);
      if (!parcelCross) continue;

      const parkingCross = turf.intersect(parking, latStrip);
      let innerLng;
      if (parkingCross) {
        const pkBbox = turf.bbox(parkingCross);
        innerLng = frontage === 'E' ? pkBbox[2] : pkBbox[0];
      } else {
        innerLng = (parMinLng + parMaxLng) / 2; // fallback: parcel centre
      }

      const roadSide = turf.bboxPolygon(
        frontage === 'E'
          ? [innerLng, centerLat - BIG, parMaxLng + BIG, centerLat + BIG]
          : [parMinLng - BIG, centerLat - BIG, innerLng, centerLat + BIG]
      );
      const dw = turf.intersect(parcelCross, roadSide);
      if (dw) driveways.push(dw);
    }
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
  const s = computeScaleFactors(centroid);
  const lngs = parcelLatLng.map(p => p.lng);
  const lats = parcelLatLng.map(p => p.lat);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const widthFt  = (maxLng - minLng) * s.lngToFt;
  const heightFt = (maxLat - minLat) * s.latToFt;
  const t = (i + 0.5) / N;
  const lng = widthFt >= heightFt ? minLng + t * (maxLng - minLng) : (minLng + maxLng) / 2;
  const lat = widthFt >= heightFt ? (minLat + maxLat) / 2 : minLat + t * (maxLat - minLat);
  return latLngToFeetFromCentroid({ lat, lng }, centroid);
}

function dist2(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function infeasible(reason) {
  return { buildings: [], parking_areas: [], driveways: [], detention_pond: null,
           warnings: [reason], rationale: reason };
}
