// NOTE: Both functions below call window.GEMINI_API_KEY, which is set on the main thread
// by config.js. Neither can run inside a Web Worker. This is local-only until the key
// is proxied through a backend — do NOT deploy with a client-readable key.

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const HINTS_PROMPT = `You are a civil site-planner assistant. Parse the user instruction into a JSON hints object.

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

  const res = await fetch(`${GEMINI_URL}?key=${window.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${HINTS_PROMPT}\n\nUser instruction: ${text}` }] }],
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
// Phase 2: fires three bias-variant prompts concurrently (Promise.allSettled),
// combines and deduplicates the results. Each template targets a different
// design priority so the AI seeds cover diverse regions of the knob space.
// Runs on the MAIN THREAD only — workers have no window.GEMINI_API_KEY.
// On any failure (timeout, error, bad JSON, missing key) → returns [] and the
// optimizer continues with the purely deterministic grid search unchanged.

const BIAS_TEMPLATES = [
  {
    name:  'visibility',
    bias:  'Maximize road visibility and curb appeal. Prefer a low setback (10–25 ft) so the building is prominent from the road, building centered or spanning the full frontage width, driveways at the center or flanks.',
    count: 2,
  },
  {
    name:  'parking',
    bias:  'Maximize parking convenience and throughput. Push the building well back (40–60 ft setback) to fit generous front parking rows, use multiple driveways for smooth traffic flow, tuck the detention basin in a rear corner.',
    count: 2,
  },
  {
    name:  'compact',
    bias:  'Compact, efficient layout with minimal wasted space. Use a moderate setback (20–35 ft), a single center driveway, and place the basin in whichever corner preserves the most continuous buildable area.',
    count: 2,
  },
];

// Stable knob signature for dedup — mirrors knobSig in optimize.js.
function _knobSig(k) {
  const dw = Array.isArray(k.driveways) ? [...k.driveways].sort().join(',') : String(k.driveways);
  return `${k.layout}|${k.gapFt}|${k.parkingFaces}|${dw}|${k.basinCorner}|${k.setbackFt}|${k.alignU}`;
}

// Validate and sanitize raw JSON objects from the model into clean knob-sets.
// Objects that fail required checks are dropped; optional fields get safe defaults.
function _validateSeeds(parsed, profile) {
  const { searchConfig } = profile;
  const VALID_LAYOUTS       = new Set(searchConfig.layout);
  const VALID_GAP_FTS       = searchConfig.gapFt;
  const VALID_PARKING_FACES = new Set(searchConfig.parkingFaces.flatMap(pf => pf.split('+')));
  const VALID_BASIN_CORNERS = new Set(searchConfig.basinCorner);
  const VALID_ENTRY_US      = new Set(['left', 'center', 'right']);

  const results = [];
  for (const obj of parsed) {
    if (!obj || typeof obj !== 'object') continue;
    if (!VALID_BASIN_CORNERS.has(obj.basinCorner)) continue; // required — drop if invalid

    const layout = VALID_LAYOUTS.has(obj.layout) ? obj.layout : 'strip';

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
}

// Fire one bias template and return its validated seeds (or [] on any failure).
async function _callTemplate(template, parcelSummary, reqs, frontage, profile) {
  const { searchConfig } = profile;
  const totalSqFt   = reqs.buildings.reduce((s, b) => s + b.length_ft * b.width_ft, 0);
  const aspectRatio = parcelSummary.widthFt / (parcelSummary.depthFt || 1);
  const shapeNote   = aspectRatio > 1.5 ? 'wide, shallow lot'
                    : aspectRatio < 0.67 ? 'narrow, deep lot'
                    : 'roughly square lot';

  const prompt = [
    `You are a civil site-planning expert. Design priority: ${template.bias}`,
    '',
    `Parcel: ${parcelSummary.acres.toFixed(2)} acres, ~${parcelSummary.widthFt} ft wide × ${parcelSummary.depthFt} ft deep (${shapeNote}). Road frontage: ${frontage} side.`,
    '',
    `Program: ${reqs.buildings.length} building(s) totaling ${totalSqFt.toLocaleString()} sq ft, ${reqs.parking_stalls} parking stalls, ${reqs.pondPct}% detention basin.`,
    '',
    `Return ONLY a JSON array of ${template.count} arrangement objects with exactly these keys:`,
    `  layout       — one of: ${JSON.stringify(searchConfig.layout)}`,
    `  gapFt        — one of: ${JSON.stringify(searchConfig.gapFt)}`,
    `  parkingFaces — one of: ${JSON.stringify(searchConfig.parkingFaces)}`,
    `  driveways    — one of: ${JSON.stringify(searchConfig.driveways)}`,
    `  basinCorner  — one of: ${JSON.stringify(searchConfig.basinCorner)}`,
    '  setbackFt    — a number from 5 to 60 (may be non-round, e.g. 18, 42)',
    '  alignU       — "left", "center", "right", or a number in feet (e.g. -60, 30)',
    'No prose, no markdown fences, no extra text. Output only the JSON array.',
  ].join('\n');

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 4000);

  try {
    let res;
    try {
      res = await fetch(`${GEMINI_URL}?key=${window.GEMINI_API_KEY}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  controller.signal,
        body: JSON.stringify({
          contents:         [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 256 },
        }),
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!res.ok) return [];
    const data    = await res.json();
    const raw     = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = raw.replace(/```(?:json)?\n?/g, '').replace(/```\n?/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch { return []; }
    if (!Array.isArray(parsed)) return [];
    return _validateSeeds(parsed, profile);
  } catch {
    return [];
  }
}

export async function proposeArrangements(parcelSummary, reqs, frontage, profile) {
  if (!window.GEMINI_API_KEY) return [];

  try {
    // All three bias templates fire concurrently — total latency ≈ slowest single call.
    const results = await Promise.allSettled(
      BIAS_TEMPLATES.map(t => _callTemplate(t, parcelSummary, reqs, frontage, profile))
    );

    // Combine and deduplicate across templates.
    const seenSigs = new Set();
    const combined = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const seed of r.value) {
        const sig = _knobSig(seed);
        if (seenSigs.has(sig)) continue;
        seenSigs.add(sig);
        combined.push(seed);
      }
    }
    return combined;
  } catch {
    return [];
  }
}
