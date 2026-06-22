# Schema Optimizer — Spec

## Goal

Search **arrangements**, not coordinates. Generate arrangement-schema variants, realize each through `arrange.js` (`realizeArrangement`), score each with `score.js`, and return a ranked list. This is the payoff of the relational engine: hundreds of coherent, valid candidates instead of 144 basin shuffles.

Lives in `optimize.js` as `optimizeArrangement(parcelLngLat, reqs, frontage, profile)`. The old 144-candidate basin search becomes a subset of this and is superseded (keep it behind a flag during transition, then retire).

**Hard rules carried forward:**
- **Program is fixed input, arrangement is searched.** Building count/areas, stall target, basin % come from `reqs` and are NOT invented or resized. The optimizer arranges the given program.
- **Frontage is NOT searched.** Held fixed, same as today — the scorer trusts it.
- Every searched dimension's value-set is a **knob in a search config**, not hardcoded.

---

## 1. Search space (discrete cross-product + small continuous)

This is deliberately discrete and small — not high-dimensional continuous. Every sample is already a coherent plan.

Discrete knobs (each a value-set in the search config):

| knob | example value-set |
|---|---|
| `layout` | `strip`, `detached`, `lshape` |
| `gapFt` | `0` (shared wall), `20` (separated) |
| `parkingFaces` | `front`, `front+left`, `front+right`, `front+left+right` |
| `driveways` | `[left]`, `[center]`, `[right]`, `[left,right]` |
| `basinCorner` | `rearLeft`, `rearRight`, `frontLeft`, `frontRight` |

Coarse continuous knobs (sampled on a small grid in Phase 1, refined in Phase 2):

| knob | example grid |
|---|---|
| `setbackFt` | `15`, `25`, `35` |
| `alignU` | `left`, `center`, `right` |

Cross-product is on the order of ~1–2k candidates — exhaustively searchable client-side. If a value-set widens the count past a configurable `maxCandidates`, sample the cross-product rather than enumerate all.

---

## 2. Candidate generator

Pure function: `*generateCandidates(reqs, frontage, searchConfig)` yields arrangement schemas (the §2 schema from the placement spec) — one per point in the discrete cross-product × continuous grid. It only *assembles* schemas from the program + knob values; it does not place anything. Yielding (generator) so Phase 3 can stream.

---

## 3. Scoring + gating each candidate

For each schema:
1. `realizeArrangement(schema, parcelLngLat, profile)` → realized elements + `feasible` flags.
2. **Gate on feasibility:** if any *required* element is `feasible:false`, **disqualify** — do not score, do not rank. (This is the optimizer-level gate; it does not require changing `score.js`.)
3. Shape realized elements into the `layout` object `score.js` expects, then `score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile)` → `{total, terms}`.
4. Record `{schema, realized, total, terms, feasible:true}`.

Same field-name caution as before: adapt `realizeArrangement` output to what `score.js` consumes — don't change `score.js`.

Return candidates sorted by `total` descending. Keep the full `terms` breakdown on each so you can inspect *why* the winner won.

---

## 4. Honest limits (stated, not designed around)

- This finds the **best-of-sampled per the current scorer** — not a provable global optimum (non-convex geometry) and not "objectively best" (scorer is uncalibrated by choice). More candidates ≠ better site unless the scorer ranks correctly. The optimizer faithfully chases whatever the scorer rewards.
- Search **breadth** is cheaper to add than scorer **quality** — widening value-sets is easy, but won't fix a wrong ranking. Keep that in mind before widening knobs to "search harder."

---

## Implementation phases — stop and test after each

**Phase 1 — exhaustive discrete search, synchronous.** Candidate generator (discrete cross-product + coarse continuous grid), realize + gate + score each, return ranked list with per-term breakdowns. *Test on one parcel: winner is sane, infeasibles are disqualified (not scored), breakdown explains the ranking. Confirm runtime is tolerable for the candidate count.*

**Phase 2 — local refinement.** Take top-K winners from Phase 1; locally refine the continuous knobs (`setbackFt`, `alignU`, basin offset) with a finer grid or hill-climb around each. *Test: refinement improves the top score over discrete-only, and the refined winner is still valid.*

**Phase 3 — worker + progressive UI.** Move the search into a Web Worker so the UI doesn't freeze; stream best-so-far as it runs; render top-N and let the user step through ranked candidates. *Test: UI stays responsive during a full search; user can browse the ranked list and see each candidate's breakdown.*

---

## Integration notes / knobs

- `searchConfig` (all value-sets, grids, `maxCandidates`, top-K) lives in the **profile** or a sibling config — not hardcoded in `optimize.js`. Different profiles search different spaces.
- `main.js`: switch the "optimize" action from the old basin search to `optimizeArrangement`, behind a flag until Phase 3 lands. Render the winner via existing `render.js`; Phase 3 adds the step-through UI.
- Do not touch `arrange.js` logic, `score.js` logic, or `ai.js`. This spec only consumes `realizeArrangement` and `score`.
- The AI schema-proposer (Gemini seeds candidate schemas) is a separate later spec; this optimizer is what it will feed into.
