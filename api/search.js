const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

function parseJSON(raw) {
  let text = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try { return JSON.parse(text); } catch (_) {}
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch (_) {} }
  throw new Error("Could not parse response as JSON");
}

function normalize(parsed) {
  return {
    ...parsed,
    brand_names:       Array.isArray(parsed.brand_names)       ? parsed.brand_names       : [],
    uses:              Array.isArray(parsed.uses)               ? parsed.uses              : [],
    contraindications: Array.isArray(parsed.contraindications)  ? parsed.contraindications : [],
    drug_interactions: Array.isArray(parsed.drug_interactions)  ? parsed.drug_interactions : [],
    warnings:          Array.isArray(parsed.warnings)           ? parsed.warnings          : [],
    side_effects: {
      common:  Array.isArray(parsed.side_effects?.common)  ? parsed.side_effects.common  : [],
      serious: Array.isArray(parsed.side_effects?.serious) ? parsed.side_effects.serious : [],
    },
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { medicine } = req.body;
  if (!medicine || medicine.trim().length < 2) return res.status(400).json({ error: "Please provide a medicine name." });

  const name = medicine.trim().slice(0, 100);

  const prompt = `You are a clinical pharmacist. Provide detailed information about: "${name}"

Return ONLY a valid JSON object, no markdown fences, no extra text:
{
  "brand_names": ["name1"],
  "generic_name": "string",
  "drug_class": "string",
  "uses": ["use1"],
  "how_it_works": "string",
  "common_dosage": "string",
  "side_effects": { "common": ["effect1"], "serious": ["effect1"] },
  "contraindications": ["item1"],
  "drug_interactions": ["item1"],
  "warnings": ["item1"],
  "storage": "string",
  "pregnancy_safety": "string",
  "otc_or_prescription": "OTC or Prescription or Both",
  "interesting_fact": "one surprising clinical fact"
}`;

  try {
    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 4096, responseMimeType: "application/json" },
      }),
    });

    const data = await geminiRes.json();
    if (!geminiRes.ok) throw new Error(data?.error?.message || `Gemini error ${geminiRes.status}`);

    const raw = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    const parsed = parseJSON(raw);
    res.status(200).json({ success: true, data: normalize(parsed) });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: err.message || "Search failed." });
  }
}
