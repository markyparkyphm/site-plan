import { solveLayout } from './solver.js';
import { score } from './score.js';
import { realizeArrangement } from './arrange.js';
import { latLngToFeet, polygonAreaSqFt } from './projection.js';

// ---------------------------------------------------------------------------
// Legacy basin-corner optimizer (4 solveLayout calls, kept behind USE_SCHEMA_OPTIMIZER flag)
// ---------------------------------------------------------------------------

// Orientation is currently inert in the solver (reach is rotation-invariant), so
// we search only basin corner. Add 'NS'/'EW' back once orientation truly changes geometry.
const BASIN_CORNERS = ['SW', 'SE', 'NW', 'NE'];

// frontage is passed in already resolved ('N'|'S'|'E'|'W') and is held FIXED.
// It is NEVER a search dimension — see OPTIMIZER_TASK.md for the hard rule.
export function optimizeLayout(parcelLatLng, reqs, baseHints, profile, parcelFt, parcelAreaSqFt, frontage) {
  const candidates = [];

  for (const basinCorner of BASIN_CORNERS) {
    const hints = { ...baseHints, basinCorner, frontage };
    const layout = solveLayout(parcelLatLng, reqs, hints);
    const result = score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile);
    candidates.push({
      params:    { basinCorner },
      layout,
      total:     result.total,
      maxScore:  result.maxScore,
      breakdown: result.terms,
      unplaced:  reqs.buildings.length - layout.buildings.length,
    });
  }

  // Stable sort — ties keep enumeration order (SW/SE/NW/NE).
  candidates.sort((a, b) => b.total - a.total);
  return { best: candidates[0], all: candidates };
}

// ---------------------------------------------------------------------------
// Schema optimizer (Phase 1) — searches arrangement schemas via realizeArrangement
// ---------------------------------------------------------------------------

// Adapt realizeArrangement output to the layout shape score.js expects.
// Does not change score.js — only bridges the two APIs.
function layoutFromElements(elements) {
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
    warnings:  [],
    rationale: 'optimizeArrangement',
  };
}

// Build one arrangement schema from a knob-value point.
// Program dimensions (building sizes, stall count, pond %) come from reqs unchanged.
// Only arrangement decisions (setback, alignment, gap, basin corner, driveways) vary.
//
// knobs: { layout, gapFt, parkingFaces, driveways, basinCorner, setbackFt, alignU }
//   parkingFaces — string like 'front' or 'front+rear'; split on '+' to get face list
//   driveways    — array of entryU strings for this candidate, e.g. ['left','right']
function buildCandidateSchema(reqs, frontage, knobs) {
  const { layout, gapFt, parkingFaces, driveways, basinCorner, setbackFt, alignU } = knobs;
  const elements = [];
  if (reqs.buildings.length === 0) return { frontage, elements, _knobs: knobs };

  // Pre-compute how deep front parking will be so the building can be pushed back
  // exactly that far — mirrors buildTestSchema logic in main.js.
  const firstB        = reqs.buildings[0];
  const firstArea     = firstB.length_ft * firstB.width_ft;
  const firstMaxDepth = Math.min(firstB.length_ft, firstB.width_ft);
  const firstDepth    = Math.min(firstMaxDepth, Math.sqrt(firstArea));
  const firstFace     = firstArea / firstDepth;
  const stallsPerRow  = Math.max(1, Math.floor(firstFace / 9));

  const faces = parkingFaces.split('+');
  const hasFrontParking = faces.includes('front') && reqs.parking_stalls > 0;
  const parkRows    = hasFrontParking ? Math.ceil(reqs.parking_stalls / stallsPerRow) : 0;
  const parkDepthFt = parkRows * 30; // stallDepthFt(18) + aisleFt(24)/2 per row
  const bSetbackFt  = setbackFt + parkDepthFt;

  let firstBuildingId;

  if (reqs.buildings.length === 1) {
    const b  = reqs.buildings[0];
    const id = b.label || 'b1';
    firstBuildingId = id;
    elements.push({
      id, type: 'building',
      size:  { areaSqFt: b.length_ft * b.width_ft, maxDepthFt: Math.min(b.length_ft, b.width_ft) },
      place: { anchor: 'parcelFrontage', setbackFt: bSetbackFt, alignU },
    });
  } else {
    // Multiple buildings → strip group; parking anchors to the first child.
    firstBuildingId = reqs.buildings[0].label || 'b0';
    elements.push({
      id: 'g1', type: 'group', layout: 'strip', gapFt,
      place: { anchor: 'parcelFrontage', setbackFt: bSetbackFt, alignU },
      children: reqs.buildings.map((b, i) => ({
        id:   b.label || `b${i}`,
        size: { areaSqFt: b.length_ft * b.width_ft, maxDepthFt: Math.min(b.length_ft, b.width_ft) },
      })),
    });
  }

  if (reqs.parking_stalls > 0) {
    faces.forEach((face, fi) => {
      const parkId = `p${fi + 1}`;
      elements.push({
        id: parkId, type: 'parking',
        size:  { stalls: reqs.parking_stalls },
        place: { anchor: firstBuildingId, face },
      });

      // Driveways connect parcelFrontage to front parking only.
      if (face === 'front') {
        driveways.forEach((entryU, di) => {
          elements.push({
            id:    `d${fi * 10 + di + 1}`,
            type:  'driveway',
            size:  { widthFt: 24 },
            place: { connects: 'parcelFrontage', to: parkId, entryU },
          });
        });
      }
    });
  }

  if (reqs.pondPct > 0) {
    elements.push({
      id:    'bn1',
      type:  'basin',
      size:  { pctOfParcel: reqs.pondPct / 100 },
      place: { anchor: 'parcelCorner', corner: basinCorner },
    });
  }

  return { frontage, elements, _knobs: knobs };
}

