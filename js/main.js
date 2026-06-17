import { initMap, clearDrawing } from './map.js';

let parcelLatLng = [];

export function init() {
  initMap('map', onBoundaryClosed);
  document.getElementById('btn-use-boundary').addEventListener('click', onUseBoundary);
  document.getElementById('btn-clear').addEventListener('click', onClear);
}

function onBoundaryClosed(pts) {
  parcelLatLng = pts;
  document.getElementById('btn-use-boundary').disabled = false;
  document.getElementById('status').textContent =
    `${pts.length} vertices captured. Click "Use Boundary" to confirm.`;
  console.log('[Phase 0] parcelLatLng:', JSON.stringify(parcelLatLng, null, 2));
}

function onUseBoundary() {
  document.getElementById('status').textContent =
    `Boundary confirmed: ${parcelLatLng.length} points. Ready for Phase 1.`;
  console.log('[Phase 0] Boundary confirmed:', parcelLatLng);
}

function onClear() {
  parcelLatLng = [];
  document.getElementById('btn-use-boundary').disabled = true;
  document.getElementById('status').textContent = '';
  clearDrawing();
}
