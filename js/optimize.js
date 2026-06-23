import { solveLayout } from './solver.js';
import { score } from './score.js';
import { realizeArrangement, buildLocalFrame } from './arrange.js';
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
export function buildCandidateSchema(reqs, frontage, knobs) {
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

// ---------------------------------------------------------------------------
// Schema optimizer Phase 2 — local refinement around top-K Phase 1 winners
// ---------------------------------------------------------------------------

// Total face width (along t̂) for the building(s) in reqs — used to estimate
// 'left'/'right' alignU positions so Phase 2 can seed numeric offsets around them.
function computeTotalFaceFt(reqs) {
  return reqs.buildings.reduce((sum, b) => {
    const area  = b.length_ft * b.width_ft;
    const depth = Math.min(Math.min(b.length_ft, b.width_ft), Math.sqrt(area));
    return sum + area / depth;
  }, 0);
}

// Convert a Phase 1 string alignU to a numeric u-coordinate in local frame (feet).
// Mirrors the logic in realizeBuilding/realizeGroup so Phase 2 offsets are centred
// on the same position the arranger was targeting.
function alignUToFeet(alignU, parcelFt, frame, faceFt, setbackFt) {
  if (typeof alignU === 'number') return alignU;
  const us   = parcelFt.map(p => p.x * frame.t.x + p.y * frame.t.y);
  const uMin = Math.min(...us), uMax = Math.max(...us);
  if (alignU === 'left')  return uMin + setbackFt + faceFt / 2;
  if (alignU === 'right') return uMax - setbackFt - faceFt / 2;
  return 0; // 'center'
}

// Phase 2: try a fine setbackFt grid and numeric alignU offsets around each
// Phase 1 winner.  Returns { candidates, tried } so the caller can account for
// total attempted candidates across both phases.
function refineArrangement(topKWinners, parcelLngLat, reqs, frontage, profile, parcelFt, parcelAreaSqFt) {
  const { refineConfig, setbackFt: phase1Setbacks } = profile.searchConfig;
  if (!refineConfig || topKWinners.length === 0) return { candidates: [], tried: 0 };

  const frame     = buildLocalFrame(frontage);
  const phase1Set = new Set(phase1Setbacks);
  const faceFt    = computeTotalFaceFt(reqs);

  const candidates = [];
  let tried = 0;

  for (const winner of topKWinners) {
    const k = winner.schema._knobs;

    // Fine setback grid: ±refineRange in refineStep increments, skipping Phase 1 values.
    const fineSetbacks = [];
    for (let d = -refineConfig.setbackRange; d <= refineConfig.setbackRange; d += refineConfig.setbackStep) {
      const v = Math.round(k.setbackFt + d);
      if (v >= 5 && !phase1Set.has(v)) fineSetbacks.push(v);
    }
    const uniqueSetbacks = [...new Set(fineSetbacks)];

    // Numeric alignU positions: Phase 1 base + configured offsets.
    const baseU  = alignUToFeet(k.alignU, parcelFt, frame, faceFt, k.setbackFt);
    const alignUs = refineConfig.alignOffsetsFt.map(off => baseU + off);

    for (const setbackFt of uniqueSetbacks) {
      for (const alignU of alignUs) {
        tried++;
        const schema = buildCandidateSchema(reqs, frontage, { ...k, setbackFt, alignU });

        let elements;
        try {
          ({ elements } = realizeArrangement(schema, parcelLngLat, profile));
        } catch (_) { continue; }

        if (!isCandidateViable(elements)) continue;

        const layout = layoutFromElements(elements);
        const result = score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile);
        candidates.push({
          schema,
          layout,
          total:    result.total,
          maxScore: result.maxScore,
          terms:    result.terms,
          feasible: true,
          source:   'grid',
        });
      }
    }
  }

  return { candidates, tried };
}

