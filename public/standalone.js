/* AURUM standalone extras: passcode, AI keys, phone notifications, install. Loaded after the app. */
(function(){
  try{ Object.assign(ERR, {no_key:"ຍັງບໍ່ໄດ້ໃສ່ API key: ໄປ ເພີ່ມເຕີມ → ⚙ ຕັ້ງຄ່າ AI", brain_error:"ສະໝອງ AI ຂັດຂ້ອງຊົ່ວຄາວ. ລອງອີກເທື່ອ.", not_granted:"ລະຫັດເຂົ້າແອັບບໍ່ຖືກ.", network:"ອິນເຕີເນັດຂັດຂ້ອງ. ລອງໃໝ່."}); }catch(_){}
  const $ = id => document.getElementById(id);
  const css = document.createElement("style");
  css.textContent = `#auSetup{position:fixed;inset:0;z-index:9999;background:rgba(3,6,14,.92);backdrop-filter:blur(8px);display:none;overflow:auto;padding:20px 16px}
  #auSetup.open{display:block}#auSetup .box{max-width:520px;margin:0 auto;background:#0b1424;border:1px solid rgba(79,227,255,.3);border-radius:16px;padding:16px}
  #auSetup h3{margin:0 0 4px;font-size:18px;color:#f2cf77}#auSetup label{display:block;margin-top:12px;font-size:13px;opacity:.85}
  #auSetup input,#auSetup select{width:100%;margin-top:4px;padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.35);color:#fff;font-size:15px}
  #auSetup .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}#auSetup .st{font-size:12.5px;margin-top:6px;opacity:.85}
  #auSetup .ok{color:#35e0a1}#auSetup .no{color:#ff8a9e}`;
  document.head.appendChild(css);
  const box = document.createElement("div"); box.id = "auSetup";
  box.innerHTML = `<div class="box">
    <h3>⚙ ຕັ້ງຄ່າ AURUM</h3><div class="st">ແອັບສ່ວນຕົວຂອງ ATEE. API key ເກັບໃນເຊີບເວີ, ບໍ່ສົ່ງກັບມາໂທລະສັບ.</div>
    <label>ລະຫັດເຂົ້າແອັບ<input id="auPass" autocomplete="off" placeholder="AU-XXXXXX"></label>
    <div class="row"><button class="btn pri" id="auPassSave">ບັນທຶກລະຫັດ</button><span class="st" id="auPassSt"></span></div>
    <div id="auKeys">
      <label>Claude API key (platform.claude.com)<input id="auClaude" autocomplete="off" placeholder="sk-ant-..."></label>
      <label>Gemini API key (aistudio.google.com) · ສຳຮອງ<input id="auGemini" autocomplete="off" placeholder="AIza..."></label>
      <label>FMP API key (financialmodelingprep.com) · ລາຄາທອງ<input id="auFmp" autocomplete="off" placeholder="..."></label>
      <label>ສະໝອງຫຼັກ<select id="auBrain"><option value="auto">Claude ກ່ອນ, Gemini ສຳຮອງ</option><option value="gemini">Gemini ກ່ອນ, Claude ສຳຮອງ</option></select></label>
      <div class="row"><button class="btn pri" id="auKeySave">ບັນທຶກ key</button><button class="btn" id="auTest">ທົດສອບ AI</button></div>
      <div class="st" id="auKeySt"></div>
      <label>ແຈ້ງເຕືອນເດັ້ງຂຶ້ນໜ້າຈໍໂທລະສັບ</label>
      <div class="row"><button class="btn pri" id="auPush">ເປີດແຈ້ງເຕືອນ</button><button class="btn" id="auPushTest">ສົ່ງທົດສອບ</button></div>
      <div class="st" id="auPushSt"></div>
      <label>ຕິດຕັ້ງໃສ່ໜ້າຈໍຫຼັກ</label><div class="row"><button class="btn" id="auInstall">ຕິດຕັ້ງແອັບ</button></div><div class="st" id="auInstSt">Chrome: ⋮ → Add to Home screen / Install app</div>
    </div>
    <div class="row"><button class="btn" id="auClose">ປິດ</button></div></div>`;
  document.body.appendChild(box);
  const fab = document.createElement("button"); fab.id = "auFab"; fab.className = "btn pri"; fab.style.cssText = "width:100%;margin:0 0 10px"; fab.textContent = "⚙ ຕັ້ງຄ່າ AI, API key ແລະແຈ້ງເຕືອນໂທລະສັບ";
  const more = document.getElementById("v-more"); if (more) more.insertBefore(fab, more.firstChild);
  const open = () => { box.classList.add("open"); $("auPass").value = localStorage.getItem("aurum_pass") || ""; $("auBrain").value = localStorage.getItem("aurum_brain") || "auto"; refresh(); };
  fab.onclick = open; $("auClose").onclick = () => box.classList.remove("open");
  window.addEventListener("aurum-need-pass", () => { if (!box.classList.contains("open")) open(); $("auPassSt").innerHTML = '<span class="no">ໃສ່ລະຫັດເຂົ້າແອັບກ່ອນ</span>'; });
  window.addEventListener("aurum-need-setup", () => { if (!box.classList.contains("open")) open(); });
  let info = null;
  async function refresh(){
    if (!localStorage.getItem("aurum_pass")){ $("auKeySt").textContent = ""; return; }
    try{ const r = await aurumApi("/api/setup", {quiet:true}); info = await r.json();
      $("auPassSt").innerHTML = '<span class="ok">ລະຫັດຖືກຕ້ອງ ✓</span>';
      $("auKeySt").innerHTML = ["claude","gemini","fmp"].map(k => `${k === "claude" ? "Claude" : k === "gemini" ? "Gemini" : "FMP"}: <span class="${info[k] ? "ok" : "no"}">${info[k] ? "ມີແລ້ວ ✓" : "ຍັງບໍ່ມີ"}</span>`).join(" · ");
      pushState();
    }catch(e){ $("auKeySt").textContent = ""; if (e && e.code === "not_granted") $("auPassSt").innerHTML = '<span class="no">ລະຫັດບໍ່ຖືກ</span>'; }
  }
  $("auPassSave").onclick = () => { localStorage.setItem("aurum_pass", $("auPass").value.trim().toUpperCase()); $("auPassSt").textContent = "ກຳລັງກວດ…"; refresh().then(() => { if (info) setTimeout(() => location.reload(), 600); }); };
  $("auKeySave").onclick = async () => {
    const body = {anthropic: $("auClaude").value, gemini: $("auGemini").value, fmp: $("auFmp").value};
    for (const k in body) if (!body[k].trim()) delete body[k];
    localStorage.setItem("aurum_brain", $("auBrain").value);
    if (!Object.keys(body).length){ $("auKeySt").textContent = "ບັນທຶກສະໝອງຫຼັກແລ້ວ"; return; }
    const r = await aurumApi("/api/setup", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body)});
    if (r.ok){ ["auClaude","auGemini","auFmp"].forEach(i => $(i).value = ""); await refresh(); $("auKeySt").innerHTML += ' · <span class="ok">ບັນທຶກແລ້ວ</span>'; }
  };
  $("auTest").onclick = async () => {
    $("auKeySt").textContent = "ກຳລັງຖາມ AI…";
    try{ const s = await claude.use("sample"); const r = await s("ຕອບສັ້ນໆ 1 ປະໂຫຍກເປັນພາສາລາວ: ສະບາຍດີ ATEE, AURUM ພ້ອມແລ້ວ", {modelTier:"quick"}); $("auKeySt").innerHTML = `<span class="ok">${(window.aurumBrain || "AI")}: ${r.text.slice(0,120).replace(/</g,"&lt;")}</span>`; }
    catch(e){ $("auKeySt").innerHTML = `<span class="no">ບໍ່ສຳເລັດ: ${(e && (e.message || e.code)) || e}</span>`.slice(0, 400); }
  };
  /* service worker + push */
  let reg = null;
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").then(r => { reg = r; pushState(); }).catch(() => {});
  const b64u = s => { const p = "=".repeat((4 - s.length % 4) % 4), b = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...b].map(c => c.charCodeAt(0))); };
  async function pushState(){
    if (!("Notification" in window) || !reg){ $("auPushSt").textContent = "ໂທລະສັບນີ້ບໍ່ຮອງຮັບແຈ້ງເຕືອນ (ໃຊ້ Chrome)"; return; }
    const sub = await reg.pushManager.getSubscription();
    $("auPushSt").innerHTML = sub ? '<span class="ok">ເປີດແລ້ວ ✓ AURUM ຈະແຈ້ງເຕືອນເຂົ້າໂທລະສັບ</span>' : Notification.permission === "denied" ? '<span class="no">ຖືກປິດໄວ້: ເປີດໃນ Settings → Apps → Chrome → Notifications</span>' : "ຍັງບໍ່ເປີດ";
  }
  $("auPush").onclick = async () => {
    try{
      if (!info || !info.vapid){ $("auPushSt").textContent = "ເຊີບເວີຍັງບໍ່ພ້ອມສຳລັບແຈ້ງເຕືອນ"; return; }
      const p = await Notification.requestPermission(); if (p !== "granted"){ pushState(); return; }
      const sub = await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey: b64u(info.vapid)});
      await aurumApi("/api/push?action=subscribe", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({sub})});
      pushState();
    }catch(e){ $("auPushSt").textContent = "ເປີດບໍ່ສຳເລັດ: " + (e.message || e); }
  };
  $("auPushTest").onclick = async () => { const r = await aurumApi("/api/push?action=notify", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({title:"AURUM", body:"ທົດສອບແຈ້ງເຕືອນ: ລະບົບພ້ອມແລ້ວ ATEE"})}); const j = await r.json().catch(() => ({})); $("auPushSt").textContent = r.ok ? `ສົ່ງແລ້ວ (${j.sent || 0} ເຄື່ອງ)` : "ສົ່ງບໍ່ໄດ້"; };
  window.aurumNotify = (title, body) => aurumApi("/api/push?action=notify", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({title, body})}).catch(() => {});
  /* install prompt */
  let deferred = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; $("auInstSt").textContent = "ພ້ອມຕິດຕັ້ງ: ກົດປຸ່ມ"; });
  $("auInstall").onclick = async () => { if (deferred){ deferred.prompt(); await deferred.userChoice; deferred = null; } else $("auInstSt").textContent = "Chrome: ⋮ → Add to Home screen (ຫຼື ຕິດຕັ້ງແລ້ວ)"; };
  /* phone push when the desk turns GO while the app runs in the background */
  try{
    const _ra = renderAlerts;
    let lastN = (st.alerts || []).length;
    renderAlerts = function(){ _ra.apply(this, arguments); const n = (st.alerts || []).length; if (n > lastN && document.hidden){ const a = st.alerts[n-1]; if (a && (a.level === "opportunity" || a.level === "warning")) window.aurumNotify("AURUM", a.titleLao || ""); } lastN = n; };
  }catch(_){}
  if (!localStorage.getItem("aurum_pass")) setTimeout(open, 400);
})();
/* ---- spot XAUUSD timeframes like MT5: M15 / H1 / H4 (plus D1, W1, live line) ---- */
(function(){
  try{
    st.live.intra = st.live.intra || {};
    const seg = document.getElementById("chTF");
    if (seg){
      [["15m","M15"],["1h","H1"],["4h","H4"]].reverse().forEach(([tf, lbl]) => { const b = document.createElement("button"); b.dataset.tf = tf; b.textContent = lbl; b.setAttribute("aria-pressed", "false"); seg.insertBefore(b, seg.firstChild); });
    }
    async function loadIntra(tf){
      try{
        const d = await aurumXau(tf);
        st.live.intra[tf] = d.candles; st.live.intra.spot = d.spot; st.live.intra.source = d.source;
        if (chTF === tf) renderChart();
        if (tf === "15m") safe(renderDesk, "desk");
      }catch(_){}
    }
    const every = {"15m": 60e3, "1h": 120e3, "4h": 300e3};
    Object.keys(every).forEach(tf => { loadIntra(tf); setInterval(() => { if (!document.hidden) loadIntra(tf); }, every[tf]); });
    setTimeout(() => { const b = seg && seg.querySelector('[data-tf="1h"]'); if (b) b.click(); }, 400);
    const src = document.getElementById("chSrc"); if (src) setInterval(() => { if (st.live.intra.source) src.textContent = "XAUUSD spot (ລາຄາແບບ MT5) · ເວລາລາວ"; }, 5000);
  }catch(e){ console.error("intra", e); }
})();
