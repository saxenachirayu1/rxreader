export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({
    status: "ok",
    model: "gemini-2.5-flash",
    time: new Date().toISOString(),
  });
}
