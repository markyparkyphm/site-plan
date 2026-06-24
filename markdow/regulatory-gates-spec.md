# Regulatory Feasibility Gates — Implementation Spec

**For Claude Code. Read `SUMMARY.md` first.** Build phase-by-phase; **stop and test after each phase.** Use Plan Mode — this touches the scoring pipeline in three optimizer loops, the manual-solve path, and exports a few helpers from `arrange.js`.

> **Build order:** item **#1 of 3** (gates → widen → backend proxy). Build first. "Widen the arrangement space" depends on this existing: widening generates archetypes the scorer has never judged, and they must be filtered to *buildable* ones before scoring — that filter is this spec.

---

## 0. Why

The optimizer finds the best layout **per the scorer**, whose weights are intuition-tuned with no external check (project decision). So it can rank an **unbuildable** plan first — under-parked, over-covered, no fire lane — and present it with false rigor. Site planning has objective ground truth for free: **municipal code**. Encoding it as **hard feasibility gates** makes "optimal" mean "best among *permittable*," needs no labeled dataset (gates are objective), and extends the project's "near-binary gates over soft curves" principle.

### Scope decisions (made; all swappable)
- **Use type now: `retail` only.** Architecture must allow adding `neighborhood` and other use types later **without engine changes** (see §2 — the rule registry). This is the load-bearing requirement of this spec.
- **Values below are representative US suburban-commercial stand-ins, NOT a specific adopted code.** Every one is a per-profile knob. Replace with the real adopted values for your jurisdiction before trusting output.
- **`jurisdiction` is a field**, defaulted to a placeholder that must surface in the UI/console so nobody mistakes stand-ins for law.

### Non-negotiables
- Gates operate on the **realized `layout`** (buildings, parking_areas w/ `stall_count`, driveways w/ `properties.widthFt`, detention_pond), not the schema — checks are about actual realized quantities.
- A candidate failing any **hard** gate is **disqualified exactly like a geometrically-infeasible one**: `continue`, never scored, never ranked. **Soft** violations don't disqualify (reserved for optional penalty terms later).
- `regConfig` lives in `profile`, which **already** crosses the worker boundary via `postMessage` — **no new worker plumbing** (unlike the driveway road threading).
- No magic numbers in the engine: every threshold is a `regConfig` rule param. The rule *set* is data, not code.

---

## 1. The decisions, as the retail `regConfig`

Goes in `PROFILES.retail` (`score.js`). See §2 for the shape rationale.

```js
regConfig: {
  useType:      'retail',
  jurisdiction: 'UNVERIFIED — representative defaults, set to your adopted code',  // must surface in UI
  rules: {
    // basis is encoded in the rule NAME so other use types can swap the basis (see §2)
    parkingRatioGFA:  { enabled: true, severity: 'hard', per1000: 4.0 },   // stalls / 1,000 sq ft GFA
    lotCoverage:      { enabled: true, severity: 'hard', max: 0.80 },      // (bldg+parking+driveway)/parcel
    buildingCoverage: { enabled: true, severity: 'hard', max: 0.40 },      // footprint/parcel
    setbacks:         { enabled: true, severity: 'hard', frontFt: 25, sideFt: 10, rearFt: 15 },
    aisleWidth:       { enabled: true, severity: 'hard', minFt: 24 },      // drive aisle
    fireLane:         { enabled: true, severity: 'hard', minFt: 20 },      // IFC min clear width
    detention:        { enabled: true, severity: 'hard', areaPerImpervFt: 0.10, approximate: true },
    // landscapeBuffer: deferred to Phase 2 (needs new geometry)
  },
},
```

`enabled:false` cleanly disables a rule per profile; `severity` flips hard↔soft per profile — both without touching any checker.

---

## 2. Architecture: a rule registry, so use types are additive

A flat `regConfig` of numbers would break the moment a second use type arrives, because **the parking-ratio basis differs by use** — retail is per-GFA, residential is per-dwelling-unit. So the engine is a **registry of pure checker functions keyed by rule name**, and each profile's `regConfig.rules` selects which checkers apply with which params.

