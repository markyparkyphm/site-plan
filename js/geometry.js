// All Turf polygons use WGS84 [lng, lat] coordinates.
// Grid points and rectangle centers are in feet — pass centroid for conversions.

import { latLngToFeetFromCentroid, feetToLatLngFromCentroid, computeScaleFactors } from './projection.js';

// Create Turf Feature<Polygon> from [{lat,lng}] array
export function toPoly(latLngArray) {
  const ring = latLngArray.map(p => [p.lng, p.lat]);
  ring.push(ring[0]);
  return turf.polygon([ring]);
}

// Rotated rectangle in WGS84 from feet-space center + parcel centroid
export function rectPoly(cx_ft, cy_ft, lenFt, widFt, deg, centroid) {
  const rad = deg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = widFt / 2;
  const hl = lenFt / 2;

  const cornersFt = [
    { x: cx_ft - hl * cos + hw * sin, y: cy_ft - hl * sin - hw * cos },
    { x: cx_ft + hl * cos + hw * sin, y: cy_ft + hl * sin - hw * cos },
    { x: cx_ft + hl * cos - hw * sin, y: cy_ft + hl * sin + hw * cos },
    { x: cx_ft - hl * cos - hw * sin, y: cy_ft - hl * sin + hw * cos },
  ];

  const ring = cornersFt.map(p => {
    const ll = feetToLatLngFromCentroid(p, centroid);
    return [ll.lng, ll.lat];
  });
  ring.push(ring[0]);
  return turf.polygon([ring]);
}

export function polysOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Feature') {
    const g = geom.geometry;
    if (!g) return [];
    if (g.type === 'Polygon') return [geom];
    if (g.type === 'MultiPolygon') return g.coordinates.map(c => turf.polygon(c));
    return [];
  }
  if (geom.type === 'Polygon') return [turf.feature(geom)];
  if (geom.type === 'MultiPolygon') return geom.coordinates.map(c => turf.polygon(c));
  if (geom.type === 'FeatureCollection') return geom.features.flatMap(f => polysOf(f));
  return [];
}

export function biggestPoly(geom) {
  const polys = polysOf(geom);
  if (polys.length === 0) return null;
  return polys.reduce((best, p) => turf.area(p) > turf.area(best) ? p : best);
}

export function reach(lenFt, widFt) {
  return Math.hypot(lenFt, widFt) / 2;
}

// Sample a grid inside all pieces of a WGS84 Turf geometry; returns feet-space [{x,y}] points
export function gridPointsInside(geom, stepFt, centroid) {
  if (!geom) return [];
  const pieces = polysOf(geom);
  if (pieces.length === 0) return [];

  const s = computeScaleFactors(centroid);
  const stepLat = stepFt / s.latToFt;
  const stepLng = stepFt / s.lngToFt;

  const pts = [];
  for (const poly of pieces) {
    const [minLng, minLat, maxLng, maxLat] = turf.bbox(poly);
    for (let lng = minLng; lng <= maxLng; lng += stepLng) {
      for (let lat = minLat; lat <= maxLat; lat += stepLat) {
        if (turf.booleanPointInPolygon(turf.point([lng, lat]), poly)) {
          pts.push(latLngToFeetFromCentroid({ lat, lng }, centroid));
        }
      }
    }
  }
  return pts;
}
