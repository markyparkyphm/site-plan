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
