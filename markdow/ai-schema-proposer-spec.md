# AI Schema-Proposer — Spec

## Goal

On every Optimize run, Gemini auto-proposes a handful of *good starting arrangements* that get scored alongside the deterministic cross-product search and merged into the ranked list. The user never types a prompt. AI seeds the search with smart points; the deterministic engine owns all geometry; the scorer still decides.

---

## 1. The key decision: AI emits **knob-sets**, not schemas or coordinates

The AI does **not** output arrangement schemas or geometry. It outputs the same `knobs` object that `buildCandidateSchema(reqs, frontage, knobs)` in `optimize.js` already consumes:

```js
{ layout, gapFt, parkingFaces, driveways, basinCorner, setbackFt, alignU }
```

Why this and nothing richer:

- **Program stays fixed.** Building sizes, stall count, pond % come from `reqs` — injected by `buildCandidateSchema`, never from the model. The AI literally cannot hallucinate a building dimension because it never names one.
- **Same pipeline, zero new geometry path.** AI knob-sets flow through the *exact* existing path: `buildCandidateSchema` → `realizeArrangement` → feasibility gate → `score`. No new realize/score code, no second source of truth.
- **Validation is trivial** — it's the same whitelist-and-type-check pattern `ai.js` already does for hints (`VALID_CORNERS`, etc.).
- **It still adds real value:** the AI isn't limited to the enumerated grid. It can propose a `setbackFt: 42` or a specific knob *combination* the cross-product doesn't cover. Every value still passes through the feasibility gate, so a bad suggestion just scores low or gets disqualified — it can never produce an invalid plan.

So the AI's job: *given this parcel and program, propose N knob-sets a good site designer would actually try.* That's structure/taste — what the model is good at — with coordinates kept entirely out of its hands.

---

## 2. Where it runs (hard constraint from your architecture)

`optimizer-worker.js` runs in a **Web Worker with no `window`** — `config.js` sets `window.GEMINI_API_KEY` on the main thread only. The worker cannot read the key.

Therefore: **the Gemini call happens on the main thread, in `onOptimize` (main.js), before the worker is spawned.** The validated knob-sets are passed into the worker via the existing `postMessage` payload. All realizing/scoring stays inside the worker (where `turf` is monkey-patched for the JSTS union/difference bug — the seeds need that same patch, so they must be scored there, not on the main thread).

Flow:

```
onOptimize:
  1. assemble reqs, frontage, parcelSummary   (already have reqs/frontage)
  2. aiSeeds = await proposeArrangements(parcelSummary, reqs, frontage)   // main thread, timeout+fallback
  3. worker.postMessage({ parcelLatLng, reqs, frontage, profile, aiSeeds })
worker:
  4. score each aiSeed via buildCandidateSchema → realizeArrangement → gate → score, tag source:'ai'
  5. run normal generateCandidates search (unchanged)
  6. merge, sort, post ranked
```

---

## 3. `proposeArrangements()` in `ai.js`

Model it on the existing `parseInstructions` — same fetch, same fence-stripping, same `JSON.parse`, same sanitize discipline. Differences:

- **Fixed template with runtime data slots.** Wording is constant; inject parcel summary (acres, rough shape, frontage) and program (building count/sizes, stalls, pond %) each call.
- Instruct: *"Return ONLY a JSON array of N arrangement objects. Each object has exactly these keys: layout, gapFt, parkingFaces, driveways, basinCorner, setbackFt, alignU. No prose, no fences."* Paste the allowed values for each key (the value-sets from `profile.searchConfig`) into the prompt so the model stays in-vocabulary.
- `temperature: ~0.3` (some diversity across the N proposals; expose as a knob). `parseInstructions` uses 0 — keep that one at 0.
- **Timeout** (e.g. 4 s) wrapping the fetch. On timeout/error/junk → return `[]`.

### Validation (mirror `ai.js` sanitize, per knob)

