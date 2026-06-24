# Widen the Arrangement Space — Implementation Spec

**For Claude Code. Read `SUMMARY.md` first.** Build phase-by-phase; **stop and test after each phase.** Use Plan Mode — Phase 1 edits `realizeParking` and `realizeGroup` in `arrange.js` plus `searchConfig` in `score.js`.

> **Build order:** item **#2 of 3**. **Gates and the driveway task are both merged** — assumed by this spec (side/rear parking needs the driveway lane + the fire-lane gate reads `properties.widthFt`; illegal new archetypes are filtered by the gates).

---

## 0. Why, and the one surprise to expect

The search space is narrow: one group layout (`strip`), front-only parking, four basin corners. The 288-candidate grid nearly enumerates it, so the AI proposer rarely beats brute force — the AI layer is elegant but currently marginal. Widening (side/rear parking, a second multi-building layout, later L/U + wrapped) gives designs the engine can't currently express, blows up the combinatorics so the **AI proposer finally matters**, and **stress-tests the scorer + gates against layouts they've never judged.**

**Expect fewer feasible winners, not more, at first.** A wider space generates code-illegal archetypes — rear-parking with no room for a compliant lane, layouts that bust setbacks. The gates you just built disqualify those automatically. That's the system working: diversity is generated, then filtered. Same shape as the "everything needs 80 stalls" moment — flagging it now so a drop in feasible count reads as correct, not broken.

### Decision baked in: cap handling = **A (raise + brute-force) for Phase 1**
Widening pushes the grid past `maxCandidates` (500), which **silently truncates**. Phase 1 raises the cap and keeps enumerating, so you see the wider space work deterministically. **B** — handing region-selection to the AI proposer — is teed up in Phase 2 as the move when the space outgrows enumeration. (Flip to B sooner if you want; A-first is the safer order.)

### Non-negotiables
- **Knob-not-weld:** each new archetype is a value added to `searchConfig`, realized by a parameterized realizer — never a hardcoded one-off.
- **Program fixed; frontage never searched.** Unchanged.
- Reuse existing machinery first (rear parking already works at the realizer level — see 1a).
- `realizeArrangement` never throws; a failing archetype returns `feasible:false`.

### Honest framing
This is the **least pin-down-able** of the three tasks — exploratory by nature. Phase 1 is concrete and buildable now; Phase 2 is a sketch that firms up once Phase 1 shows how the optimizer + gates handle diversity.

---

## PHASE 1 — Diversity on existing machinery

### 1a. Side parking faces (`left` / `right`) in `realizeParking`
`realizeParking` (arrange.js ~line 158) is built around the anchor building's local bounds `ab = buildingLocalBounds(...)`. Front/rear vary `vFace` and span the building's **u-width**. **Side parking is the symmetric flip**: span the building's **v-depth**, extend in **u** off the left/right face.

Replace the `vFace`/`faceFt`/`vNear`/`vFar`/`ring` block (~lines 180–207) with a face-general version:

```js
const lateral = (face === 'left' || face === 'right');
// front/rear measure the building's u-width; left/right measure its v-depth
const faceFt  = lateral ? (ab.vMax - ab.vMin) : (ab.uMax - ab.uMin);
// ...stall calc (targetStalls, stallsPerRow, rows, depthFt) unchanged, uses faceFt...

let ring, localBounds;
if (!lateral) {
  const vFace = face === 'rear' ? ab.vMax : ab.vMin;
  const vNear = face === 'rear' ? vFace : vFace - depthFt;
  const vFar  = face === 'rear' ? vFace + depthFt : vFace;
  ring = [[ab.uMin,vNear],[ab.uMax,vNear],[ab.uMax,vFar],[ab.uMin,vFar],[ab.uMin,vNear]];
  localBounds = { uMin: ab.uMin, uMax: ab.uMax, vMin: vNear, vMax: vFar };
} else {
  const uFace = face === 'right' ? ab.uMax : ab.uMin;
  const uNear = face === 'right' ? uFace : uFace - depthFt;
  const uFar  = face === 'right' ? uFace + depthFt : uFace;
  ring = [[uNear,ab.vMin],[uFar,ab.vMin],[uFar,ab.vMax],[uNear,ab.vMax],[uNear,ab.vMin]];
  localBounds = { uMin: uNear, uMax: uFar, vMin: ab.vMin, vMax: ab.vMax };
}
// ...map ring → WGS84 (localToFeet → feetToLatLngFromCentroid) exactly as today...
```

Use the computed `localBounds` in the return (replacing the hardcoded front/rear one at ~line 245). Everything downstream (clip-to-free, stall count, properties) is unchanged.

**Driveway interaction — the real caveat:** a side field still needs a lane from the road. The driveway runs frontage→parking by `entryU` (lateral position). For a side field the lane must land at the field's u-range, or `drivewayConnected` will (correctly) mark it disconnected and the fire-lane/aisle gates may fail it. Two options: (i) leave it — let the optimizer discover that side parking pairs with the matching `entryU`, gates filter the rest; or (ii) bias `entryU` toward the field's side when parking is lateral. **Recommend (i) for Phase 1** (simpler, and it tests whether gates + driveway scoring actually steer the search). Watch for: side-parking candidates that never survive because no enumerated `entryU` reaches them — if so, do (ii) in Phase 1b.

