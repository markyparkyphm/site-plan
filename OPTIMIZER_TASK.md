# Site Planner — Task: Brute-Force Optimizer (`optimize.js`)

## Goal

Stop taking the first valid layout. Instead, generate a layout for each combination of the
discrete arrangement knobs, **score** each with `score()`, and keep the highest-scoring one.
This is the step that makes the tool *choose* a good plan instead of just placing a fitting
one. It reuses `solveLayout` and `score` unchanged — no new geometry, no AI.

---

## THE HARD RULE — frontage is NOT a search dimension

Frontage is **ground truth** (which edge faces the real road). The scorer's frontage-relative
terms (`parkingInFront`, `roadVisibility`) trust the frontage value completely, so each
frontage scores well *relative to its own assumed road*. If the optimizer were allowed to try
all four frontages and keep the highest score, it would sometimes pick the edge facing **away**
from the actual road — the score literally cannot tell the difference.

So: **the optimizer holds frontage FIXED** (from the user's dropdown, or later from road
auto-detection) and searches only the knobs the user doesn't have a stake in — basin corner
and orientation. Do not put frontage in the candidate loop. This is the single most important
constraint in this task.

---

## New file: `js/optimize.js`

```js
import { solveLayout } from './solver.js';
import { score } from './score.js';

const BASIN_CORNERS = ['SW', 'SE', 'NW', 'NE'];
const ORIENTATIONS  = ['NS', 'EW'];

// frontage is passed in already resolved and is held constant across all candidates.
export function optimizeLayout(parcelLatLng, reqs, baseHints, profile,
                               parcelFt, parcelAreaSqFt, frontage) {
  const candidates = [];

  for (const basinCorner of BASIN_CORNERS) {
    for (const orientationPreference of ORIENTATIONS) {
      const hints = { ...baseHints, basinCorner, orientationPreference, frontage }; // frontage FIXED
      const layout = solveLayout(parcelLatLng, reqs, hints);
      const result = score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile);
      candidates.push({
        params:    { basinCorner, orientationPreference },
        layout,
        total:     result.total,
        breakdown: result.terms,
        unplaced:  reqs.buildings.length - layout.buildings.length,
      });
    }
  }

  // Highest score wins. Stable sort → deterministic; ties keep enumeration order.
  candidates.sort((a, b) => b.total - a.total);
  return { best: candidates[0], all: candidates };
}
```

**Candidate space:** 4 basin corners × 2 orientations = 8 solves. Note that the orientation
loop in the solver is currently inert (reach is rotation-invariant — see SCORING/FIXES notes),
so the two orientations produce identical layouts today. You may start with **just the 4 basin
corners** (drop the orientation loop) and add orientation back once real per-orientation
erosion exists — that halves the work for no current loss. Either is fine; keep it small.

---

## Wiring into `main.js`

Add an **"Optimize Layout"** button next to "Solve Layout." Keep plain Solve too (single run
with the current knobs) for debugging and comparison.

```js
import { optimizeLayout } from './optimize.js';
import { PROFILES } from './score.js';

function onOptimize() {
  clearSolveOverlays();
  document.getElementById('status').textContent = 'Optimizing…';

  const frontage = ['N','S','E','W'].includes(document.getElementById('input-frontage').value)
    ? document.getElementById('input-frontage').value : 'S';   // FIXED, not searched
  const baseHints = {
    setbackFt:   parseFloat(document.getElementById('input-setback').value) || 20,
    clearanceFt: aiHints.clearanceFt ?? 30,
  };
  const reqs = { /* same as onSolve */ };
  const parcelAreaSqFt = polygonAreaSqFt(parcelFt);

  const { best, all } = optimizeLayout(parcelLatLng, reqs, baseHints,
                                       PROFILES.retail, parcelFt, parcelAreaSqFt, frontage);
  lastLayout = best.layout;
  renderLayout(best.layout, reqs, true);
  showOptimizerResult(best, all);   // see below
}
```

(Build it synchronous for 8 solves. If a complex parcel feels slow, show "Optimizing n/8…"
and only reach for web workers if it's actually a problem — don't pre-optimize.)

---

## Make the choice legible ("why this won")

Don't return a black box. After optimizing, show:
- The **winning params** (e.g. "Basin: NE, Orientation: NS") and its total score.
- A compact **ranked list of all candidates** with their scores, so the user sees the spread
  and can sanity-check that the winner is winning for the right reasons.
- The winner's **score breakdown** (reuse the per-term display you already built).

This transparency is also how you catch the optimizer optimizing for something dumb — if the
winner has a great score but an obviously worse layout, a weight is wrong, and the ranked list
makes that visible immediately.

---

## Tests
- Optimizer returns the same winner on repeated runs (deterministic).
- On a parcel where one basin corner clearly serves the layout better, that corner wins, and
  the ranked list shows it ahead of the others.
- The winning layout still passes all containment guarantees (it came from `solveLayout`, so
  it must — spot-check anyway).
- Frontage set to South vs North changes the layout but the optimizer never *overrides* it —
  confirm frontage in the winning params equals what the user selected.

---

## Right after this: prioritize road auto-detection

Because the scorer now trusts `frontage` completely, a wrong frontage silently corrupts the
score and can make the optimizer prefer a backwards plan. The auto-detect-the-road follow-on
(from FRONTAGE_TASK.md — OpenStreetMap/Overpass: find the nearest, most-parallel road edge and
pre-fill the frontage dropdown) is no longer polish; it's what keeps the score honest. Build it
next so 'auto' resolves to the *real* road instead of always 'S'. Keep it a pre-filled
suggestion the user can override (corner lots front two roads).

---

## Not now
- Don't search frontage (see the hard rule).
- Don't add simulated annealing over continuous building positions yet. Brute force over the
  discrete knobs may be enough; only escalate if the results leave obvious quality on the table
  that the discrete knobs can't reach.