For each proposed object, build a clean knob-set:
- `basinCorner` ∈ searchConfig.basinCorner else drop the object.
- `layout` ∈ searchConfig.layout else default `'strip'`.
- `parkingFaces`: string of `+`-joined faces; keep only known faces else default `'front'`.
- `driveways`: array of `entryU` strings ∈ {left,center,right}; else default `['center']`.
- `gapFt`, `setbackFt`: finite numbers in sane range (e.g. 0–200) else clamp/default.
- `alignU` ∈ {left,center,right} **or** a finite number (numeric u offsets are allowed — Phase 2 of the optimizer already produces them).

Drop any object that fails the required checks. Return the surviving array (possibly empty). **Never trust the model's JSON shape** — a malformed response degrades to fewer seeds, never to an error or a bad plan.

---

## 4. Wiring changes

- **`optimize.js`**: export `buildCandidateSchema` (currently module-internal). Change `optimizeArrangement(parcelLngLat, reqs, frontage, profile, onProgress)` → add `aiSeeds = []`. Before the `generateCandidates` loop, run each `aiSeeds` knob-set through the identical realize→gate→score block, push to `ranked` with `source:'ai'` on the candidate; tag generated candidates `source:'grid'`. Dedup by knob signature so an AI seed identical to a grid point isn't double-counted.
- **`optimizer-worker.js`**: read `aiSeeds` from `data`, pass to `optimizeArrangement`.
- **`main.js` `onOptimize`**: `await proposeArrangements(...)` with fallback to `[]`, add `aiSeeds` to `postMessage`. Status line: `"Proposing layouts…"` during the await. In `showSchemaOptimizerResult`, mark AI-sourced rows (e.g. a small "AI" tag on `source:'ai'` candidates) so you can see whether seeds are winning.
- **`ai.js`**: add `proposeArrangements`; leave `parseInstructions` and the manual AI-Hints box untouched (it stays as an optional manual override).

No changes to `arrange.js`, `score.js`, `solver.js`, `render.js`.

---

## 5. Fallback (mandatory)

If `proposeArrangements` returns `[]` (timeout, error, junk, or no key), `onOptimize` proceeds with `aiSeeds: []` and the run is *identical to today's deterministic search*. AI is purely additive — never required, never on the critical path for a working result. This preserves the self-sufficient-engine property.

---

## 6. Honest limits (keep in the spec where future-you sees them)

- This improves the **candidates**, not the **judgment**. Smarter seeds, same scorer — and the scorer is uncalibrated by choice. Expect "the search finds good layouts faster / finds combos the grid missed," not "the tool now picks objectively better sites." Only the scorer decides that.
- Watch the `source:'ai'` tags during testing: if AI seeds never out-rank grid candidates, the proposer is cost without benefit and you can cut it. The tag is how you find out.

---

## 7. Deploy prerequisite — HARD BLOCKER

Auto-firing means **every** Optimize hits Gemini from the user's browser on a client-readable key. This is the one item that turns "deploy later" into "cannot deploy":

- **Gemini key must be proxied through a backend** before any public deploy. There is no client-side restriction that protects it. Until the proxy exists, this feature runs **local only**.
- Maps key: lock with an HTTP-referrer restriction in Google Cloud Console (safe to keep client-side once restricted).
- Rotate both keys (they've been exposed in `config.js` and in chat). `config.js` is gitignored, so they're not in history — runtime exposure is the only issue, but rotate anyway.

This spec is buildable and testable locally now. Do not deploy it until the proxy is in place.

---

## Phases — stop and test after each

**Phase 1 — single fixed template, end to end.** `proposeArrangements` with one template + validation; wire into `onOptimize` → worker → scored seeds merged + tagged. *Test: AI seeds appear in the ranked list tagged "AI"; turning Gemini off (blank key) falls back to an identical run; a deliberately malformed model response degrades to `[]` with no error.*

**Phase 2 — bias variants + concurrency.** Several fixed templates (e.g. maximize road visibility / maximize parking / compact), each contributing seeds; fire Gemini concurrently with the deterministic worker instead of awaiting first, to hide latency. Richer parcel description (shape, not just acres). *Test: variety across seeds; UI responsive during the call; seeds from different templates show up.*

**Deploy phase (separate spec) — backend proxy.** Stand up a minimal proxy for the Gemini call, move the key server-side, rotate, lock the Maps key. Only then is any of this deployable.
