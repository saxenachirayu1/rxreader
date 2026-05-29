import { useState, useRef, useEffect } from "react";

// On Vercel, API functions live at /api — no separate backend needed
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
const KEY_STORAGE = "rxreader_api_key";

// ── Helpers ────────────────────────────────────────────────────────────────────

function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result.split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// Compress + resize image before sending to API
// Max 1920px on longest side, JPEG quality 0.82
// Prevents crashes on large phone camera images (10MB+)
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = e => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const MAX = 1920;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          if (width > height) { height = Math.round(height * MAX / width); width = MAX; }
          else { width = Math.round(width * MAX / height); height = MAX; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob(blob => {
          if (!blob) { reject(new Error("Image compression failed")); return; }
          const reader2 = new FileReader();
          reader2.onload = e2 => resolve({
            base64: e2.target.result.split(",")[1],
            mime: "image/jpeg",
            sizeKB: Math.round(blob.size / 1024),
          });
          reader2.onerror = reject;
          reader2.readAsDataURL(blob);
        }, "image/jpeg", 0.82);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function parseJSON(raw) {
  // Strip markdown fences (Gemini often adds these despite being told not to)
  let text = raw.trim();
  // Remove opening fence
  text = text.replace(/^```(?:json)?\s*/i, "");
  // Remove closing fence
  text = text.replace(/\s*```\s*$/i, "");
  text = text.trim();
  try { return JSON.parse(text); } catch (_) {}
  // Fallback: extract first { ... } block
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch (_) {} }
  throw new Error("Could not parse model response as JSON:\n" + text.slice(0, 300));
}

function normalizePrescription(raw) {
  return {
    patient_name:    raw.patient_name    || null,
    patient_age:     raw.patient_age     || null,
    patient_weight:  raw.patient_weight  || null,
    doctor_name:     raw.doctor_name     || null,
    hospital:        raw.hospital        || null,
    date:            raw.date            || null,
    complaints:      Array.isArray(raw.complaints)    ? raw.complaints    : [],
    medications:     Array.isArray(raw.medications)   ? raw.medications.map(m => ({
      name:      m.name      || "Unknown",
      dosage:    m.dosage    || null,
      frequency: m.frequency || null,
      duration:  m.duration  || null,
      route:     m.route     || null,
      notes:     m.notes     || null,
    })) : [],
    instructions:    raw.instructions    || null,
    nebulization:    raw.nebulization    || null,
    follow_up:       raw.follow_up       || null,
    raw_text:        raw.raw_text        || "",
    confidence:      raw.confidence      || "medium",
    unclear_parts:   Array.isArray(raw.unclear_parts) ? raw.unclear_parts : [],
    language_detected: raw.language_detected || "english",
  };
}

function normalizeSearch(raw) {
  return {
    ...raw,
    brand_names:      Array.isArray(raw.brand_names)      ? raw.brand_names      : [],
    uses:             Array.isArray(raw.uses)              ? raw.uses             : [],
    contraindications:Array.isArray(raw.contraindications)? raw.contraindications: [],
    drug_interactions:Array.isArray(raw.drug_interactions) ? raw.drug_interactions: [],
    warnings:         Array.isArray(raw.warnings)          ? raw.warnings         : [],
    side_effects: {
      common:  Array.isArray(raw.side_effects?.common)  ? raw.side_effects.common  : [],
      serious: Array.isArray(raw.side_effects?.serious) ? raw.side_effects.serious : [],
    },
  };
}

// ── API calls ──────────────────────────────────────────────────────────────────

async function extractPrescription(_apiKey, base64, mime) {
  const res = await fetch(`${BACKEND_URL}/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: base64, mime }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || `Server error ${res.status}`);
  return normalizePrescription(json.data);
}

async function searchMedicine(_apiKey, medicineName) {
  const res = await fetch(`${BACKEND_URL}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ medicine: medicineName }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || `Server error ${res.status}`);
  return normalizeSearch(json.data);
}

