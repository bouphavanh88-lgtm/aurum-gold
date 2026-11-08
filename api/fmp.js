// Gold prices from FMP (futures GCUSD). Small server cache keeps the free plan's daily quota.
import { authed, deny, secrets } from "./_lib.js";
const cache = new Map();
const PATHS = { quote: "quote", eod: "historical-price-eod/full", h1: "historical-chart/1hour", m5: "historical-chart/5min" };
const TTL = { quote: 45e3, eod: 6 * 3600e3, h1: 5 * 60e3, m5: 60e3 };
export default async function handler(req, res) {
  if (!authed(req)) return deny(res);
  const { kind = "quote", symbol = "GCUSD", from, to } = req.query;
  const s = await secrets();
  if (!s.fmp) return res.status(503).json({ code: "no_key", message: "No FMP key yet" });
  const p = PATHS[kind]; if (!p) return res.status(400).json({ code: "bad_kind" });
  const qs = new URLSearchParams({ symbol }); if (from) qs.set("from", from); if (to) qs.set("to", to); qs.set("apikey", s.fmp);
  const key = p + "?" + qs.toString().replace(/apikey=[^&]+/, "");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL[kind]) return res.json({ payload: hit.data, storedAt: hit.at, cached: true });
  const r = await fetch(`https://financialmodelingprep.com/stable/${p}?${qs}`);
  const txt = await r.text();
  if (!r.ok) return res.status(r.status === 402 || r.status === 403 ? 402 : 502).json({ code: r.status === 402 || r.status === 403 ? "plan_required" : "tool_error", message: txt.slice(0, 200) });
  let data; try { data = JSON.parse(txt); } catch { return res.status(502).json({ code: "tool_error" }); }
  cache.set(key, { at: Date.now(), data });
  res.json({ payload: data, storedAt: Date.now() });
}
