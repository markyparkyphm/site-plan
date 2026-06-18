import { initMap, clearDrawing, getMap } from './map.js';
import { latLngToFeet, polygonAreaSqFt, sqFtToAcres, computeCentroid, feetToLatLngFromCentroid } from './projection.js';
import { toPoly, polysOf, rectPoly } from './geometry.js';
import { solveLayout } from './solver.js';
import { renderLayoutOnCanvas } from './render.js';
import { exportToPng } from './export.js';
import { parseInstructions } from './ai.js';
import { score, PROFILES } from './score.js';
import { optimizeLayout } from './optimize.js';
import { realizeArrangement } from './arrange.js';

// Phase A flag: set true to route onSolve through realizeArrangement for testing.
// The existing solver path (solveLayout → optimizeLayout) is unchanged when false.
const USE_ARRANGER = true;

const TERM_LABELS = {
  buildingsPlaced: 'Buildings placed',
  parkingMet:      'Parking met',
  parkingInFront:  'Parking in front',
  roadVisibility:  'Road visibility',
  coverageTarget:  'Coverage',
  accessQuality:   'Access (penalty)',
  basinAccuracy:   'Basin accuracy',
  compactness:     'Compactness',
  openSpace:       'Open space',
};

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
  document.getElementById('btn-optimize').addEventListener('click', onOptimize);
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
  document.getElementById('btn-optimize').disabled = false;
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
    if (hints.frontage !== undefined) {
      document.getElementById('input-frontage').value = hints.frontage;
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

// Build a minimal arrangement schema from current UI inputs.
// One building → individual element anchored to parcelFrontage.
// Multiple buildings → strip group (Phase D) so they're laid side-by-side along the frontage.
function buildTestSchema(reqs, frontage, setbackFt) {
  const elements = [];
  if (reqs.buildings.length === 0) return { frontage, elements };

  // Pre-compute the depth of parking that will sit between the road and the first building.
  // This lets us push the building back far enough so parking actually fits in front of it.
  const firstB        = reqs.buildings[0];
  const firstArea     = firstB.length_ft * firstB.width_ft;
  const firstMaxDepth = Math.min(firstB.length_ft, firstB.width_ft);
  const firstDepth    = Math.min(firstMaxDepth, Math.sqrt(firstArea));
  const firstFace     = firstArea / firstDepth;
  const stallsPerRow  = Math.max(1, Math.floor(firstFace / 9));
  const parkRows      = reqs.parking_stalls > 0 ? Math.ceil(reqs.parking_stalls / stallsPerRow) : 0;
  const parkDepthFt   = parkRows * 30;   // stallDepthFt(18) + aisleFt(24)/2 = 30 ft per row
  // Building setback = UI setback + parking depth so there's room between road and building.
  const bSetbackFt    = setbackFt + parkDepthFt;

  let firstBuildingId;

  if (reqs.buildings.length === 1) {
    const b  = reqs.buildings[0];
    const id = b.label || 'b1';
    firstBuildingId = id;
    elements.push({
      id, type: 'building',
      size:  { areaSqFt: b.length_ft * b.width_ft, maxDepthFt: Math.min(b.length_ft, b.width_ft) },
      place: { anchor: 'parcelFrontage', setbackFt: bSetbackFt, alignU: 'center' },
    });
  } else {
    // Multiple buildings → group strip; parking anchors to the first child.
    firstBuildingId = reqs.buildings[0].label || 'b0';
    elements.push({
      id:       'g1',
      type:     'group',
      layout:   'strip',
      gapFt:    0,
      place:    { anchor: 'parcelFrontage', setbackFt: bSetbackFt },
      children: reqs.buildings.map((b, i) => ({
        id:   b.label || `b${i}`,
        size: { areaSqFt: b.length_ft * b.width_ft, maxDepthFt: Math.min(b.length_ft, b.width_ft) },
      })),
    });
  }

  // Anchor parking to the first building's front face when stalls are requested.
  if (reqs.parking_stalls > 0) {
    elements.push({
      id:    'p1',
      type:  'parking',
      size:  { stalls: reqs.parking_stalls },
      place: { anchor: firstBuildingId, face: 'front' },
    });

    // Add driveways connecting parcelFrontage to the parking block.
    if (reqs.driveways > 0) {
      const count   = Math.min(reqs.driveways, 3);
      const entryUs = count === 1 ? ['center']
                    : count === 2 ? ['left', 'right']
                    :               ['left', 'center', 'right'];
      entryUs.forEach((entryU, i) => {
        elements.push({
          id:    `d${i + 1}`,
          type:  'driveway',
          size:  { widthFt: 24 },
          place: { connects: 'parcelFrontage', to: 'p1', entryU },
        });
      });
    }
  }

  return { frontage, elements };
}

// Convert realizeArrangement output to the layout shape render.js and score.js expect.
function layoutFromArrangement(elements) {
  return {
    buildings: elements
      .filter(e => e.type === 'building' && e.feasible)
      .map(e => ({
        label:           e.label ?? e.id,
        length_ft:       e.length_ft,
        width_ft:        e.width_ft,
        center_x_ft:     e.center_x_ft,
        center_y_ft:     e.center_y_ft,
        orientation_deg: e.orientation_deg ?? 0,
      })),
    parking_areas: elements
      .filter(e => e.type === 'parking' && e.feasible)
      .map(e => e.feature),
    driveways: elements
      .filter(e => e.type === 'driveway' && e.feasible)
      .map(e => e.feature),
    detention_pond: null,
    warnings: elements
      .filter(e => !e.feasible)
      .map(e => `[arrange] ${e.id}: ${e.reason ?? 'infeasible'}`),
    rationale: 'realizeArrangement (Phase D)',
  };
}

function getReqs() {
  return {
    pondPct:        parseFloat(document.getElementById('input-pond-pct').value) || 15,
    buildings:      getBuildings(),
    parking_stalls: parseInt(document.getElementById('input-parking').value) || 0,
    driveways:      parseInt(document.getElementById('input-driveways').value) || 0,
  };
}

function onSolve() {
  clearSolveOverlays();
  document.getElementById('optimizer-panel').style.display = 'none';
  document.getElementById('status').textContent = 'Solving…';

  if (USE_ARRANGER) {
    try {
      const reqs = getReqs();
      const frontageVal = document.getElementById('input-frontage').value;
      const frontage = ['N','S','E','W'].includes(frontageVal) ? frontageVal : 'S';
      const setbackFt = parseFloat(document.getElementById('input-setback').value) || 20;
      const schema = buildTestSchema(reqs, frontage, setbackFt);
      const { elements } = realizeArrangement(schema, parcelLatLng, PROFILES.retail);
      const layout = layoutFromArrangement(elements);
      lastLayout = layout;
      renderLayout(layout, reqs, true, frontage);
      document.getElementById('btn-render').disabled = false;
      const bCount  = layout.buildings.length;
      const bTotal  = reqs.buildings.length;
      const warnTxt = layout.warnings.length ? ' | ' + layout.warnings.join('; ') : '';
      document.getElementById('status').textContent =
        `${bCount} / ${bTotal} buildings placed${warnTxt}`;
    } catch (err) {
      console.error('[arrange] onSolve error:', err);
      document.getElementById('status').textContent = 'Error: ' + err.message;
    }
    return;
  }

  const hints = {
    setbackFt:             parseFloat(document.getElementById('input-setback').value) || 20,
    basinCorner:           document.getElementById('input-basin-corner').value,
    clearanceFt:           aiHints.clearanceFt ?? 30,
    orientationPreference: aiHints.orientationPreference ?? 'auto',
    frontage:              document.getElementById('input-frontage').value,
  };
  const reqs = getReqs();

  const layout = solveLayout(parcelLatLng, reqs, hints);

  // Determinism self-check
  const layout2 = solveLayout(parcelLatLng, reqs, hints);
  const isDeterministic = JSON.stringify(layout.buildings) === JSON.stringify(layout2.buildings)
    && JSON.stringify(layout.detention_pond) === JSON.stringify(layout2.detention_pond);

  lastLayout = layout;
  renderLayout(layout, reqs, isDeterministic, hints.frontage);
  document.getElementById('btn-render').disabled = false;
}

function renderLayout(layout, reqs, isDeterministic, frontageHint) {
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

  // Score
  const resolvedFrontage = ['N','S','E','W'].includes(frontageHint) ? frontageHint : 'S';
  const scoreResult = score(layout, reqs, parcelFt, parcelSqFt, resolvedFrontage, PROFILES.retail);
  document.getElementById('score-total').textContent =
    `${scoreResult.total.toFixed(2)} / ${scoreResult.maxScore.toFixed(2)}`;
  const breakdown = document.getElementById('score-breakdown');
  breakdown.innerHTML = '';
  for (const [name, term] of Object.entries(scoreResult.terms)) {
    const row = document.createElement('div');
    row.className = 'score-term';
    const c = term.contribution;
    const cls = c > 0.005 ? 'score-pos' : c < -0.005 ? 'score-neg' : 'score-zero';
    row.innerHTML =
      `<span class="score-term-name">${TERM_LABELS[name] ?? name}</span>` +
      `<span class="score-term-raw">${term.raw.toFixed(2)}</span>` +
      `<span class="score-term-contrib ${cls}">${c >= 0 ? '+' : ''}${c.toFixed(2)}</span>`;
    breakdown.appendChild(row);
  }
  document.getElementById('score-panel').style.display = 'flex';

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

function onOptimize() {
  clearSolveOverlays();
  document.getElementById('status').textContent = 'Optimizing…';

  const frontageVal = document.getElementById('input-frontage').value;
  const frontage = ['N','S','E','W'].includes(frontageVal) ? frontageVal : 'S';

  const baseHints = {
    setbackFt:   parseFloat(document.getElementById('input-setback').value) || 20,
    clearanceFt: aiHints.clearanceFt ?? 30,
  };
  const reqs = getReqs();
  const parcelAreaSqFt = polygonAreaSqFt(parcelFt);

  const { best, all } = optimizeLayout(
    parcelLatLng, reqs, baseHints, PROFILES.retail, parcelFt, parcelAreaSqFt, frontage
  );

  lastLayout = best.layout;
  renderLayout(best.layout, reqs, true, frontage);
  showOptimizerResult(best, all);
  document.getElementById('btn-render').disabled = false;
  document.getElementById('status').textContent =
    `Optimizer chose Basin: ${best.params.basinCorner} (${all.length} layouts scored).`;
}

function showOptimizerResult(best, all) {
  document.getElementById('optimizer-winner-label').innerHTML =
    `<span class="opt-winner-label">Winner: Basin ${best.params.basinCorner}</span>`;

  const container = document.getElementById('optimizer-candidates');
  container.innerHTML = '';

  all.forEach((c, i) => {
    const isWinner = i === 0;
    const row = document.createElement('div');
    row.className = 'opt-candidate' + (isWinner ? ' opt-candidate-winner' : '');

    row.innerHTML =
      `<span class="opt-rank">#${i + 1}</span>` +
      `<span class="opt-params">Basin: ${c.params.basinCorner}</span>` +
      `<span class="opt-score">${c.total.toFixed(2)}</span>`;

    if (c.unplaced > 0) {
      const note = document.createElement('span');
      note.className = 'opt-unplaced';
      note.textContent = `${c.unplaced} bldg${c.unplaced > 1 ? 's' : ''} unplaced`;
      row.appendChild(note);
    }

    container.appendChild(row);
  });

  document.getElementById('optimizer-panel').style.display = 'flex';
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
  document.getElementById('btn-optimize').disabled = true;
  document.getElementById('acreage').textContent = '';
  document.getElementById('status').textContent = '';
  document.getElementById('ai-status').textContent = '';
  document.getElementById('stats-panel').style.display = 'none';
  document.getElementById('score-panel').style.display = 'none';
  document.getElementById('optimizer-panel').style.display = 'none';
  document.getElementById('warnings-panel').innerHTML = '';
  clearDrawing();
}