async function askFollowUp(_apiKey, prescription, question) {
  const res = await fetch(`${BACKEND_URL}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prescription, question }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || "Could not get answer.");
  return json.answer;
}

// ── Design tokens ──────────────────────────────────────────────────────────────

const C = {
  teal: "#0d9488", tealLight: "#ccfbf1", tealDark: "#0f766e",
  navy: "#0f172a", slate: "#1e293b", slateLight: "#334155",
  muted: "#64748b", border: "#e2e8f0", bg: "#f8fafc", white: "#ffffff",
  red: "#ef4444", redLight: "#fef2f2",
  amber: "#f59e0b", amberLight: "#fffbeb",
  green: "#10b981", greenLight: "#ecfdf5",
  blue: "#3b82f6", blueLight: "#eff6ff",
};

const globalCss = `
  @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { height: 100%; }
  body { font-family: 'Sora', sans-serif; background: ${C.bg}; color: ${C.navy}; }
  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }

  @keyframes fadeUp { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
  @keyframes spin   { to { transform: rotate(360deg) } }
  @keyframes scanBar { 0%,100% { top:4% } 50% { top:88% } }

  .fade-up   { animation: fadeUp .3s ease both; }
  .fade-up-2 { animation: fadeUp .3s .08s ease both; }
  .fade-up-3 { animation: fadeUp .3s .16s ease both; }

  .spinner {
    display: inline-block; width: 16px; height: 16px;
    border: 2px solid rgba(13,148,136,.2);
    border-top-color: ${C.teal};
    border-radius: 50%; animation: spin .7s linear infinite;
  }

  button { font-family: 'Sora', sans-serif; cursor: pointer; }

  .btn {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 9px 18px; border-radius: 10px; font-size: 14px; font-weight: 500;
    border: none; transition: all .18s; white-space: nowrap;
  }
  .btn:active { transform: scale(.97); }
  .btn:disabled { opacity: .45; cursor: not-allowed; transform: none !important; }
  .btn-primary  { background: ${C.teal}; color: #fff; }
  .btn-primary:hover:not(:disabled)  { background: ${C.tealDark}; }
  .btn-secondary { background: #fff; color: ${C.navy}; border: 1.5px solid ${C.border}; }
  .btn-secondary:hover:not(:disabled) { border-color: ${C.teal}; color: ${C.teal}; }
  .btn-ghost { background: transparent; color: ${C.muted}; padding: 7px 11px; }
  .btn-ghost:hover:not(:disabled) { background: ${C.bg}; color: ${C.navy}; }

  .card { background: #fff; border-radius: 14px; border: 1px solid ${C.border}; }
  .card-p { padding: 18px 20px; }

  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 9px; border-radius: 99px;
    font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase;
  }
  .badge-teal   { background: ${C.tealLight};  color: ${C.tealDark}; }
  .badge-green  { background: ${C.greenLight}; color: #065f46; }
  .badge-amber  { background: ${C.amberLight}; color: #92400e; }
  .badge-red    { background: ${C.redLight};   color: #991b1b; }
  .badge-blue   { background: ${C.blueLight};  color: #1e40af; }
  .badge-gray   { background: #f1f5f9; color: ${C.slateLight}; }

  input, textarea {
    font-family: 'Sora', sans-serif;
    width: 100%; padding: 10px 14px; border-radius: 10px;
    border: 1.5px solid ${C.border}; font-size: 14px; outline: none;
    background: ${C.bg}; color: ${C.navy}; transition: border-color .18s;
  }
  input:focus, textarea:focus { border-color: ${C.teal}; background: #fff; }

  .nav-item {
    display: flex; align-items: center; gap: 11px; padding: 10px 13px;
    border-radius: 10px; border: none; width: 100%; text-align: left;
    font-size: 14px; font-weight: 500; transition: all .15s; cursor: pointer;
  }
`;

// ── Small shared UI pieces ─────────────────────────────────────────────────────

function Spinner({ size = 16 }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

function Err({ msg }) {
  return (
    <div style={{ padding: "12px 16px", background: C.redLight, borderRadius: 12,
      color: "#991b1b", fontSize: 14, marginTop: 12, display: "flex", gap: 8, alignItems: "flex-start" }}>
      ⚠ {msg}
    </div>
  );
}

// ── ApiKeyGate ─────────────────────────────────────────────────────────────────

function ApiKeyGate({ onKey }) {
  const [val, setVal] = useState("");
  const [show, setShow] = useState(false);
  const submit = () => {
    const k = val.trim();
    if (!k.startsWith("AIza")) return alert("Gemini API keys start with AIza — paste the key from aistudio.google.com");
    localStorage.setItem(KEY_STORAGE, k);
    onKey(k);
  };
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.navy }}>
      <div className="card" style={{ maxWidth: 440, width: "90%", padding: 36 }}>
        <div style={{ width: 52, height: 52, background: C.teal, borderRadius: 14, display: "flex",
          alignItems: "center", justifyContent: "center", marginBottom: 20 }}>
          <span style={{ fontSize: 26 }}>💊</span>
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>RxReader</h1>
        <p style={{ color: C.muted, fontSize: 14, marginBottom: 24, lineHeight: 1.6 }}>
          Enter your Google Gemini API key to get started. It's stored only in your browser — free to use, no credit card needed.
        </p>
        <div style={{ position: "relative", marginBottom: 14 }}>
          <input
            type={show ? "text" : "password"}
            placeholder="sk-ant-api03-..."
            value={val}
            onChange={e => setVal(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
            style={{ paddingRight: 44 }}
          />
          <button onClick={() => setShow(s => !s)} style={{
            position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
            background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18
          }}>{show ? "🙈" : "👁"}</button>
        </div>
        <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", padding: "11px" }} onClick={submit}>
          Continue →
        </button>
        <p style={{ fontSize: 12, color: C.muted, marginTop: 16, textAlign: "center" }}>
          Get a key free at <a href="https://aistudio.google.com" target="_blank" rel="noreferrer" style={{ color: C.teal }}>aistudio.google.com</a> → Sign in → Get API Key
        </p>
      </div>
    </div>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────────

function Sidebar({ active, setActive, history, selectedPatient, onSelectPatient, onClearKey }) {
  return (
    <div style={{ width: 252, minHeight: "100vh", background: C.navy, display: "flex",
      flexDirection: "column", flexShrink: 0, position: "sticky", top: 0, height: "100vh", overflowY: "auto" }}>

      {/* Logo */}
      <div style={{ padding: "26px 20px 18px", borderBottom: "1px solid rgba(255,255,255,.07)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 38, height: 38, background: C.teal, borderRadius: 11,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>💊</div>
          <div>
            <div style={{ color: "#fff", fontWeight: 700, fontSize: 17, letterSpacing: "-.02em" }}>RxReader</div>
            <div style={{ color: "rgba(255,255,255,.35)", fontSize: 11 }}>AI Prescription Decoder</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <div style={{ padding: "14px 10px", display: "flex", flexDirection: "column", gap: 3 }}>
        {[
          { id: "scan",    icon: "🔍", label: "Scan Prescription" },
          { id: "search",  icon: "💊", label: "Medicine Search" },
          { id: "history", icon: "📋", label: "Patient History" },
        ].map(n => (
          <button key={n.id} className="nav-item" onClick={() => setActive(n.id)} style={{
            background: active === n.id ? C.teal : "transparent",
            color: active === n.id ? "#fff" : "rgba(255,255,255,.5)",
          }}>
            <span style={{ fontSize: 16 }}>{n.icon}</span> {n.label}
          </button>
        ))}
      </div>

      {/* Recent patients */}
      {history.length > 0 && (
        <div style={{ padding: "6px 10px", flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ color: "rgba(255,255,255,.28)", fontSize: 10, fontWeight: 600,
            letterSpacing: ".08em", textTransform: "uppercase", padding: "8px 4px 8px" }}>
            Recent Patients
          </div>
          <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
            {history.map(rec => {
              const name = rec.data?.patient_name || "Unknown";
              const initials = name.split(" ").map(w => w[0] || "").join("").slice(0, 2).toUpperCase() || "?";
              const isActive = selectedPatient?.id === rec.id;
              const hue = (name.charCodeAt(0) * 53 + name.charCodeAt(1) * 17) % 360;
              return (
                <button key={rec.id} onClick={() => { onSelectPatient(rec); setActive("history"); }}
                  style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 10px",
                    borderRadius: 8, border: "none", cursor: "pointer", textAlign: "left", width: "100%",
                    background: isActive ? "rgba(13,148,136,.22)" : "transparent", transition: "all .14s" }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                    background: `hsl(${hue},40%,28%)`,
                    display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ color: "#fff", fontSize: 11, fontWeight: 600 }}>{initials}</span>
                  </div>
                  <div style={{ overflow: "hidden" }}>
                    <div style={{ color: isActive ? C.tealLight : "rgba(255,255,255,.78)",
                      fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {name}
                    </div>
                    <div style={{ color: "rgba(255,255,255,.28)", fontSize: 10 }}>
                      {rec.data?.date || formatDate(rec.timestamp).split(",")[0]}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{ padding: "14px 18px", borderTop: "1px solid rgba(255,255,255,.06)", marginTop: "auto" }}>

        <div style={{ color: "rgba(255,255,255,.18)", fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
          For reference only — always consult your doctor
        </div>
      </div>
    </div>
  );
}

// ── DropZone ───────────────────────────────────────────────────────────────────

function DropZone({ onFile, loading }) {
  const [drag, setDrag] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const fileRef = useRef();
  const videoRef = useRef();
  const streamRef = useRef();

  const handleFile = file => {
    if (!file || !file.type.startsWith("image/")) return;
    onFile(file);
  };

  // Attach stream to video element whenever cameraOpen becomes true
  // useEffect handles the async timing race on mobile browsers
  useEffect(() => {
    if (!cameraOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        // videoRef.current is guaranteed to exist now because cameraOpen=true has rendered the <video>
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      } catch (err) {
        if (!cancelled) {
          setCameraOpen(false);
          const msg = err.name === "NotAllowedError"
            ? "Camera permission denied. Allow camera access in your browser settings."
            : err.name === "NotFoundError"
            ? "No camera found on this device."
            : "Camera not accessible. Please upload an image instead.";
          alert(msg);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [cameraOpen]);

  const startCamera = () => setCameraOpen(true);

  const capture = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) { alert("Camera not ready yet, try again."); return; }
    const c = document.createElement("canvas");
    // Capture at full resolution
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    c.toBlob(blob => {
      if (!blob) { alert("Capture failed, try again."); return; }
      stopCamera();
      // Pass as File — compressImage in handleFile will resize it
      handleFile(new File([blob], "capture.jpg", { type: "image/jpeg" }));
    }, "image/jpeg", 1.0); // full quality — compressImage handles reduction
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setCameraOpen(false);
  };

  if (cameraOpen) return (
    <div style={{ position: "relative", borderRadius: 18, overflow: "hidden", background: "#000", aspectRatio: "4/3" }}>
      <video ref={videoRef} autoPlay playsInline style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      {/* scan overlay */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        <div style={{ position: "absolute", top: "8%", left: "8%", right: "8%", bottom: "8%",
          border: `2px solid rgba(13,148,136,.7)`, borderRadius: 10 }}>
          <div style={{ position: "absolute", left: 0, right: 0, height: 2,
            background: `linear-gradient(90deg,transparent,${C.teal},transparent)`,
            animation: "scanBar 2s ease-in-out infinite" }} />
        </div>
      </div>
      <div style={{ position: "absolute", bottom: 20, left: 0, right: 0,
        display: "flex", justifyContent: "center", gap: 12 }}>
        <button className="btn btn-secondary" onClick={stopCamera}>✕ Cancel</button>
        <button className="btn btn-primary" onClick={capture} style={{ padding: "10px 28px" }}>📸 Capture</button>
      </div>
    </div>
  );

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}
      onClick={() => !loading && fileRef.current.click()}
      style={{
        border: `2px dashed ${drag ? C.teal : C.border}`,
        borderRadius: 18, padding: "48px 24px", textAlign: "center",
        background: drag ? C.tealLight : "#fff", cursor: loading ? "default" : "pointer",
        transition: "all .2s",
      }}
    >
      <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
        onChange={e => handleFile(e.target.files[0])} />

      {loading ? (
        <>
          <div style={{ marginBottom: 14 }}><Spinner size={36} /></div>
          <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4 }}>Reading prescription…</div>
          <div style={{ color: C.muted, fontSize: 13 }}>Claude is analysing the handwriting</div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📄</div>
          <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4 }}>
            Drop a prescription image here
          </div>
          <div style={{ color: C.muted, fontSize: 13, marginBottom: 22 }}>
            JPG · PNG · WEBP — or use your camera
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={e => { e.stopPropagation(); startCamera(); }}>
              📷 Camera
            </button>
            <button className="btn btn-secondary" onClick={e => { e.stopPropagation(); fileRef.current.click(); }}>
              ⬆ Upload file
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── MedCard ────────────────────────────────────────────────────────────────────

function MedCard({ med, onSearch }) {
  return (
    <div className="card fade-up" style={{ marginBottom: 10 }}>
      <div className="card-p" style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: C.tealLight,
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 18 }}>
          💊
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{med.name}</span>
            {med.dosage && <span className="badge badge-gray">{med.dosage}</span>}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: med.notes ? 8 : 0 }}>
            {med.frequency && <span className="badge badge-blue">{med.frequency}</span>}
            {med.duration  && <span className="badge badge-teal">{med.duration}</span>}
            {med.route     && <span className="badge badge-gray">{med.route}</span>}
          </div>
          {med.notes && <div style={{ fontSize: 13, color: C.muted, fontStyle: "italic" }}>📝 {med.notes}</div>}
        </div>
        <button className="btn btn-ghost" style={{ fontSize: 12, flexShrink: 0 }} onClick={() => onSearch(med.name)}>
          🔎 Look up
        </button>
      </div>
    </div>
  );
}

// ── AskAI ──────────────────────────────────────────────────────────────────────

function AskAI({ apiKey, prescription }) {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const suggestions = [
    "Can I take these medicines together?",
    "What side effects should I watch for?",
    "Before or after meals?",
    "Can my child take these safely?",
  ];

  const ask = async question => {
    setLoading(true); setAnswer(null); setErr(null);
    try { setAnswer(await askFollowUp(apiKey, prescription, question)); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="card-p">
        <div style={{ fontWeight: 600, marginBottom: 12 }}>⚡ Ask about this prescription</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {suggestions.map(s => (
            <button key={s} className="btn btn-secondary" style={{ fontSize: 12, padding: "5px 11px", borderRadius: 99 }}
              onClick={() => { setQ(s); ask(s); }}>
              {s}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === "Enter" && q.trim() && ask(q)}
            placeholder="Type any question…" style={{ flex: 1 }} />
          <button className="btn btn-primary" disabled={!q.trim() || loading} onClick={() => ask(q)}
            style={{ flexShrink: 0 }}>
            {loading ? <Spinner /> : "→"}
          </button>
        </div>
        {err && <Err msg={err} />}
        {answer && (
          <div style={{ marginTop: 14, padding: "12px 16px", background: C.greenLight,
            borderRadius: 10, fontSize: 14, lineHeight: 1.7, borderLeft: `3px solid ${C.green}` }}>
            {answer}
          </div>
        )}
      </div>
    </div>
  );
}

// ── PrescriptionResult ─────────────────────────────────────────────────────────

function PrescriptionResult({ apiKey, data, imageUrl, onSearch, onSave, saved }) {
  const [copied, setCopied] = useState(false);
  const conf = data.confidence || "medium";

  const copy = () => {
    navigator.clipboard.writeText(data.raw_text || "").then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div className="fade-up">
      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontWeight: 700, fontSize: 22, marginBottom: 3 }}>
            {data.patient_name || "Prescription"}
          </h2>
          <div style={{ color: C.muted, fontSize: 13 }}>
            {[data.hospital, data.doctor_name, data.date].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
          <span className={`badge badge-${conf === "high" ? "green" : conf === "medium" ? "amber" : "red"}`}>
            {conf === "high" ? "✓" : "⚠"} {conf} confidence
          </span>
          <button className="btn btn-secondary" style={{ fontSize: 12, padding: "6px 12px" }} onClick={copy}>
            {copied ? "✓ Copied" : "📋 Copy text"}
          </button>
          {!saved && (
            <button className="btn btn-primary" style={{ fontSize: 12, padding: "6px 12px" }} onClick={onSave}>
              💾 Save to history
            </button>
          )}
          {saved && <span className="badge badge-green">✓ Saved</span>}
        </div>
      </div>

      {/* Meta grid + image */}
      <div style={{ display: "grid", gridTemplateColumns: imageUrl ? "1fr 220px" : "1fr", gap: 12, marginBottom: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {[
            ["Patient",      data.patient_name],
            ["Age / Weight", [data.patient_age, data.patient_weight].filter(Boolean).join(" · ") || null],
            ["Doctor",       data.doctor_name],
            ["Date",         data.date],
          ].map(([label, val]) => val ? (
            <div key={label} className="card">
              <div className="card-p" style={{ padding: "12px 16px" }}>
                <div style={{ color: C.muted, fontSize: 11, fontWeight: 600, textTransform: "uppercase",
                  letterSpacing: ".05em", marginBottom: 3 }}>{label}</div>
                <div style={{ fontWeight: 500, fontSize: 14 }}>{val}</div>
              </div>
            </div>
          ) : null)}
        </div>
        {imageUrl && (
          <div className="card" style={{ overflow: "hidden", padding: 0 }}>
            <img src={imageUrl} alt="Prescription" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
          </div>
        )}
      </div>

      {/* Complaints */}
      {data.complaints.length > 0 && (
        <div className="card fade-up-2" style={{ marginBottom: 12 }}>
          <div className="card-p">
            <div style={{ fontWeight: 600, marginBottom: 10 }}>🤒 Complaints / Diagnosis</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {data.complaints.map((c, i) => <span key={i} className="badge badge-red">{c}</span>)}
            </div>
          </div>
        </div>
      )}

      {/* Medications */}
      {data.medications.length > 0 && (
        <div className="fade-up-2" style={{ marginBottom: 4 }}>
          <div style={{ fontWeight: 600, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
            💊 Medications
            <span className="badge badge-teal">{data.medications.length}</span>
          </div>
          {data.medications.map((m, i) => <MedCard key={i} med={m} onSearch={onSearch} />)}
        </div>
      )}

      {/* Nebulization */}
      {data.nebulization && (
        <div className="card fade-up-3" style={{ marginBottom: 12, borderLeft: `3px solid ${C.blue}` }}>
          <div className="card-p">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>💨 Nebulization</div>
            <div style={{ fontSize: 14, color: C.slateLight, lineHeight: 1.7 }}>{data.nebulization}</div>
          </div>
        </div>
      )}

      {/* Instructions */}
      {data.instructions && (
        <div className="card fade-up-3" style={{ marginBottom: 12 }}>
          <div className="card-p">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>📋 Instructions</div>
            <div style={{ fontSize: 14, color: C.slateLight, lineHeight: 1.7 }}>{data.instructions}</div>
          </div>
        </div>
      )}

      {/* Unclear parts */}
      {data.unclear_parts.length > 0 && (
        <div style={{ padding: "12px 16px", background: C.amberLight, borderRadius: 12,
          marginBottom: 12, fontSize: 13, borderLeft: `3px solid ${C.amber}` }}>
          <strong>⚠ Verify with pharmacist:</strong> {data.unclear_parts.join(", ")}
        </div>
      )}

      {/* Raw text */}
      <div className="card fade-up-3" style={{ marginBottom: 14 }}>
        <div className="card-p">
          <div style={{ fontWeight: 600, marginBottom: 8, color: C.muted, fontSize: 13 }}>Raw Transcription</div>
          <pre style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13,
            whiteSpace: "pre-wrap", color: C.slateLight, lineHeight: 1.75 }}>
            {data.raw_text || "(nothing extracted)"}
          </pre>
        </div>
      </div>

      <AskAI apiKey={apiKey} prescription={data} />
    </div>
  );
}

// ── MedicineSearch ─────────────────────────────────────────────────────────────

function MedicineSearch({ apiKey, initialQuery }) {
  const [query, setQuery] = useState(initialQuery || "");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (initialQuery) { setQuery(initialQuery); doSearch(initialQuery); }
    // eslint-disable-next-line
  }, [initialQuery]);

  const doSearch = async q => {
    if (!q.trim()) return;
    setLoading(true); setResult(null); setErr(null);
    try { setResult(await searchMedicine(apiKey, q.trim())); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontWeight: 700, fontSize: 22, marginBottom: 4 }}>Medicine Search</h2>
        <p style={{ color: C.muted, fontSize: 14 }}>Search any drug for detailed clinical information powered by Claude</p>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        <input value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === "Enter" && doSearch(query)}
          placeholder="e.g. Montair, Amoxicillin, Paracetamol, Budecort…" />
        <button className="btn btn-primary" disabled={loading || !query.trim()} onClick={() => doSearch(query)}
          style={{ flexShrink: 0 }}>
          {loading ? <Spinner /> : "🔍 Search"}
        </button>
      </div>

      {err && <Err msg={err} />}

      {result && (
        <div className="fade-up">
          {/* Header card */}
          <div className="card" style={{ marginBottom: 14, background: C.navy, borderColor: C.navy }}>
            <div className="card-p" style={{ padding: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                <div>
                  <div style={{ color: "rgba(255,255,255,.4)", fontSize: 11, marginBottom: 4 }}>Medicine</div>
                  <div style={{ color: "#fff", fontWeight: 700, fontSize: 22, marginBottom: 4 }}>
                    {result.generic_name || query}
                  </div>
                  {result.brand_names.length > 0 && (
                    <div style={{ color: "rgba(255,255,255,.5)", fontSize: 13 }}>
                      Also known as: {result.brand_names.join(", ")}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "flex-start" }}>
                  {result.drug_class && <span className="badge badge-teal">{result.drug_class}</span>}
                  {result.otc_or_prescription && (
                    <span className="badge" style={{ background: "rgba(255,255,255,.1)", color: "rgba(255,255,255,.65)" }}>
                      {result.otc_or_prescription}
                    </span>
                  )}
                </div>
              </div>
              {result.interesting_fact && (
                <div style={{ marginTop: 16, padding: "12px 16px", background: "rgba(13,148,136,.15)",
                  borderRadius: 10, fontSize: 13, color: C.tealLight, borderLeft: `3px solid ${C.teal}` }}>
                  ✨ <strong>Did you know?</strong> {result.interesting_fact}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            {result.uses.length > 0 && (
              <div className="card"><div className="card-p">
                <div style={{ fontWeight: 600, marginBottom: 8 }}>✅ Uses</div>
                <ul style={{ paddingLeft: 18, fontSize: 13, color: C.slateLight, lineHeight: 1.9 }}>
                  {result.uses.map((u, i) => <li key={i}>{u}</li>)}
                </ul>
              </div></div>
            )}
            {result.common_dosage && (
              <div className="card"><div className="card-p">
                <div style={{ fontWeight: 600, marginBottom: 8 }}>💊 Typical Dosage</div>
                <div style={{ fontSize: 13, color: C.slateLight, lineHeight: 1.7 }}>{result.common_dosage}</div>
              </div></div>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            {result.side_effects.common.length > 0 && (
              <div className="card"><div className="card-p">
                <div style={{ fontWeight: 600, marginBottom: 8 }}>😐 Common Side Effects</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {result.side_effects.common.map((s, i) => <span key={i} className="badge badge-amber">{s}</span>)}
                </div>
              </div></div>
            )}
            {result.side_effects.serious.length > 0 && (
              <div className="card"><div className="card-p">
                <div style={{ fontWeight: 600, marginBottom: 8 }}>🚨 Serious Side Effects</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {result.side_effects.serious.map((s, i) => <span key={i} className="badge badge-red">{s}</span>)}
                </div>
              </div></div>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            {result.contraindications.length > 0 && (
              <div className="card"><div className="card-p">
                <div style={{ fontWeight: 600, marginBottom: 8 }}>🚫 Contraindications</div>
                <ul style={{ paddingLeft: 18, fontSize: 13, color: C.slateLight, lineHeight: 1.9 }}>
                  {result.contraindications.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </div></div>
            )}
            {result.warnings.length > 0 && (
              <div className="card"><div className="card-p">
                <div style={{ fontWeight: 600, marginBottom: 8 }}>⚠ Warnings</div>
                <ul style={{ paddingLeft: 18, fontSize: 13, color: C.slateLight, lineHeight: 1.9 }}>
                  {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div></div>
            )}
          </div>

          {result.how_it_works && (
            <div className="card" style={{ marginBottom: 12 }}><div className="card-p">
              <div style={{ fontWeight: 600, marginBottom: 8 }}>🔬 How It Works</div>
              <div style={{ fontSize: 14, color: C.slateLight, lineHeight: 1.75 }}>{result.how_it_works}</div>
            </div></div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {result.storage && (
              <div className="card"><div className="card-p">
                <div style={{ fontWeight: 600, marginBottom: 6 }}>📦 Storage</div>
                <div style={{ fontSize: 13, color: C.muted }}>{result.storage}</div>
              </div></div>
            )}
            {result.pregnancy_safety && (
              <div className="card"><div className="card-p">
                <div style={{ fontWeight: 600, marginBottom: 6 }}>🤰 Pregnancy</div>
                <div style={{ fontSize: 13, color: C.muted }}>{result.pregnancy_safety}</div>
              </div></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── HistoryView ────────────────────────────────────────────────────────────────

function HistoryView({ apiKey, history, selectedPatient, onSelectPatient, onDelete, onSearch }) {
  const current = selectedPatient || history[0] || null;

  if (history.length === 0) return (
    <div style={{ textAlign: "center", padding: "80px 20px", color: C.muted }}>
      <div style={{ fontSize: 56, marginBottom: 14 }}>📋</div>
      <div style={{ fontWeight: 600, fontSize: 17, marginBottom: 6 }}>No history yet</div>
      <div style={{ fontSize: 14 }}>Scan a prescription and save it to see it here</div>
    </div>
  );

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontWeight: 700, fontSize: 22, marginBottom: 4 }}>Patient History</h2>
        <p style={{ color: C.muted, fontSize: 14 }}>{history.length} prescription{history.length !== 1 ? "s" : ""} saved</p>
      </div>

      {/* Patient tabs */}
      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 10,
        marginBottom: 22, borderBottom: `1px solid ${C.border}` }}>
        {history.map(rec => {
          const name = rec.data?.patient_name || "Unknown";
          const isActive = current?.id === rec.id;
          return (
            <button key={rec.id} onClick={() => onSelectPatient(rec)} style={{
              padding: "7px 16px", borderRadius: 10, flexShrink: 0,
              border: `1.5px solid ${isActive ? C.teal : C.border}`,
              background: isActive ? C.tealLight : "#fff",
              color: isActive ? C.tealDark : C.slateLight,
              fontFamily: "'Sora', sans-serif", fontSize: 13, fontWeight: isActive ? 600 : 400,
              cursor: "pointer", transition: "all .15s",
            }}>
              {name}
            </button>
          );
        })}
      </div>

      {current && (
        <div className="fade-up">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ color: C.muted, fontSize: 12 }}>Saved {formatDate(current.timestamp)}</div>
            <button className="btn btn-ghost" onClick={() => onDelete(current.id)}
              style={{ color: C.red, fontSize: 13 }}>
              🗑 Delete
            </button>
          </div>
          <PrescriptionResult
            apiKey={apiKey}
            data={current.data}
            imageUrl={current.imageUrl}
            onSearch={onSearch}
            onSave={() => {}}
            saved={true}
          />
        </div>
      )}
    </div>
  );
}

// ── Root App ───────────────────────────────────────────────────────────────────

export default function App() {
  const [apiKey] = useState("server"); // key is on the backend now
  const [active, setActive] = useState("scan");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [scanErr, setScanErr] = useState(null);
  const [saved, setSaved] = useState(false);
  const [history, setHistory] = useState(() => {
    try {
      const h = JSON.parse(localStorage.getItem("rxreader_history") || "[]");
      return Array.isArray(h) ? h : [];
    } catch { return []; }
  });
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");

  const saveHistory = h => {
    setHistory(h);
    try { localStorage.setItem("rxreader_history", JSON.stringify(h)); } catch {}
  };

  const handleFile = async file => {
    setScanErr(null); setResult(null); setSaved(false);
    // Reject non-images immediately
    if (!file || !file.type.startsWith("image/")) {
      setScanErr("Please upload an image file (JPG, PNG, WEBP).");
      return;
    }
    // Warn if file is very large before compression
    const rawMB = (file.size / 1024 / 1024).toFixed(1);
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setScanning(true);
    try {
      // Compress first — handles large phone camera shots (10MB+)
      const { base64, mime, sizeKB } = await compressImage(file);
      console.log(`Image: ${rawMB}MB raw → ${sizeKB}KB compressed`);
      const data = await extractPrescription(apiKey, base64, mime);
      setResult(data);
    } catch (e) {
      const msg = e.message || "";
      if (msg.includes("429")) {
        setScanErr("Rate limit reached (Gemini free tier: 15 requests/min). Wait 60 seconds and try again.");
      } else if (msg.includes("400") || msg.includes("image")) {
        setScanErr("Could not read this image. Try a clearer photo with good lighting.");
      } else {
        setScanErr(msg || "Failed to read prescription. Please try again.");
      }
    } finally {
      setScanning(false);
    }
  };

  const handleSave = () => {
    if (!result) return;
    const rec = { id: Date.now(), timestamp: Date.now(), data: result, imageUrl };
    saveHistory([rec, ...history]);
    setSelectedPatient(rec);
    setSaved(true);
  };

  const handleSearch = name => {
    setSearchQuery(name + "__" + Date.now()); // force re-mount
    setActive("search");
  };

  const handleDelete = id => {
    const updated = history.filter(h => h.id !== id);
    saveHistory(updated);
    setSelectedPatient(updated[0] || null);
  };

  // API key handled server-side — no gate needed

  const searchName = searchQuery.split("__")[0];

  return (
    <>
      <style>{globalCss}</style>
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar
          active={active} setActive={setActive}
          history={history} selectedPatient={selectedPatient}
          onSelectPatient={setSelectedPatient}
          onClearKey={() => { localStorage.removeItem(KEY_STORAGE); setApiKey(""); }}
        />
        <div style={{ flex: 1, overflowY: "auto" }}>
          <div style={{ maxWidth: 820, margin: "0 auto", padding: "36px 32px" }}>

            {active === "scan" && (
              <div>
                <div style={{ marginBottom: 26 }}>
                  <span className="badge badge-teal" style={{ marginBottom: 10, display: "inline-flex" }}>✨ Gemini 2.5 Flash · Free</span>
                  <h1 style={{ fontWeight: 700, fontSize: 28, letterSpacing: "-.02em", marginBottom: 6 }}>
                    Scan Prescription
                  </h1>
                  <p style={{ color: C.muted, fontSize: 15 }}>
                    Upload or photograph any handwritten prescription — Claude decodes it instantly
                  </p>
                </div>
                <DropZone onFile={handleFile} loading={scanning} />
                {scanErr && <Err msg={scanErr} />}
                {result && (
                  <div style={{ marginTop: 28 }}>
                    <PrescriptionResult
                      apiKey={apiKey} data={result} imageUrl={imageUrl}
                      onSearch={handleSearch} onSave={handleSave} saved={saved}
                    />
                  </div>
                )}
              </div>
            )}

            {active === "search" && (
              <MedicineSearch key={searchQuery} apiKey={apiKey} initialQuery={searchName} />
            )}

            {active === "history" && (
              <HistoryView
                apiKey={apiKey} history={history}
                selectedPatient={selectedPatient} onSelectPatient={setSelectedPatient}
                onDelete={handleDelete} onSearch={handleSearch}
              />
            )}

          </div>
        </div>
      </div>
    </>
  );
}