### New module `js/regulatory.js`
```js
// Pure, deterministic, never throws. turf.* global (works in worker via the spread namespace).
// Reuses arrange.js local-frame helpers for slant-correct setback math (see §3c).
import { buildLocalFrame, feetToLocal, frontageV, buildingLocalBounds } from './arrange.js';

const SQFT_PER_SQM = 10.7639;

// --- Rule checker registry. Each: (layout, ctx, params) => violation | null ---
// ctx carries derived quantities computed once in checkGates so checkers stay cheap.
const RULE_CHECKERS = {
  parkingRatioGFA:  (layout, ctx, p) => { /* required = ceil(ctx.gfa/1000 * p.per1000); fail if ctx.stalls < required */ },
  lotCoverage:      (layout, ctx, p) => { /* fail if ctx.imperv / ctx.parcelAreaSqFt > p.max */ },
  buildingCoverage: (layout, ctx, p) => { /* fail if ctx.footprint / ctx.parcelAreaSqFt > p.max */ },
  setbacks:         (layout, ctx, p) => { /* front/side/rear via local frame, see §3c; return first/all breaches */ },
  aisleWidth:       (layout, ctx, p) => { /* fail if any driveway widthFt < p.minFt */ },
  fireLane:         (layout, ctx, p) => { /* fail if widest lane < p.minFt (fire access need not be every lane) */ },
  detention:        (layout, ctx, p) => { /* required = ctx.imperv * p.areaPerImpervFt; fail if ctx.basin < required */ },
  // future: parkingRatioPerUnit, densityUnitsPerAcre, lotWidthFt, ... (residential) — register here, no engine change
};

export function checkGates(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile) {
  const cfg = profile.regConfig;
  if (!cfg || !cfg.rules) return { pass: true, violations: [] };  // no config → no gating

  const ctx = deriveContext(layout, reqs, parcelFt, parcelAreaSqFt, frontage);  // gfa, footprint, imperv, stalls, basin, frame...
  const violations = [];
  for (const [name, rule] of Object.entries(cfg.rules)) {
    if (!rule.enabled) continue;
    const checker = RULE_CHECKERS[name];
    if (!checker) { violations.push({ rule: name, detail: 'no checker registered', severity: 'soft' }); continue; }
    const v = checker(layout, ctx, rule);          // null = passes
    if (v) violations.push({ ...v, rule: name, severity: rule.severity });
  }
  const hardFail = violations.some(v => v.severity === 'hard');
  return { pass: !hardFail, violations };
}
```

### How a future use type slots in (illustration only — do NOT build now)
```js
PROFILES.neighborhood = {
  /* ...scoring weights, placement defaults, searchConfig for residential... */
  regConfig: {
    useType: 'neighborhood', jurisdiction: '...',
    rules: {
      parkingRatioPerUnit: { enabled: true, severity: 'hard', perUnit: 2.0 },  // NEW checker
      densityUnitsPerAcre: { enabled: true, severity: 'hard', max: 12 },        // NEW checker
      lotCoverage:         { enabled: true, severity: 'hard', max: 0.45 },      // REUSES retail checker
      setbacks:            { enabled: true, severity: 'hard', frontFt: 20, sideFt: 7, rearFt: 20 },
    },
  },
};
```
`parkingRatioPerUnit` / `densityUnitsPerAcre` are new entries in `RULE_CHECKERS`; `lotCoverage`/`setbacks` are reused as-is. **`checkGates`'s loop never changes.** That is the mutability requirement satisfied. (Residential will also need program fields like unit count on `reqs` — a future seam, not this task.)

---

## 3. Engine wiring (Phase 1)

### 3a. Export local-frame helpers from `arrange.js`
Add `export` to `feetToLocal` (line ~32), `frontageV` (line ~47), `buildingLocalBounds` (line ~115). `buildLocalFrame` is already exported. These are pure; exporting is safe and lets `regulatory.js` do slant-correct setback math instead of duplicating it.

### 3b. `deriveContext` — compute shared quantities once
- `gfa` = Σ `length_ft × width_ft` over `layout.buildings`
- `footprint` = same sum (rectangular footprints)
- `parkingSqFt` = Σ `turf.area(p) × SQFT_PER_SQM` over `layout.parking_areas`
- `drivewaySqFt` = Σ `turf.area(d) × SQFT_PER_SQM` over `layout.driveways`
- `imperv` = `footprint + parkingSqFt + drivewaySqFt`
- `stalls` = Σ `parking_areas[i].properties.stall_count`
- `basin` = `layout.detention_pond ? turf.area(...) × SQFT_PER_SQM : 0`
- `frame` = `buildLocalFrame(frontage)`; also stash parcel u/v extents for setbacks

### 3c. Concrete setback math (slant-correct, via local frame)
For each building, get `{uMin,uMax,vMin,vMax} = buildingLocalBounds(b, frame)` (vMin = front face nearest road). Parcel extents: `vFront = frontageV(parcelFt, frame)`, and over all parcel vertices' local coords, `parcelVMax = max(v)`, `parcelUMin = min(u)`, `parcelUMax = max(u)`.

