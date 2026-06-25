# Program-Fit Check + Honest Status — Implementation Spec

**For Claude Code. Read `markdow/SUMMARY.md` first to restore context.**

Build in **two phases. Stop and let me test after each.** Phase 1 is a new pure module (additive,
low-risk). Phase 2 wires it into the UI handlers — **use Plan Mode**.

---

## 0. Why this task

With large programs (e.g. 3 × 500×500 buildings + 3,000 stalls), the tool produces a stranded,
road-disconnected layout instead of saying it doesn't fit. Confirmed by running the engine:

- On a parcel with enough depth (≥ ~1,200 ft for that program), front parking places all
  buildings, connects the driveway, and wins at score 4.40 — **the engine is correct when there's
  room.**
- Below ~1,090 ft of depth at the building's location, `scanGroupPlacement` and its fallback both
  fail and `realizeArrangement` returns **everything infeasible** (0 buildings, 0 parking, 0
  driveway). The optimizer then ranks degraded candidates and renders a stranded one as if it were
  the answer.

Root mechanism: front parking sets `bSetbackFt = setback + parkingDepth` (~570 ft for 1,000 stalls
over a 500 ft face), then the building is placed that far back. When the parcel is shallower than
`setback + parkingDepth + buildingDepth` there, the whole layout collapses silently.

The fix is an **advisory layer**, not an engine change: check whether the program can plausibly fit
*before* solving and block with a clear, numbers-driven explanation; and when a solve still comes
back degraded, **say so** instead of presenting it as success.

### Decisions baked in

- **Block-and-explain is primary.** If the program provably can't satisfy a hard gate or the parcel
  envelope, don't solve — show actionable messages with concrete remedies (reduce to N stalls,
  shrink buildings, raise basin %).
- **Pre-check uses best-case parcel depth** (max perpendicular extent), so it never over-blocks a
  layout the optimizer could actually find by placing in the deepest spot.
- **Post-solve honesty is the safety net.** Because the optimizer may place buildings in a shallower
  part of an irregular parcel than the best-case pre-check assumed, a degraded winner (unplaced
  buildings, no driveway while a road exists, parking shortfall) must be surfaced explicitly.

### Non-negotiables

- **Engine untouched.** `arrange.js` / `solver.js` / `optimize.js` placement logic, `score.js`
  scoring, and `regulatory.js` gates are not modified. The new module is read-only and advisory.
  (One allowed edit: add `export` to `splitStallsByGFA` in `optimize.js` so the check can reuse it —
  see 1a.)
- **Numbers must be actionable.** Every blocker states the binding quantity and a concrete remedy
  with a number, not just "doesn't fit."
- **Thresholds come from the profile**, not magic numbers — reuse `regConfig` rule params
  (`lotCoverage.max`, `parkingRatioGFA.per1000`, `detention.areaPerImpervFt`) and placement defaults
  (`stallDepthFt`, `aisleFt`, `setbackFt`) so the check stays in lock-step with the gates it mirrors.

---

## PHASE 1 — `js/feasibility.js` (new pure module)

**Goal:** a deterministic `checkProgramFits(...)` that returns hard blockers, soft warnings, and the
metrics behind them. No UI, no placement.

### 1a. Export the stall-split helper from `optimize.js`

`js/optimize.js` line ~71: change `function splitStallsByGFA(` to `export function splitStallsByGFA(`.
No other change — keep it the single source of truth for proportional allocation.

### 1b. Create `js/feasibility.js`

