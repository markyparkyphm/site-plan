import { initMap, clearDrawing } from './map.js';
import { latLngToFeet, polygonAreaSqFt, sqFtToAcres } from './projection.js';

let parcelLatLng = [];
let parcelFt = [];

export function init() {
  initMap('map', onBoundaryClosed);
  document.getElementById('btn-use-boundary').addEventListener('click', onUseBoundary);
  document.getElementById('btn-clear').addEventListener('click', onClear);
}

function onBoundaryClosed(pts) {
  parcelLatLng = pts;
  parcelFt = latLngToFeet(pts);

  const acres = sqFtToAcres(polygonAreaSqFt(parcelFt));

  document.getElementById('btn-use-boundary').disabled = false;
  document.getElementById('acreage').textContent = `${acres.toFixed(2)} acres`;
  document.getElementById('status').textContent =
    `${pts.length} vertices captured. Click "Use Boundary" to confirm.`;

  console.log('[Phase 1] parcelFt:', parcelFt);
  console.log('[Phase 1] area:', acres.toFixed(4), 'acres');
}

function onUseBoundary() {
  document.getElementById('status').textContent =
    `Boundary confirmed. Ready for Phase 2.`;
  console.log('[Phase 1] Boundary confirmed. parcelLatLng:', parcelLatLng);
  console.log('[Phase 1] parcelFt:', parcelFt);
}

function onClear() {
  parcelLatLng = [];
  parcelFt = [];
  document.getElementById('btn-use-boundary').disabled = true;
  document.getElementById('acreage').textContent = '';
  document.getElementById('status').textContent = '';
  clearDrawing();
}
