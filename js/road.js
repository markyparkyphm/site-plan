// road.js — Overpass road detection for frontage auto-fill.
// Entry: detectRoad(parcelLatLng, centroid) → roadResult | null.
// Never throws — every failure path resolves to null.
// Turf is a CDN global ([lng,lat] WGS84 convention throughout).

import { toPoly } from './geometry.js';
import { computeScaleFactors } from './projection.js';

export const roadConfig = {
  overpassUrl:       'https://overpass-api.de/api/interpreter',
  bboxMarginFt:      300,   // expanded: catches roads set back from parcel edge
  maxDistFt:         500,   // generous: parcel vertices are the reference, not centroid
  maxBearingDiffDeg: 45,    // widened: handles diagonal parcel edges
  timeoutMs:         12000,
  retryTimeoutMs:    18000, // second attempt if first times out
  highwayExclude: [
    'footway', 'path', 'cycleway', 'steps',
    'pedestrian', 'track', 'bridleway', 'corridor',
  ],
};

async function overpassFetch(query, timeoutMs) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(roadConfig.overpassUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    `data=${encodeURIComponent(query)}`,
      signal:  controller.signal,
    });
    if (!res.ok) {
      console.warn(`[road.js] Overpass HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildQuery(south, west, north, east) {
  return [
    '[out:json][timeout:25];',
    `way["highway"](${south},${west},${north},${east});`,
    'out geom;',
  ].join('\n');
}

export async function detectRoad(parcelLatLng, centroid) {
  try {
    // 1. Build expanded bbox in degrees.
    const [minLng, minLat, maxLng, maxLat] = turf.bbox(toPoly(parcelLatLng));
    const { latToFt, lngToFt } = computeScaleFactors(centroid);
    const padLat = roadConfig.bboxMarginFt / latToFt;
    const padLng = roadConfig.bboxMarginFt / lngToFt;
    const south = minLat - padLat, west  = minLng - padLng;
    const north = maxLat + padLat, east  = maxLng + padLng;

    // 2. POST to Overpass; retry once with a longer timeout if the first attempt fails.
    let data = null;
    try {
      data = await overpassFetch(buildQuery(south, west, north, east), roadConfig.timeoutMs);
    } catch (e) {
      console.warn('[road.js] First Overpass attempt failed, retrying:', e.message);
    }
    if (!data) {
      try {
        data = await overpassFetch(buildQuery(south, west, north, east), roadConfig.retryTimeoutMs);
      } catch (e) {
        console.warn('[road.js] Retry also failed:', e.message);
        return null;
      }
    }
    if (!data) return null;

    // 3. Convert ways to Turf LineStrings; drop pedestrian types and <2-node ways.
    const roads = [];
    for (const el of (data.elements ?? [])) {
      if (el.type !== 'way') continue;
      if (!el.geometry || el.geometry.length < 2) continue;
      const hwType = el.tags?.highway ?? '';
      if (roadConfig.highwayExclude.includes(hwType)) continue;
      roads.push(turf.lineString(el.geometry.map(n => [n.lon, n.lat]), { highway: hwType, id: el.id }));
    }
    console.log(`[road.js] Overpass returned ${data.elements?.length ?? 0} elements, ${roads.length} usable ways`);
    if (roads.length === 0) return null;

    // 4. Collect all survivors that pass both gates; nearest wins.
    const centroidPt = turf.point([centroid.lng, centroid.lat]);

    // Parcel edges as [a, b] coordinate pairs for the parallelism gate.
    const ring        = parcelLatLng.map(p => [p.lng, p.lat]);
    const parcelEdges = ring.map((pt, i) => [pt, ring[(i + 1) % ring.length]]);

    // Pre-build parcel vertex points once for the distance gate.
    const parcelPts = parcelLatLng.map(p => turf.point([p.lng, p.lat]));

    const survivors = [];
    for (const road of roads) {
      const hwLabel = `way#${road.properties.id} (${road.properties.highway})`;
      // Distance gate uses nearest parcel vertex → road so large parcels don't falsely
      // exceed maxDistFt from the centroid alone.
      const nearest = turf.nearestPointOnLine(road, centroidPt, { units: 'feet' });
      const edgeDist = Math.min(...parcelPts.map(
        pt => turf.nearestPointOnLine(road, pt, { units: 'feet' }).properties.dist,
      ));
      if (edgeDist > roadConfig.maxDistFt) {
        console.log(`[road.js] ${hwLabel} DROPPED: edgeDist ${Math.round(edgeDist)} ft > max ${roadConfig.maxDistFt} ft`);
        continue;
      }

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
      if (diff > roadConfig.maxBearingDiffDeg) {
        console.log(`[road.js] ${hwLabel} DROPPED: bearing diff ${diff.toFixed(1)}° > max ${roadConfig.maxBearingDiffDeg}° (road ${Math.round(roadBearing)}°, edge ${Math.round(edgeBearing)}°)`);
        continue;
      }

      // 5. Snap centroid → nearest-point bearing to the nearest cardinal (N/E/S/W).
      const rawBearing = turf.bearing(centroidPt, nearest);
      const normalized = ((rawBearing % 360) + 360) % 360;
      const cardinal   = ['N', 'E', 'S', 'W'][Math.round(normalized / 90) % 4];

      console.log(`[road.js] ${hwLabel} PASSED: edgeDist ${Math.round(edgeDist)} ft, bearingDiff ${diff.toFixed(1)}°, cardinal ${cardinal}`);
      survivors.push({
        cardinal,
        road,
        nearest,
        distanceFt:     nearest.properties.dist,
        bearingDiffDeg: diff,
      });
    }
    if (survivors.length === 0) {
      console.warn('[road.js] All roads failed gates — returning null');
      return null;
    }

    // Deduplicate by cardinal — keep only the nearest survivor per direction.
    // A single road (e.g. N Eldridge Pkwy) can produce many OSM way segments that all
    // pass the gates; collapsing by cardinal gives one entry per parcel edge.
    const byCardinal = new Map();
    for (const s of survivors) {
      if (!byCardinal.has(s.cardinal) || s.distanceFt < byCardinal.get(s.cardinal).distanceFt) {
        byCardinal.set(s.cardinal, s);
      }
    }
    const deduped = [...byCardinal.values()].sort((a, b) => a.distanceFt - b.distanceFt);
    const best = deduped[0];

    // Build the stable §5 candidate list — one entry per cardinal direction.
    const candidates = deduped.map(s => ({
      cardinal:       s.cardinal,
      line:           s.road,
      nearestPt:      s.nearest,
      distanceFt:     s.distanceFt,
      bearingDiffDeg: s.bearingDiffDeg,
      source:         'overpass',
    }));

    return {
      cardinal:       best.cardinal,
      line:           best.road,
      nearestPt:      best.nearest,
      distanceFt:     best.distanceFt,
      bearingDiffDeg: best.bearingDiffDeg,
      source:         'overpass',
      candidates,     // all survivors sorted by distance; [0] is the winner
    };
  } catch (e) {
    console.warn('[road.js] detectRoad failed:', e);
    return null;
  }
}