### 1b. Rear + combined faces into the search (realizer already supports rear)
`score.js searchConfig.parkingFaces`: `['front']` → `['front', 'rear', 'left', 'right', 'front+rear']`. `buildCandidateSchema` already splits on `+` and pushes one parking element per face; **keep driveways attaching only to `front` faces** (a rear/side field is reached by a lane from the front edge, not its own frontage). Confirm the `+` path produces one parking element per face with distinct ids.

### 1c. Second group layout: `stacked` in `realizeGroup`
`realizeGroup` (~line 369) currently places all children in **one row along t̂** sharing a front face. Add a `stacked` layout = **R rows along n̂** (increasing depth).

- Thread the knob: confirm the group element carries `layout` (it's a `searchConfig` knob and is destructured in `buildCandidateSchema`; if it isn't set on the group element, add `layout` to the group schema there). In `realizeGroup`, read `const layout = el.layout ?? 'strip';`.
- For `stacked`: split `children` into `R` rows (e.g. `R = Math.ceil(sqrt(N))` or a `rows` knob). Group bbox depth = `R*maxChildDepth + (R-1)*gapFt`; bbox face = widest row's `totalFaceFt`. Reuse `scanGroupPlacement` with the new (deeper) bbox. In the distribution loop, place row `r`'s children along t̂ at `v = groupFrontV + r*(rowDepthFt+gapFt) + depthFt/2`, resetting `uCursor` per row.
- `strip` path stays exactly as-is. Single-building (N=1) never groups — unaffected.

Add `'stacked'` to `searchConfig.layout`. A failed placement returns `failAll(...)` as today.

### 1d. Raise the cap + surface truncation (Decision A)
Combinatorics: 288 × (parkingFaces 1→5) × (layout 1→2) ≈ **2,880** before Phase 2. `maxCandidates: 500` truncates silently.
- Raise `searchConfig.maxCandidates` to e.g. **3,000**.
- In `generateCandidates`, when output hits the cap, set a flag the optimizer surfaces in the status line ("cap reached — N of M enumerated"). Don't fail; just tell the user the grid is no longer exhaustive (that's the Phase-2/Decision-B trigger).
- Confirm the worker still finishes in a few seconds on a typical parcel. If sluggish, trim `parkingFaces` or `setbackFt`/`alignU` grids (they're knobs) before adding machinery.

### Phase 1 test gate
- Enable rear/side: winners sometimes place parking behind or beside the building; they render correctly; lanes connect (check `drivewayConnected` in the breakdown).
- **Every surviving candidate passes the gates** — spot-check the breakdown; none under-parked/over-covered/no-lane. If an illegal layout wins, the bug is in gates, not here — stop and fix gates.
- `stacked` produces feasible multi-building winners visibly distinct from `strip`.
- Cap: with the wider space, status reports enumeration vs. cap; `totalTried` is bounded and sane.
- AI badges: with the bigger space, AI seeds land in the top rows more often than before (they're proposing into space the grid no longer fully covers — the first sign the AI layer is starting to matter).
- Side-parking sanity: confirm at least some side-parking candidates survive with a connected lane; if none ever do, apply 1a option (ii).

**Stop. Test. Then Phase 2.**

---

## PHASE 2 — Harder archetypes + the switch to AI navigation (sketch)
- **L / U groups:** children along two/three legs; new `realizeGroup` branch + corner-aware placement (likely a generalized child-placement routine).
- **Wrapped parking:** parking on contiguous faces forming an L around the building — compose face realizers + union/clip; watch the JSTS coincident-edge issue (the turf monkey-patch already mitigates it).
- **Perimeter vs. field lots:** parking distributed along parcel edges; new placement mode.
- **Decision B — AI proposer navigation:** once the cap truncation flag (1d) fires routinely, the grid is no longer exhaustive and brute force is leaving regions unexplored. That's the trigger to lean on the proposer to seed the promising regions instead of enumerating, and to tune `topK`/refinement to spend the budget on AI-suggested neighborhoods. This is the payoff the AI architecture was built for — but only build it once the space is genuinely too big to enumerate, so you can measure the proposer against a known-good exhaustive baseline.

Each archetype: a new `searchConfig` value + a parameterized realizer, one at a time, each with its own stop-and-test, each verified against the gates.

---

## Honest limits
- Combinatorics is the binding constraint. Past a point, enumeration is infeasible and the search must lean on the proposer + Phase 2 refinement. This task forces that transition — expect to tune `maxCandidates`, `topK`, and the proposer's role.
- More archetypes = more chances for the intuition-tuned scorer to rank something odd. Gates catch *illegal*, not *ugly-but-legal*. Eyeball winners.
- Wrapped / L / U will surface new arrange.js geometry edge cases. Build incrementally; failures return `feasible:false`, never throw.
- Side parking's usefulness depends on the lane reaching it; if the enumerated `entryU` set can't, side fields will be gated out until 1a option (ii) or a richer driveway model lands.
