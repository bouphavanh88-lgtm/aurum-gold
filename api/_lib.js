// Shared helpers: auth, Supabase key-value store, secrets.
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;          // publishable key; rows are locked by RLS
const DB_TOKEN = process.env.AURUM_DB_TOKEN;      // only the server knows this
const PASS = process.env.AURUM_PASSCODE;          // what ATEE types once on his phone

export function authed(req) {
  const p = req.headers["x-aurum-pass"] || "";
  return !!PASS && p === PASS;
}
export function deny(res) { res.status(401).json({ code: "not_granted", message: "wrong passcode" }); }

function sbHeaders(extra = {}) {
  return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "x-aurum-token": DB_TOKEN, "Content-Type": "application/json", ...extra };
}
export async function kvGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/aurum_kv?path=eq.${encodeURIComponent(path)}&select=data,updated_at`, { headers: sbHeaders() });
  if (!r.ok) throw new Error("kv get " + r.status + " " + (await r.text()));
  const rows = await r.json();
  return rows[0] ? { exists: true, data: rows[0].data, updatedAt: rows[0].updated_at } : { exists: false };
}
export async function kvList(prefix, limit = 300) {
  const r = await fetch(`${SB_URL}/rest/v1/aurum_kv?path=like.${encodeURIComponent(prefix)}*&select=path,data,updated_at&order=updated_at.desc&limit=${limit}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error("kv list " + r.status);
  return r.json();
}
export async function kvSet(path, data) {
  const r = await fetch(`${SB_URL}/rest/v1/aurum_kv`, { method: "POST", headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify({ path, data, updated_at: new Date().toISOString() }) });
  if (!r.ok) throw new Error("kv set " + r.status + " " + (await r.text()));
}
export async function kvDel(path) {
  const r = await fetch(`${SB_URL}/rest/v1/aurum_kv?path=eq.${encodeURIComponent(path)}`, { method: "DELETE", headers: sbHeaders() });
  if (!r.ok) throw new Error("kv del " + r.status);
}
let secretCache = null, secretAt = 0;
export async function secrets() {
  if (secretCache && Date.now() - secretAt < 60000) return secretCache;
  let s = {};
  try { const g = await kvGet("secret/keys"); if (g.exists) s = g.data || {}; } catch (e) {}
  secretCache = {
    anthropic: process.env.ANTHROPIC_API_KEY || s.anthropic || "",
    gemini: process.env.GEMINI_API_KEY || s.gemini || "",
    fmp: process.env.FMP_API_KEY || s.fmp || "",
    geminiModel: process.env.GEMINI_MODEL || s.geminiModel || "gemini-3.6-flash",
  };
  secretAt = Date.now();
  return secretCache;
}
export function clearSecretCache() { secretCache = null; }
export async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}
