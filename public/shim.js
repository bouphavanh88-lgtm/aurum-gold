/* AURUM standalone runtime: gives the app the same claude.use("sample" | "db" | "mcp") it had inside Claude,
   backed by this app's own server (/api/*). */
(function(){
  const LS = "aurum_pass";
  const pass = () => localStorage.getItem(LS) || "";
  const hdr = (extra) => Object.assign({"x-aurum-pass": pass()}, extra || {});
  function needPass(){ window.dispatchEvent(new CustomEvent("aurum-need-pass")); }
  async function api(url, opts){
    const o = Object.assign({}, opts, {headers: hdr(opts && opts.headers)}); delete o.quiet;
    const r = await fetch(url, o);
    if (r.status === 401){ if (!(opts && opts.quiet)) needPass(); throw {code:"not_granted", message:"passcode"}; }
    return r;
  }
  window.aurumApi = api;

  /* ---- sample: ask the AI brain (Claude, Gemini fallback), streamed ---- */
  const blobB64 = b => new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(",")[1]); fr.onerror = no; fr.readAsDataURL(b); });
  async function sample(input, opts){
    opts = opts || {};
    const turns = typeof input === "string" ? [{role:"user", content:input}] : input;
    const images = [];
    for (const b of (opts.images || [])) images.push({media_type: b.type || "image/png", data: await blobB64(b)});
    let r;
    try{ r = await api("/api/ask", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({turns, tier: opts.modelTier || "default", images, brain: localStorage.getItem("aurum_brain") || "auto"}), signal: opts.signal}); }
    catch(e){ if (e && e.name === "AbortError") throw {code:"cancelled"}; if (e && e.code) throw e; throw {code:"network", message:String(e)}; }
    if (!r.ok){ let j = {}; try{ j = await r.json(); }catch(_){} if (j.code === "no_key") window.dispatchEvent(new CustomEvent("aurum-need-setup")); throw {code: j.code || "brain_error", message: j.message || ("HTTP " + r.status)}; }
    window.aurumBrain = r.headers.get("X-Brain") || "";
    const rd = r.body.getReader(), dec = new TextDecoder(); let text = "";
    try{
      for(;;){ const {value, done} = await rd.read(); if (done) break; const delta = dec.decode(value, {stream:true}); text += delta; if (opts.onText) try{ opts.onText({text, delta}); }catch(_){} }
    }catch(e){ if (e && e.name === "AbortError") throw {code:"cancelled", text}; throw {code:"network", text}; }
    return {text, truncated:false};
  }
  sample.json = async function(input, opts){
    const r = await sample(input, opts);
    let t = r.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b < a) throw {code:"invalid_json", text:r.text};
    try{ return JSON.parse(t.slice(a, b + 1)); }catch(_){ throw {code:"invalid_json", text:r.text}; }
  };
  sample.limits = async () => ({modelTiers:["quick","default","complex"], images:{maxCount:1, mediaTypes:["image/png","image/jpeg","image/webp"]}});

  /* ---- db: documents in Supabase through /api/kv, polled for changes ---- */
  const snap = (exists, data) => ({exists, data: () => data});
  function doc(path){
    if (path === "app/basis") path = "app/basis_spot";   // spot prices need their own (tiny) MT5 offset
    return {
      async get(){ const r = await api("/api/kv?path=" + encodeURIComponent(path)); const j = await r.json(); return snap(!!j.exists, j.data); },
      async set(data){ const r = await api("/api/kv", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({path, data})}); if (!r.ok) throw {code:"db_error"}; },
      async delete(){ await api("/api/kv?path=" + encodeURIComponent(path), {method:"DELETE"}); },
      onSnapshot(cb, err){
        let last = null, stop = false;
        const tick = async () => { if (stop) return; try{ const r = await api("/api/kv?path=" + encodeURIComponent(path)); const j = await r.json(); const k = (j.updatedAt || "") + (j.exists ? "1" : "0"); if (k !== last){ last = k; cb(snap(!!j.exists, j.data)); } }catch(e){ if (err) err(e); } if (!stop) setTimeout(tick, document.hidden ? 120e3 : 25e3); };
        tick(); return () => { stop = true; };
      },
    };
  }
  function collection(name){
    const q = {orderBy(){ return q; }, limit(){ return q; },
      doc: id => doc(name + "/" + id),
      onSnapshot(cb, err){
        let last = null, stop = false;
        const tick = async () => { if (stop) return; try{ const r = await api("/api/kv?prefix=" + encodeURIComponent(name + "/")); const j = await r.json(); const docs = (j.docs || []).map(d => ({id: d.path.slice(name.length + 1), data: () => d.data, _u: d.updated_at})); const k = docs.map(d => d.id + d._u).join("|"); if (k !== last){ last = k; cb({docs, metadata:{fromCache:false}}); } }catch(e){ if (err) err(e); } if (!stop) setTimeout(tick, document.hidden ? 180e3 : 45e3); };
        tick(); return () => { stop = true; };
      }};
    return q;
  }
  const db = {doc, collection};

  /* ---- spot XAUUSD (same market as MT5) from /api/xau ---- */
  const xauCache = {};
  async function xau(tf){
    const h = xauCache[tf]; if (h && Date.now() - h.at < 20e3) return h.d;
    const r = await fetch("/api/xau?tf=" + tf); if (!r.ok) throw {code:"tool_error", message:"spot " + r.status};
    const d = await r.json(); xauCache[tf] = {at: Date.now(), d}; return d;
  }
  window.aurumXau = xau;
  try{ if (!localStorage.getItem("aurum_spot_v1")){ localStorage.removeItem("gd_basis"); localStorage.removeItem("gd_ticks"); localStorage.setItem("aurum_spot_v1", "1"); } }catch(_){}

  /* ---- mcp: the app's gold price calls now use spot XAUUSD (MT5 prices) ---- */
  const KIND = {"commodities-quote":"quote", "commodities-historical-price-eod-full":"eod"};
  async function callTool(server, tool, input){
    if (!/FMP/i.test(server) || tool !== "commodity" || !KIND[input.endpoint]) throw {code:"tool_error", message:"not available in the standalone app"};
    try{
      if (input.endpoint === "commodities-quote"){
        const [h, d] = await Promise.all([xau("1h"), xau("1d")]);
        const c = d.candles, prev = c.length > 1 ? c[c.length - 2][4] : NaN, today = c[c.length - 1] || [], px = h.spot.mid;
        return {payload:[{symbol:"XAUUSD", name:"Gold spot (MT5)", price:+px.toFixed(2), bid:h.spot.bid, ask:h.spot.ask, change:+(px - prev).toFixed(2), changePercentage: isFinite(prev) ? +((px - prev) / prev * 100).toFixed(3) : 0, dayLow: Math.min(today[3] || px, px), dayHigh: Math.max(today[2] || px, px), open: today[1], previousClose: prev, timestamp: Math.floor((h.spot.at || Date.now()) / 1000), source: h.spot.source}], cache:{storedAt: Date.now()}};
      }
      const d = await xau("1d");
      const iso = t => new Date((t + d.serverOffsetH * 3600) * 1000).toISOString().slice(0, 10);
      return {payload: d.candles.map(([t, o, h, l, c]) => ({date: iso(t), open:o, high:h, low:l, close:c})).reverse(), cache:{storedAt: Date.now()}};
    }catch(e){ /* fall back to FMP futures below */ }
    const qs = new URLSearchParams({kind: KIND[input.endpoint], symbol: input.symbol || "GCUSD"});
    if (input.from_date) qs.set("from", input.from_date); if (input.to_date) qs.set("to", input.to_date);
    const r = await api("/api/fmp?" + qs);
    const j = await r.json().catch(() => ({}));
    if (!r.ok){ if (j.code === "no_key") window.dispatchEvent(new CustomEvent("aurum-need-setup")); throw {code: j.code === "no_key" ? "server_not_connected" : (j.code || "tool_error"), message: j.message}; }
    return {payload: j.payload, cache:{storedAt: j.storedAt}};
  }
  function watchTool(server, tool, input, handler, opts){
    let stop = false; const every = (opts && opts.refetchInterval) || 60e3;
    const tick = async () => { if (stop) return; if (!document.hidden){ try{ handler({type:"data", result: await callTool(server, tool, input)}); }catch(e){ handler({type:"error", error:e}); } } if (!stop) setTimeout(tick, every); };
    setTimeout(tick, 50); return () => { stop = true; };
  }
  const mcp = {callTool, watchTool};

  window.claude = {use: async name => name === "sample" ? sample : name === "db" ? db : name === "mcp" ? mcp : null};
  window.AURUM_STANDALONE = true;
})();
