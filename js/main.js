import { initMap, clearDrawing, getMap } from './map.js';
import { latLngToFeet, polygonAreaSqFt, sqFtToAcres, computeCentroid, feetToLatLngFromCentroid } from './projection.js';
import { toPoly, polysOf, rectPoly } from './geometry.js';
import { solveLayout } from './solver.js';
import { renderLayoutOnCanvas } from './render.js';
import { exportToPng } from './export.js';
import { parseInstructions } from './ai.js';

export let parcelLatLng = [];
export let parcelFt = [];
export let centroid = null;

let setbackOverlay = null;
let solveOverlays = [];
let lastLayout = null;
let aiHints = {};

export function init() {
  initMap('map', onBoundaryClosed);
  document.getElementById('btn-use-boundary').addEventListener('click', onUseBoundary);
  document.getElementById('btn-clear').addEventListener('click', onClear);
  document.getElementById('input-setback').addEventListener('change', onSetbackChange);
  document.getElementById('btn-solve').addEventListener('click', onSolve);
  document.getElementById('btn-add-building').addEventListener('click', addBuildingRow);
  document.getElementById('btn-render').addEventListener('click', onRender);
  document.getElementById('btn-export').addEventListener('click', onExport);
  document.getElementById('btn-close-canvas').addEventListener('click', () => {
    document.getElementById('canvas-panel').style.display = 'none';
  });
  document.getElementById('btn-ai-apply').addEventListener('click', onApplyAI);
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

async function onApplyAI() {
  const text = document.getElementById('input-ai').value.trim();
  if (!text) return;

  const statusEl = document.getElementById('ai-status');
  const btn = document.getElementById('btn-ai-apply');
  btn.disabled = true;
  statusEl.textContent = 'Thinking…';

  try {
    const hints = await parseInstructions(text);

    if (Object.keys(hints).length === 0) {
      statusEl.textContent = 'No recognised hints — try rephrasing.';
      return;
    }

    aiHints = { ...aiHints, ...hints };

    // Reflect changes back into visible UI controls
    if (hints.setbackFt !== undefined) {
      document.getElementById('input-setback').value = hints.setbackFt;
      if (parcelLatLng.length > 0) drawSetback();
    }
    if (hints.basinCorner !== undefined) {
      document.getElementById('input-basin-corner').value = hints.basinCorner;
    }

    const summary = Object.entries(hints).map(([k, v]) => `${k}: ${v}`).join(', ');
    statusEl.textContent = `Applied — ${summary}`;

    if (!document.getElementById('btn-solve').disabled) onSolve();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

function onSolve() {
  clearSolveOverlays();
  document.getElementById('status').textContent = 'Solving…';

  const hints = {
    setbackFt:             parseFloat(document.getElementById('input-setback').value) || 20,
    basinCorner:           document.getElementById('input-basin-corner').value,
    clearanceFt:           aiHints.clearanceFt ?? 30,
    orientationPreference: aiHints.orientationPreference ?? 'auto',
  };
  const reqs = {
    pondPct:        parseFloat(document.getElementById('input-pond-pct').value) || 15,
    buildings:      getBuildings(),
    parking_stalls: parseInt(document.getElementById('input-parking').value) || 0,
    driveways:      parseInt(document.getElementById('input-driveways').value) || 0,
  };

  const layout = solveLayout(parcelLatLng, reqs, hints);

  // Determinism self-check
  const layout2 = solveLayout(parcelLatLng, reqs, hints);
  const isDeterministic = JSON.stringify(layout.buildings) === JSON.stringify(layout2.buildings)
    && JSON.stringify(layout.detention_pond) === JSON.stringify(layout2.detention_pond);

  lastLayout = layout;
  renderLayout(layout, reqs, isDeterministic);
  document.getElementById('btn-render').disabled = false;
}

function renderLayout(layout, reqs, isDeterministic) {
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

  // Stats
  const parcelSqFt = polygonAreaSqFt(parcelFt);
  const parcelAcres = sqFtToAcres(parcelSqFt);
  const footprintSqFt = layout.buildings.reduce((s, b) => s + b.length_ft * b.width_ft, 0);
  const basinSqFt = layout.detention_pond ? turf.area(layout.detention_pond) * 10.7639 : 0;
  const basinAcres = basinSqFt > 0 ? sqFtToAcres(basinSqFt) : null;
  const stallCount = layout.parking_areas[0]?.properties?.stall_count ?? 0;

  document.getElementById('stat-parcel').textContent = `${parcelAcres.toFixed(2)} ac`;
  document.getElementById('stat-buildings').textContent =
    `${layout.buildings.length} / ${reqs.buildings.length}`;
  document.getElementById('stat-footprint').textContent = footprintSqFt > 0
    ? `${footprintSqFt.toLocaleString()} sq ft (${(footprintSqFt / parcelSqFt * 100).toFixed(1)}%)`
    : '—';
  document.getElementById('stat-basin').textContent = basinAcres
    ? `${basinAcres.toFixed(2)} ac (${(basinSqFt / parcelSqFt * 100).toFixed(1)}%)`
    : '—';
  document.getElementById('stat-parking').textContent = `${stallCount} stalls`;
  document.getElementById('stats-panel').style.display = 'flex';

  // Warnings
  const warningsEl = document.getElementById('warnings-panel');
  warningsEl.innerHTML = '';

  if (!isDeterministic) {
    const d = document.createElement('div');
    d.className = 'error-msg';
    d.textContent = '⚠ Solver produced different results on two runs — layout may not be stable.';
    warningsEl.appendChild(d);
  }

  layout.warnings.forEach(w => {
    const el = document.createElement('div');
    el.className = 'warning-msg';
    el.textContent = `⚠ ${w}`;
    warningsEl.appendChild(el);
  });

  document.getElementById('status').textContent = layout.warnings.length ? '' : 'Layout solved successfully.';

  if (layout.warnings.length) console.warn('[Solver]', layout.warnings);
}

function onRender() {
  if (!lastLayout || !parcelFt.length) return;
  const panel = document.getElementById('canvas-panel');
  panel.style.display = 'flex';
  // Read dimensions after browser lays out the panel
  requestAnimationFrame(async () => {
    const canvas = document.getElementById('render-canvas');
    canvas.width  = canvas.offsetWidth  || 900;
    canvas.height = canvas.offsetHeight || 650;
    await renderLayoutOnCanvas(canvas, parcelLatLng, lastLayout, centroid);
  });
}

function onExport() {
  const canvas = document.getElementById('render-canvas');
  exportToPng(canvas, 'site-plan.png');
}

function clearSolveOverlays() {
  solveOverlays.forEach(o => o.setMap(null));
  solveOverlays = [];
}

function onClear() {
  parcelLatLng = []; parcelFt = []; centroid = null;
  aiHints = {};
  clearSolveOverlays();
  if (setbackOverlay) { setbackOverlay.setMap(null); setbackOverlay = null; }
  document.getElementById('btn-use-boundary').disabled = true;
  document.getElementById('btn-solve').disabled = true;
  document.getElementById('acreage').textContent = '';
  document.getElementById('status').textContent = '';
  document.getElementById('ai-status').textContent = '';
  document.getElementById('stats-panel').style.display = 'none';
  document.getElementById('warnings-panel').innerHTML = '';
  clearDrawing();
}
