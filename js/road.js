// road.js — Overpass road detection for frontage auto-fill.
// Entry: detectRoad(parcelLatLng, centroid) → roadResult | null.
// Never throws — every failure path resolves to null.
// Turf is a CDN global ([lng,lat] WGS84 convention throughout).

import { toPoly } from './geometry.js';
import { computeScaleFactors } from './projection.js';

export const roadConfig = {
  overpassUrl:       'https://overpass-api.de/api/interpreter',
  bboxMarginFt:      150,
  maxDistFt:         300,
  maxBearingDiffDeg: 35,
  timeoutMs:         8000,
  highwayExclude: [
    'footway', 'path', 'cycleway', 'steps',
    'pedestrian', 'track', 'bridleway', 'corridor',
  ],
};

export async function detectRoad(parcelLatLng, centroid) {
  try {
    // 1. Build expanded bbox in degrees.
    const [minLng, minLat, maxLng, maxLat] = turf.bbox(toPoly(parcelLatLng));
    const { latToFt, lngToFt } = computeScaleFactors(centroid);
    const padLat = roadConfig.bboxMarginFt / latToFt;
    const padLng = roadConfig.bboxMarginFt / lngToFt;
    const south = minLat - padLat, west  = minLng - padLng;
    const north = maxLat + padLat, east  = maxLng + padLng;

    // 2. POST to Overpass (bbox order: south,west,north,east = minLat,minLng,maxLat,maxLng).
    const query = [
      '[out:json][timeout:25];',
      `way["highway"](${south},${west},${north},${east});`,
      'out geom;',
    ].join('\n');

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), roadConfig.timeoutMs);
    let data;
    try {
      const res = await fetch(roadConfig.overpassUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    `data=${encodeURIComponent(query)}`,
        signal:  controller.signal,
      });
      if (!res.ok) return null;
      data = await res.json();
    } finally {
      clearTimeout(timeoutId);
    }

    // 3. Convert ways to Turf LineStrings; drop pedestrian types and <2-node ways.
    const roads = [];
    for (const el of (data.elements ?? [])) {
      if (el.type !== 'way') continue;
      if (!el.geometry || el.geometry.length < 2) continue;
      if (roadConfig.highwayExclude.includes(el.tags?.highway ?? '')) continue;
      roads.push(turf.lineString(el.geometry.map(n => [n.lon, n.lat])));
    }
    if (roads.length === 0) return null;

    // 4. Pick the nearest most-parallel road.
    const centroidPt = turf.point([centroid.lng, centroid.lat]);

    // Parcel edges as [a, b] coordinate pairs for the parallelism gate.
    const ring        = parcelLatLng.map(p => [p.lng, p.lat]);
    const parcelEdges = ring.map((pt, i) => [pt, ring[(i + 1) % ring.length]]);

    // Pre-build parcel vertex points once for the distance gate.
    const parcelPts = parcelLatLng.map(p => turf.point([p.lng, p.lat]));

    let best = null;
    for (const road of roads) {
      // Cardinal snap uses centroid → road (spec). Distance gate uses nearest parcel
      // vertex → road so large parcels don't falsely exceed maxDistFt from the centroid.
      const nearest = turf.nearestPointOnLine(road, centroidPt, { units: 'feet' });
      const edgeDist = Math.min(...parcelPts.map(
        pt => turf.nearestPointOnLine(road, pt, { units: 'feet' }).properties.dist,
      ));
      if (edgeDist > roadConfig.maxDistFt) continue;

      // Road segment bearing at the nearest-point segment index.
      const coords  = road.geometry.coordinates;
      const segIdx  = Math.min(nearest.properties.index, coords.length - 2);
      const roadBearing = turf.bearing(
        turf.point(coords[segIdx]),
        turf.point(coords[segIdx + 1]),
      );

      // Nearest parcel edge to the road's nearest point.
      const nPt = nearest.geometry.coordinates;
      let closestEdge = null, closestEdgeDist = Infinity;
      for (const [a, b] of parcelEdges) {
        const ep = turf.nearestPointOnLine(
          turf.lineString([a, b]), turf.point(nPt), { units: 'feet' },
        );
        if (ep.properties.dist < closestEdgeDist) {
          closestEdgeDist = ep.properties.dist;
          closestEdge = [a, b];
        }
      }
      const edgeBearing = turf.bearing(
        turf.point(closestEdge[0]),
        turf.point(closestEdge[1]),
      );

      // Fold bearing difference to 0–90 and reject non-parallel roads.
      let diff = Math.abs(roadBearing - edgeBearing) % 180;
      if (diff > 90) diff = 180 - diff;
      if (diff > roadConfig.maxBearingDiffDeg) continue;

      const centroidDistFt = nearest.properties.dist;
      if (!best || centroidDistFt < best.distanceFt) {
        best = { road, nearest, distanceFt: centroidDistFt, bearingDiffDeg: diff };
      }
    }
    if (!best) return null;

    // 5. Snap bearing from centroid → nearest point to the nearest cardinal (N/E/S/W).
    const rawBearing = turf.bearing(centroidPt, best.nearest);
    const normalized = ((rawBearing % 360) + 360) % 360;
    const cardinal   = ['N', 'E', 'S', 'W'][Math.round(normalized / 90) % 4];

    return {
      cardinal:      cardinal,
      line:          best.road,
      nearestPt:     best.nearest,
      distanceFt:    best.distanceFt,
      bearingDiffDeg: best.bearingDiffDeg,
      source:        'overpass',
    };
  } catch (e) {
    console.warn('[road.js] detectRoad failed:', e);
    return null;
  }
}
