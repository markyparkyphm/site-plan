const METERS_PER_DEGREE_LAT = 111320;
const SQFT_PER_ACRE = 43560;

export function latLngToFeet(parcelLatLng) {
  const latSum = parcelLatLng.reduce((s, p) => s + p.lat, 0);
  const lngSum = parcelLatLng.reduce((s, p) => s + p.lng, 0);
  const centroidLat = latSum / parcelLatLng.length;
  const centroidLng = lngSum / parcelLatLng.length;

  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos(centroidLat * Math.PI / 180);
  const FEET_PER_METER = 3.28084;

  return parcelLatLng.map(p => ({
    x: (p.lng - centroidLng) * metersPerDegreeLng * FEET_PER_METER,
    y: (p.lat - centroidLat) * METERS_PER_DEGREE_LAT * FEET_PER_METER,
  }));
}

export function feetToLatLng(ptsFt, parcelLatLng) {
  const latSum = parcelLatLng.reduce((s, p) => s + p.lat, 0);
  const lngSum = parcelLatLng.reduce((s, p) => s + p.lng, 0);
  const centroidLat = latSum / parcelLatLng.length;
  const centroidLng = lngSum / parcelLatLng.length;

  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos(centroidLat * Math.PI / 180);
  const FEET_PER_METER = 3.28084;

  return ptsFt.map(p => ({
    lat: centroidLat + p.y / (METERS_PER_DEGREE_LAT * FEET_PER_METER),
    lng: centroidLng + p.x / (metersPerDegreeLng * FEET_PER_METER),
  }));
}

export function acresToSqFt(acres) {
  return acres * SQFT_PER_ACRE;
}

export function sqFtToAcres(sqFt) {
  return sqFt / SQFT_PER_ACRE;
}

// Shoelace formula — area in sq ft from {x,y} points
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