```js
// feasibility.js — pre-solve program/parcel fit check. Pure, deterministic, advisory.
// Estimates whether the program CAN fit before the optimizer runs, so the user gets a clear
// explanation instead of a silently degraded plan. Mirrors the regulatory gates and the
// arrange.js depth math; never places anything.
import { buildLocalFrame, feetToLocal } from './arrange.js';
import { splitStallsByGFA } from './optimize.js';

const pct = x => `${Math.round(x * 100)}%`;
const ft  = x => `${Math.round(x).toLocaleString()} ft`;
const sf  = x => `${Math.round(x).toLocaleString()} sq ft`;

export function checkProgramFits(reqs, parcelFt, parcelAreaSqFt, frontage, profile) {
  const blockers = [];
  const warnings = [];

  const stallWidthFt = profile.stallWidthFt ?? 9;
  const rowDepthFt    = (profile.stallDepthFt ?? 18) + (profile.aisleFt ?? 24) / 2; // 30
  const sqFtPerStall  = stallWidthFt * rowDepthFt;                                  // 270
  const setbackFt     = profile.setbackFt ?? 20;

  const buildings = reqs.buildings ?? [];
  const stalls    = reqs.parking_stalls ?? 0;

  const gfa          = buildings.reduce((s, b) => s + b.length_ft * b.width_ft, 0);
  const footprintSqFt = gfa; // rectangular footprints
  const parkingSqFt   = stalls * sqFtPerStall;
  const drivewaySqFt  = (reqs.driveways ?? 0) * 24 * 60; // coarse lane estimate
  const impervSqFt    = footprintSqFt + parkingSqFt + drivewaySqFt;
  const coverageRatio = parcelAreaSqFt > 0 ? impervSqFt / parcelAreaSqFt : Infinity;

  // Parcel envelope in the frontage frame: depth = into lot (n̂), width = along frontage (t̂).
  // Uses MAX perpendicular extent (best-case deepest spot) so we never over-block.
  const frame = buildLocalFrame(frontage);
  const local = parcelFt.map(p => feetToLocal(p, frame));
  const us = local.map(p => p.u), vs = local.map(p => p.v);
  const parcelWidthFt = Math.max(...us) - Math.min(...us);
  const parcelDepthFt = Math.max(...vs) - Math.min(...vs);

  // Building strip dimensions (mirror realizeGroup's spec derivation).
  const specs = buildings.map(b => {
    const area  = b.length_ft * b.width_ft;
    const depth = Math.min(Math.min(b.length_ft, b.width_ft), Math.sqrt(area));
    return { depth, face: area / depth };
  });
  const stripWidthFt    = specs.reduce((s, x) => s + x.face, 0);
  const buildingDepthFt = specs.length ? Math.max(...specs.map(x => x.depth)) : 0;

  // Front/rear parking: stacked in front of the strip → needs DEPTH.
  // Per-building rows over its own face; co-linear strip → pushed back by the deepest.
  const shares = splitStallsByGFA(buildings, stalls);
  let frontParkDepthFt = 0;
  specs.forEach((x, i) => {
    const spr = Math.max(1, Math.floor(x.face / stallWidthFt));
    frontParkDepthFt = Math.max(frontParkDepthFt, Math.ceil((shares[i] || 0) / spr) * rowDepthFt);
  });
  const frontDepthNeed = setbackFt + frontParkDepthFt + buildingDepthFt;
  const frontWidthNeed = stripWidthFt;

  // Side parking: lots off the strip's flanks → needs WIDTH, only building depth.
  const sideParkWidthFt = buildingDepthFt > 0 ? (parkingSqFt / buildingDepthFt) / 2 : Infinity;
  const sideDepthNeed   = setbackFt + buildingDepthFt;
  const sideWidthNeed   = stripWidthFt + 2 * sideParkWidthFt;

  const frontFits = frontDepthNeed <= parcelDepthFt && frontWidthNeed <= parcelWidthFt;
  const sideFits  = sideDepthNeed  <= parcelDepthFt && sideWidthNeed  <= parcelWidthFt;

  // ---------- Hard blockers ----------
  // 1. Lot coverage (orientation-independent hard gate).
  const covMax = profile.regConfig?.rules?.lotCoverage?.max ?? 0.80;
  if (coverageRatio > covMax) {
    const maxStalls = Math.max(0, Math.floor((covMax * parcelAreaSqFt - footprintSqFt - drivewaySqFt) / sqFtPerStall));
    blockers.push(
      `Impervious area ≈ ${pct(coverageRatio)} of the parcel, over the ${pct(covMax)} lot-coverage limit. ` +
      `At this building size the parcel supports ≤ ~${maxStalls.toLocaleString()} stalls — reduce stalls or shrink the buildings.`
    );
  }

  // 2. Parking-ratio gate: requested stalls must meet the GFA-derived minimum.
  const per1000 = profile.regConfig?.rules?.parkingRatioGFA?.per1000 ?? 4.0;
  const requiredStalls = Math.ceil(gfa / 1000 * per1000);
  if (gfa > 0 && stalls < requiredStalls) {
    blockers.push(
      `${sf(gfa)} of building requires ≥ ${requiredStalls.toLocaleString()} stalls (${per1000}/1,000 sq ft); ` +
      `you requested ${stalls.toLocaleString()}. Add stalls or reduce building size.`
    );
  }

  // 3. Envelope: must fit in at least one orientation.
  if (specs.length && !frontFits && !sideFits) {
    blockers.push(
      `Buildings + parking don't fit the parcel envelope in any orientation. ` +
      `Front-loaded needs ~${ft(frontDepthNeed)} deep × ${ft(frontWidthNeed)} wide; ` +
      `side-loaded needs ~${ft(sideDepthNeed)} deep × ${ft(sideWidthNeed)} wide; ` +
      `parcel provides ~${ft(parcelDepthFt)} deep × ${ft(parcelWidthFt)} wide along the ${frontage} frontage. ` +
      `Reduce stalls or building size.`
    );
  } else if (specs.length && !frontFits && sideFits) {
    warnings.push(
      `Front parking won't fit the depth here (~${ft(frontDepthNeed)} needed, ~${ft(parcelDepthFt)} available) — ` +
      `the optimizer will need a side-loaded layout.`
    );
  }

  // ---------- Soft warnings ----------
  // Detention basin sizing vs impervious.
  const basinPct  = (reqs.pondPct ?? 0) / 100;
  const availBasin = basinPct * parcelAreaSqFt;
  const perImperv = profile.regConfig?.rules?.detention?.areaPerImpervFt ?? 0.10;
  const reqBasin  = perImperv * impervSqFt;
  if (reqBasin > 0 && availBasin < reqBasin) {
    const needPct = Math.ceil(reqBasin / parcelAreaSqFt * 100);
    warnings.push(
      `Basin at ${(basinPct * 100).toFixed(0)}% ≈ ${sf(availBasin)}, below the ~${sf(reqBasin)} detention needs ` +
      `(${perImperv}× impervious). Raise basin to ≥ ~${needPct}%.`
    );
  }

  return {
    fits: blockers.length === 0,
    blockers,
    warnings,
    metrics: {
      gfa, footprintSqFt, parkingSqFt, impervSqFt, coverageRatio,
      requiredStalls, parcelDepthFt, parcelWidthFt,
      frontDepthNeed, frontWidthNeed, sideDepthNeed, sideWidthNeed,
      requiredBasinSqFt: reqBasin, availBasinSqFt: availBasin,
    },
  };
}
```

### STOP — test Phase 1 (console)

With a parcel drawn, run in the console:

```js
import('./js/feasibility.js').then(m => {
  console.log(m.checkProgramFits(getReqsForTest(), parcelFtGlobal, areaGlobal, 'N', PROFILES.retail));
});
```

(or wire a temporary call). Expected for **3 × 500×500 + 3,000 stalls**:
- Deep parcel (~2,000 ft): `fits: true`, no blockers (matches the engine winning at 4.40).
- Shallow parcel (~1,000 ft deep): a blocker citing the envelope with the ~1,090 ft depth need.
- Drop stalls below the GFA minimum (e.g. 2,000): the parking-ratio blocker fires.
- Tiny parcel: the lot-coverage blocker fires with a max-stalls suggestion.

Confirm the numbers read sensibly before wiring.

---

## PHASE 2 — Wire into the UI + honest status (`main.js`)

**Use Plan Mode.** Two changes: gate the solve on the pre-check, and flag degraded winners.

### 2a. Block-and-explain in `onSolve` and `onOptimize`

In **both** handlers, after `reqs` and `frontage` are resolved and `parcelFt` is available, before
building any schema / spawning the worker:

```js
import { checkProgramFits } from './feasibility.js'; // add to imports

