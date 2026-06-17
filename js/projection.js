const METERS_PER_DEGREE_LAT = 111320;
const SQFT_PER_ACRE = 43560;
const FEET_PER_METER = 3.28084;

export function computeCentroid(parcelLatLng) {
  return {
    lat: parcelLatLng.reduce((s, p) => s + p.lat, 0) / parcelLatLng.length,
    lng: parcelLatLng.reduce((s, p) => s + p.lng, 0) / parcelLatLng.length,
  };
}

export function computeScaleFactors(centroid) {
  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos(centroid.lat * Math.PI / 180);
  return {
    latToFt: METERS_PER_DEGREE_LAT * FEET_PER_METER,
    lngToFt: metersPerDegreeLng * FEET_PER_METER,
  };
}

export function latLngToFeetFromCentroid(latLng, centroid) {
  const s = computeScaleFactors(centroid);
  return {
    x: (latLng.lng - centroid.lng) * s.lngToFt,
    y: (latLng.lat - centroid.lat) * s.latToFt,
  };
}

export function feetToLatLngFromCentroid(ptFt, centroid) {
  const s = computeScaleFactors(centroid);
  return {
    lat: centroid.lat + ptFt.y / s.latToFt,
    lng: centroid.lng + ptFt.x / s.lngToFt,
  };
}

export function latLngToFeet(parcelLatLng) {
  const centroid = computeCentroid(parcelLatLng);
  return parcelLatLng.map(p => latLngToFeetFromCentroid(p, centroid));
}

export function feetToLatLng(ptsFt, parcelLatLng) {
  const centroid = computeCentroid(parcelLatLng);
  return ptsFt.map(p => feetToLatLngFromCentroid(p, centroid));
}

export function acresToSqFt(acres) { return acres * SQFT_PER_ACRE; }
export function sqFtToAcres(sqFt) { return sqFt / SQFT_PER_ACRE; }

// Shoelace formula — area in sq ft from {x,y} feet points
export function polygonAreaSqFt(ptsFt) {
  let area = 0;
  const n = ptsFt.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += ptsFt[i].x * ptsFt[j].y;
    area -= ptsFt[j].x * ptsFt[i].y;
  }
  return Math.abs(area) / 2;
}
