// Public health check: only yes/no answers, no data or keys.
import { kvGet, kvSet, secrets } from "./_lib.js";
export default async function handler(req, res) {
  const out = { ok: false, db: false, keys: {}, region: process.env.VERCEL_REGION || "", push: !!process.env.VAPID_PUBLIC, passcode: !!process.env.AURUM_PASSCODE };
  try { await kvSet("health/ping", { at: new Date().toISOString() }); const g = await kvGet("health/ping"); out.db = !!g.exists; } catch (e) { out.dbError = String(e.message || e).slice(0, 160); }
  try { const s = await secrets(); out.keys = { claude: !!s.anthropic, gemini: !!s.gemini, fmp: !!s.fmp }; } catch (e) {}
  out.ok = out.db && out.passcode;
  res.setHeader("Cache-Control", "no-store"); res.json(out);
}