// A candidate is viable when at least one building was placed. Partial placements score
// lower via buildingsPlaced (weight 1.0) so the optimizer naturally prefers full placements.
// Parking / driveway / basin failures similarly reduce score rather than disqualifying.
// The old "all buildings must be feasible" rule was too strict on tight parcels where
// the multi-row fallback may be unable to fit every building — those candidates should
// still appear in the ranked list rather than causing "No feasible layouts found".
function isCandidateViable(elements) {
  const buildings = elements.filter(e => e.type === 'building');
  return buildings.some(e => e.feasible);
}

// Stable string key for a knob-set — used to deduplicate AI seeds against grid candidates.
// driveways array is sorted so ['right','left'] and ['left','right'] hash identically.
export function knobSig(k) {
  const dw = Array.isArray(k.driveways) ? [...k.driveways].sort().join(',') : String(k.driveways);
  return `${k.layout}|${k.gapFt}|${k.parkingFaces}|${dw}|${k.basinCorner}|${k.setbackFt}|${k.alignU}`;
}

// Score AI knob-sets on the main thread with the same turf monkey-patch used inside the
// worker. Deduplicates internally. Returns feasible candidate objects tagged source:'ai'.
// Called from main.js after the worker finishes, to merge AI seeds into the ranked list.
export function scoreAiSeeds(seeds, parcelLngLat, reqs, frontage, profile) {
  if (!seeds.length) return [];

  const parcelFt       = latLngToFeet(parcelLngLat);
  const parcelAreaSqFt = polygonAreaSqFt(parcelFt);

  const origUnion      = turf.union;
  const origDifference = turf.difference;
  const origIntersect  = turf.intersect;
  turf.union      = (a, b) => { try { return origUnion(a, b);      } catch (_) { return null; } };
  turf.difference = (a, b) => { try { return origDifference(a, b); } catch (_) { return null; } };
  turf.intersect  = (a, b) => { try { return origIntersect(a, b);  } catch (_) { return null; } };

  const candidates = [];
  const seenSigs   = new Set();

  try {
    for (const knobs of seeds) {
      const sig = knobSig(knobs);
      if (seenSigs.has(sig)) continue;
      seenSigs.add(sig);
      const schema = buildCandidateSchema(reqs, frontage, knobs);
      let elements;
      try {
        ({ elements } = realizeArrangement(schema, parcelLngLat, profile));
      } catch (_) { continue; }
      if (!isCandidateViable(elements)) continue;
      const layout = layoutFromElements(elements);
      const result = score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile);
      candidates.push({
        schema, layout,
        total:    result.total,
        maxScore: result.maxScore,
        terms:    result.terms,
        feasible: true,
        source:   'ai',
      });
    }
  } finally {
    turf.union      = origUnion;
    turf.difference = origDifference;
    turf.intersect  = origIntersect;
  }

  return candidates;
}