- **Front:** `frontSetback = b.vMin - vFront` → fail if `< rule.frontFt`
- **Rear:**  `rearSetback = parcelVMax - b.vMax` → fail if `< rule.rearFt`
- **Side:**  `min(b.uMin - parcelUMin, parcelUMax - b.uMax)` → fail if `< rule.sideFt`

Report the worst breach with the numbers in `detail` (e.g. `"front setback 18 ft < 25 ft"`). All three are computable today — none deferred.

### 3d. Insertion points — 3 optimizer loops + manual solve
Identical everywhere: **after `layoutFromElements(...)`, before `score(...)`**. Re-grep `score(` since lines drift.

| File | Location | Action |
|---|---|---|
| `optimize.js` | Phase 1 main loop (~before line 427 `score`) | `if (!checkGates(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile).pass) continue;` |
| `optimize.js` | `refineArrangement` loop (~before line 260) | same `continue` |
| `optimize.js` | `scoreAiSeeds` loop (~before line 315) | same `continue` |
| `main.js` | `renderLayout` manual path (~before line 467) | **do NOT skip** — call `checkGates`, push `violations` (hard and soft) into the warnings panel so a manual solve explains *why* it's non-compliant; still render (user asked for it) |

`optimize.js` adds `import { checkGates } from './regulatory.js';`. The worker imports `optimize.js` → `regulatory.js` → `arrange.js`; all use `turf.*` global, so the chain works in the worker. **Confirm `regulatory.js` has no ESM turf import.**

### 3e. Disqualification accounting
Disqualified candidates still increment `totalTried` (they were attempted) but never enter `ranked`. Optionally surface "N gated out" in the status line so the user sees the regulatory layer is biting, not that the search is broken.

---

## PHASE 1 — Engine + the data-available hard gates

Implement: the registry, `deriveContext`, `checkGates`, the four reused exports, the seven retail checkers in §1 (all computable from existing layout data + the driveway `properties.widthFt`), the four insertion points, and the manual-solve warnings.

> If the **driveway task isn't merged**, `properties.widthFt` may be absent → `aisleWidth`/`fireLane` should fall back to measuring driveway polygon min-width, or be `enabled:false` until driveway lands. Prefer the property; note which you did.

### Phase 1 test gate
- Under-park the program vs. ratio → those candidates disqualified; feasible count drops; "N gated out" reflects it.
- Set `buildingCoverage.max` very low → most candidates disqualified (gate bites).
- Tilt/slant a parcel and tighten side setback → confirm side gate triggers correctly (validates the local-frame math, not bbox).
- Manual Solve on a non-compliant layout → warnings panel lists each violation with rule + numbers; layout still renders.
- All thresholds permissive → behaves exactly like today (no candidates lost).
- Worker path: no "checkGates is not defined" / turf errors → import chain works off-thread.
- `jurisdiction: 'UNVERIFIED …'` is visible in UI/console — stand-ins can't be mistaken for law.

**Stop. Test. Then Phase 2.**

---

## PHASE 2 — Gates needing new geometry / new program (after Phase 1 + driveway)
- **ADA accessible stalls:** needs `arrange.js` parking realizer to *type* a stall subset as accessible (ADA table: 1 per 25 ≤100, then sliding). New checker `adaStalls`; gate realized accessible ≥ required(total).
- **Landscape / perimeter buffer:** buffer-band geometry check around the parcel edge. New checker + geometry.
- **Soft penalty terms:** for any rule set `severity:'soft'`, add a matching term in `score.js` (reuse `plateau`/`clamp01`) reading the same rule params. Keep few — prefer hard gates.
- **Residential prep (when adding `neighborhood`):** register `parkingRatioPerUnit`, `densityUnitsPerAcre`, etc.; add unit-count program fields to `reqs`. Engine untouched (that's the point).

---

## Honest limits
- Values are **representative stand-ins, not law** until `jurisdiction` and the rule params are set to the adopted code. The engine is only as honest as those numbers.
- Detention is area-proportional-to-impervious — a stand-in for real volume/runoff sizing. `approximate:true` flags it; surface that in the UI.
- ADA accessible-stall *placement* is genuinely absent until Phase 2; Phase 1 checks total-stall sufficiency, not accessible typing.
- Gates make "optimal" = "best among layouts passing *these encoded* rules" — a real floor, not full permittability. State that to users.
