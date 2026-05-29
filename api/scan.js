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

function normalize(raw) {
  return {
    patient_name:     raw.patient_name     || null,
    patient_age:      raw.patient_age      || null,
    patient_weight:   raw.patient_weight   || null,
    doctor_name:      raw.doctor_name      || null,
    hospital:         raw.hospital         || null,
    date:             raw.date             || null,
    complaints:       Array.isArray(raw.complaints)  ? raw.complaints  : [],
    medications:      Array.isArray(raw.medications) ? raw.medications.map(m => ({
      name:      m.name      || "Unknown",
      dosage:    m.dosage    || null,
      frequency: m.frequency || null,
      duration:  m.duration  || null,
      route:     m.route     || null,
      notes:     m.notes     || null,
    })) : [],
    instructions:     raw.instructions     || null,
    nebulization:     raw.nebulization     || null,
    follow_up:        raw.follow_up        || null,
    raw_text:         raw.raw_text         || "",
    confidence:       raw.confidence       || "medium",
    unclear_parts:    Array.isArray(raw.unclear_parts) ? raw.unclear_parts : [],
    language_detected: raw.language_detected || "english",
  };
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { image, mime } = req.body;

  if (!image || !mime) return res.status(400).json({ error: "Missing image or mime field." });
  if (!mime.startsWith("image/")) return res.status(400).json({ error: "Only image files supported." });

  const sizeBytes = Buffer.byteLength(image, "base64");
  if (sizeBytes > 10 * 1024 * 1024) return res.status(400).json({ error: "Image too large. Use a smaller photo." });

  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "Server misconfigured — API key missing." });

  const prompt = `You are an expert medical transcription AI. Carefully analyze this prescription image.

Return ONLY a valid JSON object, no markdown fences, no extra text:
{
  "patient_name": "string or null",
  "patient_age": "string or null",
  "patient_weight": "string or null",
  "doctor_name": "string or null",
  "hospital": "string or null",
  "date": "string or null",
  "complaints": ["symptom1"],
  "medications": [
    { "name": "string", "dosage": "string or null", "frequency": "string or null", "duration": "string or null", "route": "string or null", "notes": "string or null" }
  ],
  "instructions": "string or null",
  "nebulization": "string or null",
  "follow_up": "string or null",
  "raw_text": "verbatim transcription of all handwritten text",
  "confidence": "high or medium or low",
  "unclear_parts": ["part1"],
  "language_detected": "english or hindi or mixed"
}`;

  try {
    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mime, data: image } },
            { text: prompt },
          ]
        }],
        generationConfig: { maxOutputTokens: 8192, responseMimeType: "application/json" },
      }),
    });

    const data = await geminiRes.json();
    if (!geminiRes.ok) throw new Error(data?.error?.message || `Gemini error ${geminiRes.status}`);

    const raw = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    const parsed = parseJSON(raw);
    res.status(200).json({ success: true, data: normalize(parsed) });
  } catch (err) {
    console.error("Scan error:", err.message);
    if (err.message.includes("429")) return res.status(429).json({ error: "Rate limit reached. Wait 60 seconds." });
    res.status(500).json({ error: err.message || "Scan failed." });
  }
}
