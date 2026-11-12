// Spot XAUUSD (the same market as MT5), from free public feeds. No keys, read-only, cached.
//   GET /api/xau?tf=15m|1h|4h|1d  -> { source, tf, candles: [[unixSec, o, h, l, c], ...], spot: {bid, ask, mid, at, source} }
const cache = new Map();
const HDR = { "User-Agent": "Mozilla/5.0 (AURUM app)", Accept: "application/json" };
const TTL = { "15m": 30e3, "1h": 60e3, "4h": 120e3, "1d": 300e3 };

async function j(url, ms = 6000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { headers: HDR, signal: c.signal }); if (!r.ok) throw new Error(url.split("/")[2] + " " + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
function agg(c1h, hours) {   // build H4 from H1, aligned to UTC 00/04/08...
  const out = []; let cur = null;
  for (const [t, o, h, l, c] of c1h) { const k = Math.floor(t / (hours * 3600)) * hours * 3600; if (!cur || cur[0] !== k) { if (cur) out.push(cur); cur = [k, o, h, l, c]; } else { cur[2] = Math.max(cur[2], h); cur[3] = Math.min(cur[3], l); cur[4] = c; } }
  if (cur) out.push(cur); return out;
}
async function yahoo(tf) {
  const p = { "15m": ["15m", "5d"], "1h": ["60m", "1mo"], "4h": ["60m", "3mo"], "1d": ["1d", "2y"] }[tf];
  const d = await j(`https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=${p[0]}&range=${p[1]}`);
  const r = d.chart?.result?.[0]; if (!r) throw new Error("yahoo empty");
  const q = r.indicators.quote[0], out = [];
  r.timestamp.forEach((t, i) => { const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i]; if ([o, h, l, c].every(Number.isFinite)) out.push([t, o, h, l, c]); });
  if (out.length < 30) throw new Error("yahoo short");
  return tf === "4h" ? agg(out, 4) : out;
}
async function binance(tf) {   // PAXG (1 token = 1 oz of gold) as a backup; shifted to spot later
  const iv = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" }[tf];
  const d = await j(`https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${iv}&limit=500`);
  return d.map(k => [Math.floor(k[0] / 1000), +k[1], +k[2], +k[3], +k[4]]);
}
async function spotSwissquote() {
  const d = await j("https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD");
  const best = []; for (const pf of d || []) for (const sp of pf.spreadProfilePrices || []) if (sp.bid && sp.ask) best.push({ bid: sp.bid, ask: sp.ask, at: pf.ts });
  if (!best.length) throw new Error("swissquote empty");
  best.sort((a, b) => (a.ask - a.bid) - (b.ask - b.bid));
  const b = best[0]; return { bid: b.bid, ask: b.ask, mid: (b.bid + b.ask) / 2, at: b.at || Date.now(), source: "Swissquote spot" };
}
export default async function handler(req, res) {
  const tf = ["15m", "1h", "4h", "1d"].includes(req.query.tf) ? req.query.tf : "1h";
  const hit = cache.get(tf);
  res.setHeader("Cache-Control", "no-store");
  if (hit && Date.now() - hit.at < TTL[tf]) return res.json(hit.data);
  const errors = [];
  let spot = null; try { spot = await spotSwissquote(); } catch (e) { errors.push(String(e.message)); }
  let candles = null, source = "";
  try { candles = await yahoo(tf); source = "Yahoo XAUUSD spot"; } catch (e) { errors.push(String(e.message)); }
  if (!candles) { try { candles = await binance(tf); source = "PAXG (Binance) shifted to spot"; } catch (e) { errors.push(String(e.message)); } }
  if (candles && spot && source.startsWith("PAXG")) { const off = spot.mid - candles[candles.length - 1][4]; candles = candles.map(([t, o, h, l, c]) => [t, o + off, h + off, l + off, c + off]); }
  if (!spot && candles) { const c = candles[candles.length - 1]; spot = { bid: c[4], ask: c[4], mid: c[4], at: c[0] * 1000, source }; }
  if (!candles && !spot) return res.status(502).json({ code: "no_data", errors });
  const data = { source, tf, candles: candles || [], spot, errors };
  cache.set(tf, { at: Date.now(), data });
  res.json(data);
}
