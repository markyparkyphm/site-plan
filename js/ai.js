// NOTE: Both functions below call window.GEMINI_API_KEY, which is set on the main thread
// by config.js. Neither can run inside a Web Worker. This is local-only until the key
// is proxied through a backend — do NOT deploy with a client-readable key.

const PROMPT = `You are a civil site-planner assistant. Parse the user instruction into a JSON hints object.

Allowed fields (omit any field not mentioned by the user):
- setbackFt: number (setback from parcel edge, in feet)
- clearanceFt: number (minimum clearance between buildings, in feet)
- basinCorner: one of "SW" | "SE" | "NW" | "NE" (which corner to place the detention basin)
- orientationPreference: one of "NS" | "EW" | "auto" (preferred building axis)
- frontage: one of "N" | "S" | "E" | "W" (which parcel edge fronts the road)

Output ONLY valid JSON. No explanation, no markdown fences, no extra text.`;

const VALID_CORNERS  = ['SW', 'SE', 'NW', 'NE'];
const VALID_ORIENTS  = ['NS', 'EW', 'auto'];
const VALID_FRONTAGE = ['N', 'S', 'E', 'W'];

export async function parseInstructions(text) {
  if (!window.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set in config.js');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${window.GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${PROMPT}\n\nUser instruction: ${text}` }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 256 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  // Strip markdown fences the model sometimes adds despite instructions
  const cleaned = raw.replace(/```(?:json)?\n?/g, '').replace(/```\n?/g, '').trim();

  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch { throw new Error(`AI returned invalid JSON: ${raw.slice(0, 120)}`); }

  // Sanitize — reject unexpected fields and wrong types
  const hints = {};
  if (typeof parsed.setbackFt === 'number' && parsed.setbackFt > 0)
    hints.setbackFt = parsed.setbackFt;
  if (typeof parsed.clearanceFt === 'number' && parsed.clearanceFt > 0)
    hints.clearanceFt = parsed.clearanceFt;
  if (VALID_CORNERS.includes(parsed.basinCorner))
    hints.basinCorner = parsed.basinCorner;
  if (VALID_ORIENTS.includes(parsed.orientationPreference))
    hints.orientationPreference = parsed.orientationPreference;
  if (VALID_FRONTAGE.includes(parsed.frontage))
    hints.frontage = parsed.frontage;

  return hints;
}

// ---------------------------------------------------------------------------
// Auto-proposer: proposeArrangements(parcelSummary, reqs, frontage, profile)
// ---------------------------------------------------------------------------
// Calls Gemini to propose N knob-sets for buildCandidateSchema. Runs on the
// MAIN THREAD only (workers have no window and cannot read GEMINI_API_KEY).
// On timeout / error / bad JSON / missing key → returns [] so the optimizer
// continues with the purely deterministic grid search unchanged.

export async function proposeArrangements(parcelSummary, reqs, frontage, profile) {
  if (!window.GEMINI_API_KEY) return [];

  const { searchConfig } = profile;
  const totalSqFt = reqs.buildings.reduce((s, b) => s + b.length_ft * b.width_ft, 0);

  const prompt = [
    'You are a civil site-planning expert. Propose 5 arrangement knob-sets for this parcel and program.',
    '',
    `Parcel: ${parcelSummary.acres.toFixed(2)} acres, ~${parcelSummary.widthFt} ft wide × ${parcelSummary.depthFt} ft deep. Road frontage on the ${frontage} side.`,
    '',
    `Program: ${reqs.buildings.length} building(s) totaling ${totalSqFt.toLocaleString()} sq ft, ${reqs.parking_stalls} parking stalls, ${reqs.pondPct}% detention basin.`,
    '',
    'Return ONLY a JSON array of 5 objects. Each must have exactly these keys:',
    `  layout       — one of: ${JSON.stringify(searchConfig.layout)}`,
    `  gapFt        — one of: ${JSON.stringify(searchConfig.gapFt)}`,
    `  parkingFaces — one of: ${JSON.stringify(searchConfig.parkingFaces)}`,
    `  driveways    — one of: ${JSON.stringify(searchConfig.driveways)}`,
    `  basinCorner  — one of: ${JSON.stringify(searchConfig.basinCorner)}`,
    '  setbackFt    — a number from 5 to 60 (may be non-round, e.g. 18, 42)',
    '  alignU       — "left", "center", "right", or a number in feet (e.g. -60, 30)',
    '',
    'Vary basin corner, setback depth, driveway position, and lateral alignment across the 5 proposals.',
    'No prose, no markdown fences, no extra text. Output only the JSON array.',
  ].join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${window.GEMINI_API_KEY}`;

  try {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 4000);

    let res;
    try {
      res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  controller.signal,
        body: JSON.stringify({
          contents:         [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 512 },
        }),
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) return [];

    const data = await res.json();
    const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = raw.replace(/```(?:json)?\n?/g, '').replace(/```\n?/g, '').trim();

    let parsed;
    try { parsed = JSON.parse(cleaned); } catch { return []; }
    if (!Array.isArray(parsed)) return [];

    const VALID_LAYOUTS       = new Set(searchConfig.layout);
    const VALID_GAP_FTS       = searchConfig.gapFt; // array — snap to nearest
    const VALID_PARKING_FACES = new Set(searchConfig.parkingFaces.flatMap(pf => pf.split('+')));
    const VALID_BASIN_CORNERS = new Set(searchConfig.basinCorner);
    const VALID_ENTRY_US      = new Set(['left', 'center', 'right']);

    const results = [];
    for (const obj of parsed) {
      if (!obj || typeof obj !== 'object') continue;

      // basinCorner is required — drop the entire object if invalid
      if (!VALID_BASIN_CORNERS.has(obj.basinCorner)) continue;

      const layout = VALID_LAYOUTS.has(obj.layout) ? obj.layout : 'strip';

      // snap gapFt to the nearest value in the valid set
      let gapFt = VALID_GAP_FTS[0];
      if (typeof obj.gapFt === 'number' && isFinite(obj.gapFt)) {
        gapFt = VALID_GAP_FTS.reduce(
          (best, v) => Math.abs(v - obj.gapFt) < Math.abs(best - obj.gapFt) ? v : best
        );
      }

      const parkingFaces = (
        typeof obj.parkingFaces === 'string' &&
        obj.parkingFaces.split('+').every(f => VALID_PARKING_FACES.has(f))
      ) ? obj.parkingFaces : searchConfig.parkingFaces[0];

      const driveways = (
        Array.isArray(obj.driveways) && obj.driveways.length > 0 &&
        obj.driveways.every(d => VALID_ENTRY_US.has(d))
      ) ? obj.driveways : ['center'];

      const setbackFt = (
        typeof obj.setbackFt === 'number' && isFinite(obj.setbackFt) &&
        obj.setbackFt >= 0 && obj.setbackFt <= 200
      ) ? obj.setbackFt : 25;

      let alignU;
      if (typeof obj.alignU === 'number' && isFinite(obj.alignU)) {
        alignU = obj.alignU;
      } else if (VALID_ENTRY_US.has(obj.alignU)) {
        alignU = obj.alignU;
      } else {
        alignU = 'center';
      }

      results.push({ layout, gapFt, parkingFaces, driveways, basinCorner: obj.basinCorner, setbackFt, alignU });
    }

    return results;
  } catch {
    return [];
  }
}