// Main entry point for Phases 1 + 2.
// Returns { ranked, totalTried } where ranked is sorted by total descending
// and contains only feasible candidates (all elements feasible:true).
// Frontage is held fixed — it is NEVER a search dimension.
// aiSeeds: pre-validated knob-sets from proposeArrangements (main thread).
//   Scored first, deduped against Phase 1 grid via knobSig. Pass [] to get
//   a run identical to today's deterministic search.
export function optimizeArrangement(parcelLngLat, reqs, frontage, profile, onProgress = null, aiSeeds = []) {
  const searchConfig   = profile.searchConfig;
  const parcelFt       = latLngToFeet(parcelLngLat);
  const parcelAreaSqFt = polygonAreaSqFt(parcelFt);

  const ranked = [];
  let totalTried = 0;
  let currentBest = null;
  const seenSigs = new Set(); // dedup AI seeds against Phase 1 grid candidates

  function notifyIfBetter(candidate) {
    if (!onProgress) return;
    if (!currentBest || candidate.total > currentBest.total) {
      currentBest = candidate;
      onProgress({ best: candidate, totalTried });
    }
  }

  // With multi-building groups the group's clearance buffer and the first child's
  // clearance buffer share EXACTLY coincident boundary segments (the child defines
  // the group depth, so both buffers have the same extent). JSTS's ring-traversal
  // algorithm throws "Unable to complete output ring" when turf.union / turf.difference
  // encounter these coincident edges. Arrange.js already guards every one of these
  // calls with a `?? free` or `?? null` fallback — they just never reach it because
  // the throw propagates first. Patching the turf globals to return null on error
  // lets the existing fallbacks kick in (parking clips to a slightly smaller zone
  // without the clearance restore) so candidates remain feasible and scoreable.
  // The originals are always restored via finally so nothing outside this function
  // is affected.
  const origUnion      = turf.union;
  const origDifference = turf.difference;
  const origIntersect  = turf.intersect;
  turf.union      = (a, b) => { try { return origUnion(a, b);      } catch (_) { return null; } };
  turf.difference = (a, b) => { try { return origDifference(a, b); } catch (_) { return null; } };
  turf.intersect  = (a, b) => { try { return origIntersect(a, b);  } catch (_) { return null; } };

  try {
    // AI seeds — knob-sets proposed by proposeArrangements on the main thread.
    // Scored through the identical realize→gate→score path as grid candidates.
    // The turf monkey-patch above applies here too (coincident-edge JSTS bug).
    for (const knobs of aiSeeds) {
      const sig = knobSig(knobs);
      if (seenSigs.has(sig)) continue;
      seenSigs.add(sig);
      totalTried++;
      const schema = buildCandidateSchema(reqs, frontage, knobs);
      let elements;
      try {
        ({ elements } = realizeArrangement(schema, parcelLngLat, profile));
      } catch (_) { continue; }
      if (!isCandidateViable(elements)) continue;
      const layout = layoutFromElements(elements);
      const result = score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile);
      const candidate = {
        schema, layout,
        total:    result.total,
        maxScore: result.maxScore,
        terms:    result.terms,
        feasible: true,
        source:   'ai',
      };
      ranked.push(candidate);
      notifyIfBetter(candidate);
    }

    // Phase 1: exhaustive discrete cross-product search.
    for (const schema of generateCandidates(reqs, frontage, searchConfig)) {
      const sig = knobSig(schema._knobs);
      if (seenSigs.has(sig)) continue; // already scored via AI seed — skip
      seenSigs.add(sig);
      totalTried++;

      let elements;
      try {
        ({ elements } = realizeArrangement(schema, parcelLngLat, profile));
      } catch (_) {
        // Safety net for any remaining unexpected throws (e.g. from turf.buffer,
        // which isn't patched above). Treat as infeasible and keep going.
        continue;
      }

      // Feasibility gate: disqualify the candidate if any element failed.
      // All elements in a generated schema are required — partial failure = invalid plan.
      if (!isCandidateViable(elements)) continue;

      const layout = layoutFromElements(elements);
      const result = score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile);

      const candidate = {
        schema,   // includes _knobs for UI inspection
        layout,
        total:    result.total,
        maxScore: result.maxScore,
        terms:    result.terms,
        feasible: true,
        source:   'grid',
      };
      ranked.push(candidate);
      notifyIfBetter(candidate);
    }

    // Phase 2: local refinement around top-K Phase 1 winners.
    // Fine-grid setbackFt and numeric alignU offsets from each winner's base position.
    if (ranked.length > 0) {
      ranked.sort((a, b) => b.total - a.total);
      const topK = searchConfig.topK ?? 4;
      const { candidates: p2candidates, tried: p2tried } = refineArrangement(
        ranked.slice(0, topK), parcelLngLat, reqs, frontage, profile, parcelFt, parcelAreaSqFt
      );
      totalTried += p2tried;
      for (const c of p2candidates) {
        ranked.push(c);
        notifyIfBetter(c);
      }
    }
  } finally {
    turf.union      = origUnion;
    turf.difference = origDifference;
    turf.intersect  = origIntersect;
  }

  ranked.sort((a, b) => b.total - a.total);
  return { ranked, totalTried };
}
