import { initMap, clearDrawing, getMap } from './map.js';
import { latLngToFeet, polygonAreaSqFt, sqFtToAcres, computeCentroid, feetToLatLngFromCentroid } from './projection.js';
import { toPoly, polysOf, rectPoly } from './geometry.js';
import { solveLayout } from './solver.js';

export let parcelLatLng = [];
export let parcelFt = [];
export let centroid = null;

let setbackOverlay = null;
let solveOverlays = [];

export function init() {
  initMap('map', onBoundaryClosed);
  document.getElementById('btn-use-boundary').addEventListener('click', onUseBoundary);
  document.getElementById('btn-clear').addEventListener('click', onClear);
  document.getElementById('input-setback').addEventListener('change', onSetbackChange);
  document.getElementById('btn-solve').addEventListener('click', onSolve);
  document.getElementById('btn-add-building').addEventListener('click', addBuildingRow);
}

function addBuildingRow() {
  const list = document.getElementById('buildings-list');
  if (list.children.length >= 5) return;
  const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const label = labels[list.children.length] ?? String(list.children.length + 1);
  const row = document.createElement('div');
  row.className = 'building-row';
  row.innerHTML = `
    <input class="b-label" type="text"   placeholder="Label" value="${label}">
    <input class="b-len"   type="number" placeholder="L ft"  value="150" min="10">
    <input class="b-wid"   type="number" placeholder="W ft"  value="80"  min="10">
  `;
  list.appendChild(row);
}

function getBuildings() {
  return Array.from(document.querySelectorAll('.building-row')).map(row => ({
    label:    row.querySelector('.b-label').value.trim() || '?',
    length_ft: parseFloat(row.querySelector('.b-len').value) || 100,
    width_ft:  parseFloat(row.querySelector('.b-wid').value) || 60,
  }));
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
  document.getElementById('btn-solve').disabled = false;
  document.getElementById('status').textContent = 'Boundary confirmed. Fill in the program and click "Solve Layout".';
}

function onSetbackChange() {
  if (parcelLatLng.length > 0) drawSetback();
}

function drawSetback() {
  const map = getMap();
  if (!map) return;
  if (setbackOverlay) { setbackOverlay.setMap(null); setbackOverlay = null; }

  const setbackFt = parseFloat(document.getElementById('input-setback').value) || 20;
  const buildable = turf.buffer(toPoly(parcelLatLng), -setbackFt, { units: 'feet' });
  if (!buildable) {
    document.getElementById('status').textContent = 'Setback too large — nothing buildable remains.';
    return;
  }

  const paths = polysOf(buildable).map(poly =>
    poly.geometry.coordinates[0].map(([lng, lat]) => ({ lat, lng }))
  );
  setbackOverlay = new google.maps.Polygon({
    paths, map,
    strokeColor: '#60a5fa', strokeWeight: 1.5, strokeOpacity: 0.8,
    fillColor: '#60a5fa', fillOpacity: 0.08,
  });

  const buildableAcres = turf.area(buildable) / 4046.86;
  document.getElementById('status').textContent =
    `Setback: ${setbackFt} ft  |  Buildable: ${buildableAcres.toFixed(2)} ac`;
}

function onSolve() {
  clearSolveOverlays();
  document.getElementById('status').textContent = 'Solving…';

  const hints = {
    setbackFt:   parseFloat(document.getElementById('input-setback').value) || 20,
    basinCorner: document.getElementById('input-basin-corner').value,
    clearanceFt: 30,
  };
  const reqs = {
    pondPct:        parseFloat(document.getElementById('input-pond-pct').value) || 15,
    buildings:      getBuildings(),
    parking_stalls: parseInt(document.getElementById('input-parking').value) || 0,
    driveways:      parseInt(document.getElementById('input-driveways').value) || 0,
  };

  const layout = solveLayout(parcelLatLng, reqs, hints);
  renderLayout(layout);
}

function renderLayout(layout) {
  const map = getMap();

  // Basin — blue-green
  if (layout.detention_pond) {
    polysOf(layout.detention_pond).forEach(poly => {
      solveOverlays.push(new google.maps.Polygon({
        paths: poly.geometry.coordinates[0].map(([lng, lat]) => ({ lat, lng })),
        map, strokeColor: '#06b6d4', strokeWeight: 2,
        fillColor: '#06b6d4', fillOpacity: 0.35,
      }));
    });
  }

  // Parking — yellow
  layout.parking_areas.forEach(p => {
    polysOf(p).forEach(poly => {
      solveOverlays.push(new google.maps.Polygon({
        paths: poly.geometry.coordinates[0].map(([lng, lat]) => ({ lat, lng })),
        map, strokeColor: '#fbbf24', strokeWeight: 2,
        fillColor: '#fbbf24', fillOpacity: 0.35,
      }));
    });
  });

  // Driveways — orange
  layout.driveways.forEach(d => {
    polysOf(d).forEach(poly => {
      solveOverlays.push(new google.maps.Polygon({
        paths: poly.geometry.coordinates[0].map(([lng, lat]) => ({ lat, lng })),
        map, strokeColor: '#f97316', strokeWeight: 2,
        fillColor: '#f97316', fillOpacity: 0.35,
      }));
    });
  });

  // Buildings — red with label
  layout.buildings.forEach(b => {
    const foot = rectPoly(b.center_x_ft, b.center_y_ft, b.length_ft, b.width_ft, b.orientation_deg, centroid);
    polysOf(foot).forEach(poly => {
      solveOverlays.push(new google.maps.Polygon({
        paths: poly.geometry.coordinates[0].map(([lng, lat]) => ({ lat, lng })),
        map, strokeColor: '#ef4444', strokeWeight: 2,
        fillColor: '#ef4444', fillOpacity: 0.5,
      }));
    });

    // Label marker at building center
    const centerLatLng = feetToLatLngFromCentroid({ x: b.center_x_ft, y: b.center_y_ft }, centroid);
    solveOverlays.push(new google.maps.Marker({
      position: centerLatLng,
      map,
      label: { text: `${b.label}\n${b.length_ft}×${b.width_ft}ft`, color: '#fff', fontSize: '11px' },
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 0 },
    }));
  });

  const basinAcres = layout.detention_pond
    ? (turf.area(layout.detention_pond) * 10.7639 / 43560).toFixed(2) + ' ac' : '—';
  const stallCount = layout.parking_areas[0]?.properties?.stall_count ?? 0;

  document.getElementById('status').textContent = layout.warnings.length
    ? layout.rationale
    : `Basin: ${basinAcres}  |  Parking: ${stallCount} stalls  |  Buildings: ${layout.buildings.length}`;

  if (layout.warnings.length) console.warn('[Solver]', layout.warnings);
  console.log('[Phase 5] layout:', layout);
}

function clearSolveOverlays() {
  solveOverlays.forEach(o => o.setMap(null));
  solveOverlays = [];
}

function onClear() {
  parcelLatLng = []; parcelFt = []; centroid = null;
  clearSolveOverlays();
  if (setbackOverlay) { setbackOverlay.setMap(null); setbackOverlay = null; }
  document.getElementById('btn-use-boundary').disabled = true;
  document.getElementById('btn-solve').disabled = true;
  document.getElementById('acreage').textContent = '';
  document.getElementById('status').textContent = '';
  clearDrawing();
}