const parcelAreaSqFt = polygonAreaSqFt(parcelFt);
const fit = checkProgramFits(reqs, parcelFt, parcelAreaSqFt, frontage, PROFILES.retail);
renderFeasibilityNotes(fit);                 // shows blockers (error) + warnings (warning)
if (!fit.fits) {
  document.getElementById('status').textContent =
    'Program doesn\u2019t fit this parcel — see notes below. Nothing was placed.';
  return;                                     // do NOT solve / spawn worker
}
```

Add a small renderer (place near `renderLayout`'s warnings code):

```js
function renderFeasibilityNotes(fit) {
  const el = document.getElementById('warnings-panel');
  el.innerHTML = '';
  fit.blockers.forEach(msg => {
    const d = document.createElement('div');
    d.className = 'error-msg';
    d.textContent = `\u26d4 ${msg}`;
    el.appendChild(d);
  });
  fit.warnings.forEach(msg => {
    const d = document.createElement('div');
    d.className = 'warning-msg';
    d.textContent = `\u26a0 ${msg}`;
    el.appendChild(d);
  });
}
```

Note: `onOptimize`'s `warnings-panel` is currently populated inside `renderLayout` after a result.
Make sure the pre-check notes aren't wiped — render them, and on the success path let `renderLayout`
append to (not clobber) them, or re-render feasibility warnings after the winner renders. Simplest:
keep `fit.warnings` in a module var and re-append after `renderLayout` on the success path.

### 2b. Post-solve honesty for degraded winners

After the optimizer's `done` handler picks `best` (and after `renderLayout`), check the winner and
append an explicit note when it's degraded — this catches the irregular-parcel case the best-case
pre-check passed:

```js
function flagDegradedWinner(layout, reqs, road) {
  const notes = [];
  const placed = layout.buildings.length;
  if (placed < reqs.buildings.length)
    notes.push(`Only ${placed}/${reqs.buildings.length} buildings placed — the rest didn\u2019t fit.`);
  const stalls = layout.parking_areas.reduce((s, p) => s + (p.properties?.stall_count ?? 0), 0);
  if (reqs.parking_stalls > 0 && stalls < reqs.parking_stalls * 0.9)
    notes.push(`Parking shortfall: ${stalls.toLocaleString()} of ${reqs.parking_stalls.toLocaleString()} stalls placed.`);
  if (road?.line && layout.driveways.length === 0)
    notes.push(`No driveway connects to the detected road — parking is stranded.`);
  return notes;
}
```

Render these (warning style) into the warnings panel on the success path, and reflect in the status
line, e.g. append ` \u00b7 \u26a0 partial layout` when `notes.length`. The winner still renders — we
just stop presenting a stranded plan as clean success.

### STOP — test Phase 2

- 3 × 500×500 + 3,000 stalls on a **shallow** parcel → solve is blocked with the envelope blocker;
  nothing is placed; status says it doesn't fit.
- Same program on a **deep** parcel → solves normally, no blockers; if you draw an irregular parcel
  where buildings land shallow, the degraded-winner note appears.
- Reasonable program (e.g. 150×100 × 3 + 300 stalls) → no notes, solves clean.

---

## After both phases

Update `markdow/SUMMARY.md`: new `js/feasibility.js` (`checkProgramFits`) advisory layer; pre-solve
block-and-explain wired into `onSolve`/`onOptimize`; post-solve degraded-winner reporting; and note
that `splitStallsByGFA` is now exported from `optimize.js`.

## Handoff prompt for Claude Code

> Read `markdow/SUMMARY.md`, then `js/optimize.js` (the `splitStallsByGFA` helper and
> `buildCandidateSchema`) and `js/arrange.js` (`buildLocalFrame`, `feetToLocal`). Implement
> **Phase 1 only** from `program-fit-check-spec.md`: export `splitStallsByGFA` and create
> `js/feasibility.js`. Don't wire anything into the UI yet. Show me the new module and stop so I can
> test it in the console. Phase 2 (wiring + honest status) goes in Plan Mode after I confirm.
