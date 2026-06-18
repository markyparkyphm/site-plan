import { solveLayout } from './solver.js';
import { score } from './score.js';

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