// Generator — yields one schema per cross-product point up to searchConfig.maxCandidates.
// All value-sets and grid arrays come from searchConfig (profile.searchConfig), not
// hardcoded here. Widening a value-set in the profile automatically expands the search.
function* generateCandidates(reqs, frontage, searchConfig) {
  const {
    layout:       layouts,
    gapFt:        gapFts,
    parkingFaces: parkingFacesSets,
    driveways:    drivewaySets,
    basinCorner:  basinCorners,
    setbackFt:    setbackFts,
    alignU:       alignUs,
    maxCandidates,
  } = searchConfig;

  let count = 0;
  for (const layout of layouts) {
    for (const gapFt of gapFts) {
      for (const parkingFaces of parkingFacesSets) {
        for (const driveways of drivewaySets) {
          for (const basinCorner of basinCorners) {
            for (const setbackFt of setbackFts) {
              for (const alignU of alignUs) {
                if (count >= maxCandidates) return;
                count++;
                yield buildCandidateSchema(reqs, frontage, {
                  layout, gapFt, parkingFaces, driveways,
                  basinCorner, setbackFt, alignU,
                });
              }
            }
          }
        }
      }
    }
  }
}

// Main entry point for Phase 1.
// Returns { ranked, totalTried } where ranked is sorted by total descending
// and contains only feasible candidates (all elements feasible:true).
// Frontage is held fixed — it is NEVER a search dimension.
export function optimizeArrangement(parcelLngLat, reqs, frontage, profile) {
  const searchConfig   = profile.searchConfig;
  const parcelFt       = latLngToFeet(parcelLngLat);
  const parcelAreaSqFt = polygonAreaSqFt(parcelFt);

  const ranked = [];
  let totalTried = 0;

  for (const schema of generateCandidates(reqs, frontage, searchConfig)) {
    totalTried++;
    const { elements } = realizeArrangement(schema, parcelLngLat, profile);

    // Feasibility gate: disqualify the candidate if any element failed.
    // All elements in a generated schema are required — partial failure = invalid plan.
    if (elements.some(e => !e.feasible)) continue;

    const layout = layoutFromElements(elements);
    const result = score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile);

    ranked.push({
      schema,   // includes _knobs for UI inspection
      layout,
      total:    result.total,
      maxScore: result.maxScore,
      terms:    result.terms,
      feasible: true,
    });
  }

  ranked.sort((a, b) => b.total - a.total);
  return { ranked, totalTried };
}
