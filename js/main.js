import { initMap, clearDrawing, getMap } from './map.js';
import { latLngToFeet, polygonAreaSqFt, sqFtToAcres, computeCentroid, feetToLatLngFromCentroid } from './projection.js';
import { toPoly, polysOf, rectPoly } from './geometry.js';
import { solveLayout } from './solver.js';
import { renderLayoutOnCanvas } from './render.js';
import { exportToPng } from './export.js';
import { parseInstructions, proposeArrangements } from './ai.js';
import { detectRoad } from './road.js';
import { score, PROFILES } from './score.js';
import { optimizeLayout, optimizeArrangement, scoreAiSeeds, knobSig } from './optimize.js';
import { realizeArrangement } from './arrange.js';
import { checkGates } from './regulatory.js';

// Routes onSolve through realizeArrangement (Phase D/E arranger).
const USE_ARRANGER = true;

// Routes the Optimize button through optimizeArrangement (schema optimizer, Phase 1).
// Set false to fall back to the legacy 4-basin-corner optimizeLayout search.
const USE_SCHEMA_OPTIMIZER = true;

const TERM_LABELS = {
  buildingsPlaced: 'Buildings placed',
  parkingMet:      'Parking met',
  parkingInFront:  'Parking in front',
  roadVisibility:  'Road visibility',
  coverageTarget:  'Coverage',
  drivewayConnected: 'Driveway connected',
  drivewayLength:    'Driveway length',
  drivewayPresent:   'Driveway present',
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
let detectedRoad = null;
let roadOverlay  = null;

// Schema optimizer worker state
let optimizerWorker = null;
let lastRanked      = [];
let lastReqs        = null;
let lastFrontage    = 'S';

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
  document.getElementById('btn-cancel-optimize').addEventListener('click', onCancelOptimize);
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

  // Reset frontage so detection always pre-fills for this boundary.
  // Without this, a stale N/S/E/W from a previous parcel would block the pre-fill.
  document.getElementById('input-frontage').value = 'auto';

  const acres = sqFtToAcres(polygonAreaSqFt(parcelFt));
  document.getElementById('btn-use-boundary').disabled = false;
  document.getElementById('acreage').textContent = `${acres.toFixed(2)} acres`;
  document.getElementById('status').textContent =
    `${pts.length} vertices captured. Click "Use Boundary" to confirm.`;
  drawSetback();

  // Detect nearby road without blocking the UI. Capture pts/centroid in the closure
  // so a concurrent Clear or redraw doesn't cause stale results to apply.
  const snapPts = pts, snapCentroid = { ...centroid };
  detectRoad(snapPts, snapCentroid).then(result => {
    if (parcelLatLng !== snapPts) return; // boundary was cleared or redrawn — discard
    detectedRoad = result;
    const roadStatusEl = document.getElementById('road-status');
    if (!result) {
      roadStatusEl.textContent = 'No nearby road detected — set frontage manually.';
      return;
    }
    // Pre-fill only when the user hasn't already chosen a direction.
    if (document.getElementById('input-frontage').value === 'auto') {
      document.getElementById('input-frontage').value = result.cardinal;
    }
    // Draw the detected road as a thin magenta polyline.
    if (roadOverlay) { roadOverlay.setMap(null); }
    const map = getMap();
    if (map) {
      roadOverlay = new google.maps.Polyline({
        path:          result.line.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
        map,
        strokeColor:   '#e879f9',
        strokeWeight:  2,
        strokeOpacity: 0.9,
      });
    }
    const altNote = result.candidates.length > 1
      ? ` · also: ${result.candidates.slice(1).map(c => `${c.cardinal} (${Math.round(c.distanceFt)} ft)`).join(', ')}`
      : '';
    roadStatusEl.textContent =
      `Detected: ${result.cardinal} side (${Math.round(result.distanceFt)} ft away)${altNote}`;
  });
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
function buildTestSchema(reqs, frontage, setbackFt, basinCorner) {
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

  // Basin in the rear corner when a pond percentage is set.
  if (reqs.pondPct > 0) {
    elements.push({
      id:    'bn1',
      type:  'basin',
      size:  { pctOfParcel: reqs.pondPct / 100 },
      place: { anchor: 'parcelCorner', corner: basinCorner || 'NE' },
    });
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
    detention_pond: elements.find(e => e.type === 'basin' && e.feasible)?.feature ?? null,
    warnings: elements
      .filter(e => !e.feasible)
      .map(e => `[arrange] ${e.id}: ${e.reason ?? 'infeasible'}`),
    rationale: 'realizeArrangement (Phase E)',
  };
}

function getReqs() {
  const pondPctVal = parseFloat(document.getElementById('input-pond-pct').value);
  return {
    pondPct:        isNaN(pondPctVal) ? 15 : pondPctVal,
    buildings:      getBuildings(),
    parking_stalls: parseInt(document.getElementById('input-parking').value) || 0,
    driveways:      parseInt(document.getElementById('input-driveways').value) || 0,
  };
}

function onSolve() {
  if (optimizerWorker) { optimizerWorker.terminate(); optimizerWorker = null; }
  document.getElementById('btn-cancel-optimize').style.display = 'none';
  document.getElementById('btn-optimize').disabled = false;
  clearSolveOverlays();
  document.getElementById('optimizer-panel').style.display = 'none';
  document.getElementById('status').textContent = 'Solving…';

  if (USE_ARRANGER) {
    try {
      const reqs = getReqs();
      const frontageVal = document.getElementById('input-frontage').value;
      const frontage = ['N','S','E','W'].includes(frontageVal) ? frontageVal : 'S';
      const setbackFt = parseFloat(document.getElementById('input-setback').value) || 20;
      const basinCorner = document.getElementById('input-basin-corner').value;
      const schema = buildTestSchema(reqs, frontage, setbackFt, basinCorner);
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
  const scoreResult = score(layout, reqs, parcelFt, parcelSqFt, resolvedFrontage, PROFILES.retail, detectedRoad);
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

  // Regulatory gate check — always run; violations render as warnings but do not block display.
const gateResult = checkGates(layout, reqs, parcelFt, parcelSqFt, resolvedFrontage, PROFILES.retail, parcelLatLng);
  if (gateResult.violations.length > 0) {
    const jNote = document.createElement('div');
    jNote.className = 'reg-note';
    jNote.textContent = `Regulatory: ${PROFILES.retail.regConfig.jurisdiction}`;
    warningsEl.appendChild(jNote);
    gateResult.violations.forEach(v => {
      const el = document.createElement('div');
      el.className = v.severity === 'hard' ? 'error-msg' : 'warning-msg';
      el.textContent = `⚠ [${v.rule}] ${v.detail}`;
      warningsEl.appendChild(el);
    });
  }

  document.getElementById('status').textContent = layout.warnings.length ? '' : 'Layout solved successfully.';

  if (layout.warnings.length) console.warn('[Solver]', layout.warnings);
}

function onCancelOptimize() {
  if (optimizerWorker) { optimizerWorker.terminate(); optimizerWorker = null; }
  document.getElementById('btn-cancel-optimize').style.display = 'none';
  document.getElementById('btn-optimize').disabled = false;
  document.getElementById('status').textContent = 'Optimization cancelled.';
}

async function onOptimize() {
  // Kill any in-progress worker before starting a new run.
  if (optimizerWorker) { optimizerWorker.terminate(); optimizerWorker = null; }

  clearSolveOverlays();
  document.getElementById('optimizer-panel').style.display = 'none';
  document.getElementById('status').textContent = 'Optimizing…';

  const frontageVal = document.getElementById('input-frontage').value;
  const frontage = ['N','S','E','W'].includes(frontageVal) ? frontageVal : 'S';
  const reqs = getReqs();

  if (USE_SCHEMA_OPTIMIZER) {
    lastReqs     = reqs;
    lastFrontage = frontage;

    document.getElementById('btn-optimize').disabled = true;
    document.getElementById('btn-cancel-optimize').style.display = '';

    // Build parcel summary for the AI proposer.
    const pSqFt = polygonAreaSqFt(parcelFt);
    const _xs = parcelFt.map(p => p.x), _ys = parcelFt.map(p => p.y);
    const parcelSummary = {
      acres:   sqFtToAcres(pSqFt),
      widthFt: Math.round(Math.max(..._xs) - Math.min(..._xs)),
      depthFt: Math.round(Math.max(..._ys) - Math.min(..._ys)),
    };

    // Fire Gemini immediately — runs concurrently with the worker to hide latency.
    // Three bias-variant prompts fire in parallel inside proposeArrangements.
    const geminiPromise = proposeArrangements(parcelSummary, reqs, frontage, PROFILES.retail)
      .catch(() => []);

    // Spawn worker with empty AI seeds — seeds are scored on the main thread
    // after both the grid search and Gemini calls complete.
    optimizerWorker = new Worker('./js/optimizer-worker.js', { type: 'module' });

    optimizerWorker.onmessage = async (e) => {
      const { type } = e.data;

      if (type === 'progress') {
        const { best, totalTried } = e.data;
        clearSolveOverlays();
        lastLayout = best.layout;
        renderLayout(best.layout, reqs, true, frontage);
        document.getElementById('btn-render').disabled = false;
        document.getElementById('status').textContent =
          `Optimizing… ${totalTried} tried · best so far: ${best.total.toFixed(2)}`;

      } else if (type === 'done') {
        const { ranked: gridRanked, totalTried: gridTried, gatedOut: gridGatedOut = 0, truncated = false } = e.data;
        optimizerWorker = null;
        document.getElementById('btn-cancel-optimize').style.display = 'none';

        // Await AI seeds — likely already resolved since Gemini ran concurrently with the
        // worker. Keep btn-optimize disabled until we have the seeds so the button state
        // is consistent. The turf monkey-patch for JSTS coincident-edge errors is applied
        // inside scoreAiSeeds, same as in the worker's optimizeArrangement.
        const aiSeeds = await geminiPromise;
        document.getElementById('btn-optimize').disabled = false;

        const { candidates: aiCandidates, gatedOut: aiGatedOut = 0 } =
          scoreAiSeeds(aiSeeds, parcelLatLng, reqs, frontage, PROFILES.retail, detectedRoad);

        // Merge: add AI candidates whose knob signature doesn't duplicate a grid result.
        const gridSigs = new Set(gridRanked.map(c => knobSig(c.schema._knobs)));
        const newAi    = aiCandidates.filter(c => !gridSigs.has(knobSig(c.schema._knobs)));
        const ranked   = [...gridRanked, ...newAi].sort((a, b) => b.total - a.total);
        const totalTried = gridTried + aiCandidates.length;
        const totalGated = gridGatedOut + aiGatedOut;

        if (ranked.length === 0) {
          const gateNote = totalGated > 0 ? ` (${totalGated} gated out by regulatory rules)` : '';
          const capNote2 = truncated ? ' · cap reached' : '';
          document.getElementById('status').textContent =
            `No feasible layouts found (${totalTried} candidates tried)${gateNote}${capNote2}.`;
          return;
        }

        lastRanked = ranked;
        window._ranked = ranked; // console inspection: _ranked[0].schema._knobs
        const best = ranked[0];
        clearSolveOverlays();
        lastLayout = best.layout;
        renderLayout(best.layout, reqs, true, frontage);
        showSchemaOptimizerResult(ranked);
        document.getElementById('btn-render').disabled = false;
        const k         = best.schema._knobs;
        const aiNote    = newAi.length ? ` · ${newAi.length} AI` : '';
        const gateNote  = totalGated > 0 ? ` · ${totalGated} gated` : '';
        const capNote   = truncated ? ' · cap reached' : '';
        document.getElementById('status').textContent =
          `Schema optimizer (P1+P2): ${ranked.length} feasible / ${totalTried} tried${aiNote}${gateNote}${capNote}` +
          ` | Winner: setback ${k.setbackFt}ft, basin ${k.basinCorner}, align ${fmtAlignU(k.alignU)}`;
      }
    };

    optimizerWorker.onerror = (err) => {
      console.error('[optimizer-worker]', err);
      optimizerWorker = null;
      document.getElementById('btn-cancel-optimize').style.display = 'none';
      document.getElementById('btn-optimize').disabled = false;
      document.getElementById('status').textContent = 'Optimizer error: ' + err.message;
    };

    // Worker runs the grid search only (aiSeeds: [] — AI seeds scored on main thread).
    optimizerWorker.postMessage({ parcelLatLng, reqs, frontage, profile: PROFILES.retail, aiSeeds: [], road: detectedRoad });
    return;
  }

  // Legacy path: 4-basin-corner search via solveLayout
  const baseHints = {
    setbackFt:   parseFloat(document.getElementById('input-setback').value) || 20,
    clearanceFt: aiHints.clearanceFt ?? 30,
  };
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

function fmtAlignU(alignU) {
  if (typeof alignU !== 'number') return alignU;
  return `u${alignU >= 0 ? '+' : ''}${Math.round(alignU)}ft`;
}

function showSchemaOptimizerResult(ranked) {
  const displayK = PROFILES.retail.searchConfig.displayK ?? 10;
  const topN = ranked.slice(0, displayK);
  const best = topN[0];
  const k = best.schema._knobs;
  document.getElementById('optimizer-winner-label').innerHTML =
    `<span class="opt-winner-label">` +
    `Winner: parking ${k.parkingFaces} · layout ${k.layout} · setback ${k.setbackFt}ft · basin ${k.basinCorner} · align ${fmtAlignU(k.alignU)}` +
    `</span>`;

  const container = document.getElementById('optimizer-candidates');
  container.innerHTML = '';

  topN.forEach((c, i) => {
    const ck = c.schema._knobs;
    const row = document.createElement('div');
    row.className = 'opt-candidate' + (i === 0 ? ' opt-candidate-winner opt-candidate-active' : '');
    const dwLabel = Array.isArray(ck.driveways) ? ck.driveways.join('/') : ck.driveways;
    const aiTag = c.source === 'ai' ? '<span class="opt-ai-tag">AI</span>' : '';
    row.innerHTML =
      `<span class="opt-rank">#${i + 1}</span>` +
      `<span class="opt-params">` +
        aiTag +
        `${ck.parkingFaces} · ${ck.layout} · ${ck.basinCorner} · ${ck.setbackFt}ft · ${fmtAlignU(ck.alignU)}` +
        (ck.gapFt > 0 ? ` · gap ${ck.gapFt}ft` : '') +
        (ck.parkingFaces === 'front' || ck.parkingFaces.includes('front') ? ` · dw:${dwLabel}` : '') +
      `</span>` +
      `<span class="opt-score">${c.total.toFixed(2)}</span>`;

    // Step-through: click to render this candidate's layout.
    row.addEventListener('click', () => {
      container.querySelectorAll('.opt-candidate').forEach(r => r.classList.remove('opt-candidate-active'));
      row.classList.add('opt-candidate-active');
      clearSolveOverlays();
      lastLayout = c.layout;
      renderLayout(c.layout, lastReqs, true, lastFrontage);
    });

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
  if (optimizerWorker) { optimizerWorker.terminate(); optimizerWorker = null; }
  document.getElementById('btn-cancel-optimize').style.display = 'none';
  parcelLatLng = []; parcelFt = []; centroid = null;
  lastRanked = []; lastReqs = null;
  aiHints = {};
  clearSolveOverlays();
  if (setbackOverlay) { setbackOverlay.setMap(null); setbackOverlay = null; }
  if (roadOverlay)    { roadOverlay.setMap(null);    roadOverlay = null; }
  detectedRoad = null;
  document.getElementById('road-status').textContent = '';
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
