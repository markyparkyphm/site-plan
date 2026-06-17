import { initMap, clearDrawing, getMap } from './map.js';
import { latLngToFeet, polygonAreaSqFt, sqFtToAcres, computeCentroid } from './projection.js';
import { toPoly, polysOf } from './geometry.js';

export let parcelLatLng = [];
export let parcelFt = [];
export let centroid = null;
let setbackOverlay = null;

export function init() {
  initMap('map', onBoundaryClosed);
  document.getElementById('btn-use-boundary').addEventListener('click', onUseBoundary);
  document.getElementById('btn-clear').addEventListener('click', onClear);
  document.getElementById('input-setback').addEventListener('change', onSetbackChange);
}

function onBoundaryClosed(pts) {
  parcelLatLng = pts;
  parcelFt = latLngToFeet(pts);
  centroid = computeCentroid(pts);

  const acres = sqFtToAcres(polygonAreaSqFt(parcelFt));
  document.getElementById('btn-use-boundary').disabled = false;
  document.getElementById('acreage').textContent = `${acres.toFixed(2)} acres`;
  document.getElementById('status').textContent =
    `${pts.length} vertices captured. Click "Use Boundary" to confirm.`;

  drawSetback();
}

function onUseBoundary() {
  document.getElementById('status').textContent = 'Boundary confirmed. Ready for Phase 2.';
}

function onSetbackChange() {
  if (parcelLatLng.length > 0) drawSetback();
}

function drawSetback() {
  const map = getMap();
  if (!map) return;

  if (setbackOverlay) { setbackOverlay.setMap(null); setbackOverlay = null; }

  const setbackFt = parseFloat(document.getElementById('input-setback').value) || 20;

  // Use WGS84 lat/lng polygon so turf.buffer works correctly
  const parcelPoly = toPoly(parcelLatLng);
  const buildable = turf.buffer(parcelPoly, -setbackFt, { units: 'feet' });

  if (!buildable) {
    document.getElementById('status').textContent =
      'Setback too large — nothing buildable remains.';
    return;
  }

  // Extract WGS84 [lng,lat] coordinates and convert to Google Maps {lat,lng} paths
  const paths = polysOf(buildable).map(poly =>
    poly.geometry.coordinates[0].map(([lng, lat]) => ({ lat, lng }))
  );

  setbackOverlay = new google.maps.Polygon({
    paths,
    map,
    strokeColor: '#60a5fa',
    strokeWeight: 1.5,
    strokeOpacity: 0.8,
    fillColor: '#60a5fa',
    fillOpacity: 0.08,
  });

  const buildableAcres = turf.area(buildable) / 4046.86;
  document.getElementById('status').textContent =
    `Setback: ${setbackFt} ft  |  Buildable: ${buildableAcres.toFixed(2)} ac`;
}

function onClear() {
  parcelLatLng = [];
  parcelFt = [];
  centroid = null;
  if (setbackOverlay) { setbackOverlay.setMap(null); setbackOverlay = null; }
  document.getElementById('btn-use-boundary').disabled = true;
  document.getElementById('acreage').textContent = '';
  document.getElementById('status').textContent = '';
  clearDrawing();
}
