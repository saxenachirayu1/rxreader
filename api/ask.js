const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { prescription, question } = req.body;
  if (!prescription || !question) return res.status(400).json({ error: "Missing prescription or question." });

  const q = question.trim().slice(0, 500);

  const prompt = `You are a helpful medical assistant. The patient has this prescription:
${JSON.stringify(prescription, null, 2)}

Patient question: "${q}"

Answer in 2-4 clear, friendly sentences specific to their prescription. Start with a relevant emoji.`;

  try {
    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1024, responseMimeType: "text/plain" },
      }),
    });

    const data = await geminiRes.json();
    if (!geminiRes.ok) throw new Error(data?.error?.message || `Gemini error ${geminiRes.status}`);

    const answer = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim() || "";
    res.status(200).json({ success: true, answer });
  } catch (err) {
    console.error("Ask error:", err.message);
    res.status(500).json({ error: err.message || "Could not get answer." });
  }
}
