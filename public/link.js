/* AURUM LINK: phone <-> computer. Each device runs the same page and both
   (1) obeys commands sent to it (camera photo/video, screen shot/record, shared folder, open link, text),
   (2) sends commands to the other device and keeps what comes back in an inbox (saved on this device).
   Relay = the app's own database (/api/kv). Files travel in chunks and are deleted from the relay once received. */
(function(){
  "use strict";
  const $ = id => document.getElementById(id);
  const E = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const IS_MOBILE = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const me = () => localStorage.getItem("aurum_dev") || (IS_MOBILE ? "phone" : "pc");
  const other = () => me() === "pc" ? "phone" : "pc";
  const NAME = {pc:"ຄອມພິວເຕີ", phone:"ໂທລະສັບ"};
  const CHUNK = 1400 * 1024, MAX_FILE = 60 * 1024 * 1024;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const api = (u, o) => window.aurumApi(u, Object.assign({quiet:true}, o || {}));
  const kvGet = async p => { const r = await api("/api/kv?path=" + encodeURIComponent(p)); if (!r.ok) return null; const j = await r.json(); return j && j.exists ? j.data : null; };
  const kvList = async p => { const r = await api("/api/kv?prefix=" + encodeURIComponent(p)); if (!r.ok) return []; const j = await r.json(); return j.docs || []; };
  const kvSet = (p, d) => api("/api/kv", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({path:p, data:d})}).then(r => { if (!r.ok) throw new Error("db " + r.status); });
  const kvDel = p => api("/api/kv?path=" + encodeURIComponent(p), {method:"DELETE"}).catch(() => {});
  const b64 = buf => { let s = "", u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  const size = n => n > 1048576 ? (n/1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n/1024)) + " KB";
  const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------- blobs over the relay ---------- */
  async function putBlob(blob, onp){
    if (blob.size > MAX_FILE) throw new Error("ໄຟລ໌ໃຫຍ່ເກີນ 60 MB");
    const id = uid(), n = Math.max(1, Math.ceil(blob.size / CHUNK));
    await kvSet("lout/" + id, {at: Date.now(), n});
    for (let i = 0; i < n; i++){
      const part = await blob.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer();
      await kvSet(`lblob/${id}/${i}`, {d: b64(part)});
      if (onp) onp((i + 1) / n);
    }
    return {blob: id, n, size: blob.size, mime: blob.type || "application/octet-stream"};
  }
  async function getBlob(ref, onp){
    const parts = [];
    for (let i = 0; i < ref.n; i++){
      let doc = null;
      for (let t = 0; t < 3 && !doc; t++){ doc = await kvGet(`lblob/${ref.blob}/${i}`); if (!doc || !doc.d){ doc = null; await sleep(800); } }
      if (!doc) throw new Error("ໄຟລ໌ມາບໍ່ຄົບ");
      parts.push(unb64(doc.d)); if (onp) onp((i + 1) / ref.n);
    }
    for (let i = 0; i < ref.n; i++) kvDel(`lblob/${ref.blob}/${i}`);
    kvDel("lout/" + ref.blob);
    return new Blob(parts, {type: ref.mime});
  }
  async function sweep(){ // drop relay files nobody picked up within 24 h
    try{ for (const d of await kvList("lout/")){ const v = d.data || {}; if (Date.now() - (v.at || 0) > 864e5){ for (let i = 0; i < (v.n || 0); i++) kvDel(`lblob/${d.path.slice(5)}/${i}`); kvDel(d.path); } } }catch(_){}
  }

  /* ---------- inbox kept on this device (IndexedDB) ---------- */
  let dbp = null;
  const idb = () => dbp || (dbp = new Promise((ok, no) => { const r = indexedDB.open("aurum_link", 1); r.onupgradeneeded = () => { r.result.createObjectStore("inbox", {keyPath:"id"}); r.result.createObjectStore("kv"); }; r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }));
  const tx = async (store, mode, fn) => { const db = await idb(); return new Promise((ok, no) => { const t = db.transaction(store, mode), s = t.objectStore(store); const r = fn(s); t.oncomplete = () => ok(r && r.result); t.onerror = () => no(t.error); }); };
  const inbox = [];
  async function loadInbox(){ try{ const all = await tx("inbox", "readonly", s => s.getAll()); inbox.splice(0, inbox.length, ...(all || []).sort((a, b) => b.at - a.at)); }catch(_){} }
  async function addInbox(item){
    item.id = item.id || uid(); item.at = item.at || Date.now();
    inbox.unshift(item);
    while (inbox.length > 40){ const old = inbox.pop(); tx("inbox", "readwrite", s => s.delete(old.id)).catch(() => {}); }
    try{ await tx("inbox", "readwrite", s => s.put(item)); }catch(_){}
    renderInbox(); return item;
  }

  /* ---------- what this device can do ---------- */
  let screenStream = null, dirHandle = null, busyMsg = "";
  const cap = {cam: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia), screen: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !IS_MOBILE, folder: "showDirectoryPicker" in window};
  function flash(text){ busyMsg = text; renderStatus(); const f = $("lkFlash"); if (f){ f.textContent = text; f.classList.add("on"); clearTimeout(flash.t); flash.t = setTimeout(() => { f.classList.remove("on"); busyMsg = ""; renderStatus(); }, 4000); } }
  function frameOf(stream, vEl){
    return new Promise(async (ok, no) => {
      try{
        const v = vEl || document.createElement("video"); v.muted = true; v.playsInline = true; v.srcObject = stream; await v.play();
        await sleep(vEl ? 120 : 900); // let the camera settle exposure
        const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext("2d").drawImage(v, 0, 0); c.toBlob(b => b ? ok(b) : no(new Error("ຖ່າຍບໍ່ໄດ້")), "image/jpeg", 0.9);
        if (!vEl){ v.pause(); v.srcObject = null; }
      }catch(e){ no(e); }
    });
  }
  async function grab(stream){
    try{ if (window.ImageCapture){ const bm = await new ImageCapture(stream.getVideoTracks()[0]).grabFrame(); const c = document.createElement("canvas"); c.width = bm.width; c.height = bm.height; c.getContext("2d").drawImage(bm, 0, 0); return await new Promise((ok, no) => c.toBlob(b => b ? ok(b) : no(new Error("ຖ່າຍບໍ່ໄດ້")), "image/jpeg", 0.9)); } }catch(_){}
    return frameOf(stream, $("lkScrV"));
  }
  function record(stream, sec){
    return new Promise((ok, no) => {
      const types = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
      const type = types.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
      let rec; try{ rec = new MediaRecorder(stream, type ? {mimeType:type, videoBitsPerSecond: 2.5e6} : {}); }catch(e){ return no(e); }
      const parts = []; rec.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
      rec.onstop = () => ok(new Blob(parts, {type: (type || "video/webm").split(";")[0]}));
      rec.start(1000); setTimeout(() => { try{ rec.stop(); }catch(_){} }, sec * 1000);
    });
  }
  const camConstraints = a => ({video: {facingMode: a.front ? "user" : "environment", width:{ideal:1920}, height:{ideal:1080}}, audio: !!a.audio});
  async function withCam(a, fn){
    const s = await navigator.mediaDevices.getUserMedia(camConstraints(a));
    try{ return await fn(s); } finally { s.getTracks().forEach(t => t.stop()); }
  }
  const ext = m => m.includes("mp4") ? "mp4" : m.includes("webm") ? "webm" : m.includes("png") ? "png" : "jpg";
  async function startScreen(){
    if (!cap.screen) throw new Error("ເຄື່ອງນີ້ບໍ່ຮອງຮັບການແບ່ງປັນໜ້າຈໍ");
    screenStream = await navigator.mediaDevices.getDisplayMedia({video:{frameRate: 15}, audio:false});
    const v = $("lkScrV"); if (v){ v.srcObject = screenStream; v.play().catch(() => {}); }
    screenStream.getVideoTracks()[0].addEventListener("ended", () => { screenStream = null; renderStatus(); beat(); });
    renderStatus(); beat();
  }
  async function pickFolder(){
    dirHandle = await window.showDirectoryPicker({mode:"readwrite", id:"aurum"});
    try{ await tx("kv", "readwrite", s => s.put(dirHandle, "dir")); }catch(_){}
    renderStatus(); beat();
  }
  async function restoreFolder(ask){
    if (!cap.folder) return;
    try{
      const h = await tx("kv", "readonly", s => s.get("dir")); if (!h) return;
      let p = await h.queryPermission({mode:"readwrite"});
      if (p !== "granted" && ask) p = await h.requestPermission({mode:"readwrite"});
      if (p === "granted") dirHandle = h; else window.__lkDirPending = h;
    }catch(_){}
    renderStatus();
  }
  async function walk(path){
    if (!dirHandle) throw new Error("ຍັງບໍ່ໄດ້ເລືອກໂຟນເດີແບ່ງປັນຢູ່ເຄື່ອງນີ້");
    let h = dirHandle; for (const part of String(path || "").split("/").filter(Boolean)){ if (part === "..") throw new Error("path"); h = await h.getDirectoryHandle(part); }
    return h;
  }
  async function listDir(path){
    const h = await walk(path), out = [];
    for await (const [name, e] of h.entries()){
      if (out.length >= 300) break;
      if (e.kind === "file"){ try{ const f = await e.getFile(); out.push({name, kind:"file", size:f.size, mt:f.lastModified}); }catch(_){ out.push({name, kind:"file"}); } }
      else out.push({name, kind:"dir"});
    }
    out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1) || (b.mt || 0) - (a.mt || 0) || a.name.localeCompare(b.name));
    return {path: path || "", root: dirHandle.name, items: out};
  }
  async function readFile(path){
    const parts = String(path).split("/").filter(Boolean), name = parts.pop();
    const d = await walk(parts.join("/")); return (await d.getFileHandle(name)).getFile();
  }
  async function saveHere(blob, name){
    if (dirHandle){
      const d = await dirHandle.getDirectoryHandle("AURUM-ຮັບ", {create:true});
      const fh = await d.getFileHandle(name, {create:true}); const w = await fh.createWritable(); await w.write(blob); await w.close();
      return "ບັນທຶກໃສ່ " + dirHandle.name + "/AURUM-ຮັບ/" + name;
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    return "ດາວໂຫຼດແລ້ວ (Downloads)";
  }

  /* Run one command on THIS device. Returns {items:[{name, blob}]} or {list} or {text}. */
  async function runLocal(type, a){
    a = a || {};
    if (type === "ping") return {text: "ອອນລາຍ"};
    if (type === "photo"){ flash("📷 ກຳລັງຖ່າຍຮູບ…"); const b = await withCam(a, s => frameOf(s)); return {items:[{name:`photo-${stamp()}.jpg`, blob:b}]}; }
    if (type === "video"){ const sec = Math.min(60, Math.max(3, +a.sec || 10)); flash(`🎥 ກຳລັງອັດວິດີໂອ ${sec} ວິ…`); const b = await withCam(a, s => record(s, sec)); return {items:[{name:`video-${stamp()}.${ext(b.type)}`, blob:b}]}; }
    if (type === "screen"){ if (!screenStream) throw new Error("ໜ້າຈໍຍັງບໍ່ໄດ້ເປີດແບ່ງປັນ: ກົດ 'ເປີດແບ່ງປັນໜ້າຈໍ' ຢູ່" + NAME[me()] + "ກ່ອນ 1 ເທື່ອ"); flash("🖥 ກຳລັງຖ່າຍໜ້າຈໍ…"); const b = await grab(screenStream); return {items:[{name:`screen-${stamp()}.jpg`, blob:b}]}; }
    if (type === "screenrec"){ if (!screenStream) throw new Error("ໜ້າຈໍຍັງບໍ່ໄດ້ເປີດແບ່ງປັນ"); const sec = Math.min(60, Math.max(3, +a.sec || 15)); flash(`⏺ ກຳລັງອັດໜ້າຈໍ ${sec} ວິ…`); const b = await record(screenStream, sec); return {items:[{name:`screen-${stamp()}.${ext(b.type)}`, blob:b}]}; }
    if (type === "ls") return {list: await listDir(a.path)};
    if (type === "get"){ const f = await readFile(a.path); flash("📁 ສົ່ງໄຟລ໌ " + f.name); return {items:[{name:f.name, blob:f}]}; }
    if (type === "url"){
      const u = String(a.url || ""); if (!/^https?:\/\//i.test(u)) throw new Error("ລິ້ງບໍ່ຖືກ");
      const w = window.open(u, "_blank", "noopener");
      if (!w){ addInbox({kind:"text", from:other(), text:u, note:"ລິ້ງທີ່ສັ່ງເປີດ (browser ບລັອກ popup, ກົດເປີດເອງ)"}); try{ if (Notification.permission === "granted") new Notification("AURUM: ເປີດລິ້ງ", {body:u}); }catch(_){} return {text:"ສົ່ງລິ້ງໄປແລ້ວ ແຕ່ browser ບລັອກການເປີດເອງ: ລິ້ງຢູ່ໃນກ່ອງຮັບຂອງ" + NAME[me()]}; }
      return {text:"ເປີດລິ້ງແລ້ວ"};
    }
    if (type === "text"){ await addInbox({kind:"text", from:other(), text:String(a.text || "")}); try{ await navigator.clipboard.writeText(String(a.text || "")); }catch(_){} flash("💬 ໄດ້ຮັບຂໍ້ຄວາມ"); return {text:"ຮັບແລ້ວ"}; }
    if (type === "clip"){ try{ return {text: await navigator.clipboard.readText()}; }catch(_){ throw new Error("ອ່ານ clipboard ບໍ່ໄດ້ (ຕ້ອງເປີດໜ້າແອັບຢູ່ໜ້າສຸດ)"); } }
    if (type === "put"){ flash("⬇ ກຳລັງຮັບໄຟລ໌…"); const b = await getBlob(a.ref); const where = await saveHere(b, a.name || ("file-" + stamp())); await addInbox({kind:"file", from:other(), name:a.name, mime:b.type, size:b.size, blob:b}); return {text: where}; }
    throw new Error("ບໍ່ຮູ້ຈັກຄຳສັ່ງ " + type);
  }

  /* ---------- station: obey commands addressed to this device ---------- */
  const doing = new Set();
  async function handle(doc){
    const c = doc.data || {}; if (doing.has(c.id)) return; doing.add(c.id);
    await kvDel(doc.path);
    if (Date.now() - (c.at || 0) > 5 * 60e3) return; // stale
    const res = {id:c.id, to:c.from, from:me(), type:c.type, at:Date.now(), ok:true};
    try{
      const out = await runLocal(c.type, c.args);
      if (out.items){ res.items = []; for (const it of out.items){ const ref = await putBlob(it.blob); res.items.push(Object.assign({name:it.name}, ref)); } }
      if (out.list) res.list = out.list; if (out.text != null) res.text = out.text;
    }catch(e){ res.ok = false; res.err = (e && (e.message || e.name)) || String(e); if (/NotAllowed|Permission/i.test(res.err)) res.err = "ເຄື່ອງ" + NAME[me()] + "ບໍ່ອະນຸຍາດກ້ອງ/ໄມ: ກົດອະນຸຍາດຢູ່ໜ້າ 📡 ຂອງເຄື່ອງນັ້ນກ່ອນ"; }
    await kvSet("lres/" + c.id, res).catch(() => {});
  }

  /* ---------- remote: send commands to the other device ---------- */
  const pending = new Map(); // id -> {type, args, at, resolve}
  function cmd(type, args, opts){
    const id = uid(), c = {id, to:other(), from:me(), type, args: args || {}, at: Date.now()};
    return new Promise(async (resolve) => {
      pending.set(id, Object.assign({type, args: c.args, at: c.at, resolve}, opts || {}));
      renderPending();
      try{ await kvSet("lcmd/" + id, c); }catch(e){ pending.delete(id); renderPending(); resolve({ok:false, err:"ສົ່ງຄຳສັ່ງບໍ່ໄດ້: " + e.message}); }
      fast = 20; // poll quickly for a while
    });
  }
  async function gotResult(doc){
    const r = doc.data || {}; await kvDel(doc.path);
    const p = pending.get(r.id); pending.delete(r.id); renderPending();
    const files = [];
    if (r.ok && r.items) for (const it of r.items){
      try{ setProg("⬇ ຮັບ " + it.name, 0); const b = await getBlob(it, f => setProg("⬇ ຮັບ " + it.name, f)); const item = await addInbox({kind:"file", from:r.from, name:it.name, mime:b.type, size:b.size, blob:b}); files.push(item); }
      catch(e){ r.ok = false; r.err = e.message; }
      setProg("");
    }
    if (r.ok && r.list) showBrowser(r.list);
    if (r.ok && r.text != null && r.type !== "ping" && r.type !== "put" && r.type !== "url" && r.type !== "text") await addInbox({kind:"text", from:r.from, text:r.text, note: r.type === "clip" ? "clipboard" : ""});
    const msg = r.ok ? ((files.length ? "ໄດ້ຮັບ " + files.map(f => f.name).join(", ") : (r.text || "ສຳເລັດ"))) : ("❌ " + (r.err || "ບໍ່ສຳເລັດ"));
    toast((r.ok ? "✅ " : "") + msg);
    if (p && p.resolve) p.resolve(Object.assign({}, r, {files}));
    if (p && p.analyze && files[0] && /^image\//.test(files[0].mime)) useImage(files[0], true);
  }

  /* ---------- loop (worker clock, so a background computer tab keeps answering) ---------- */
  let fast = 0, tick = 0, last = 0, peer = null, polling = false;
  async function beat(){
    if (!localStorage.getItem("aurum_pass")) return;
    const s = {at: Date.now(), cam: cap.cam, screen: !!screenStream, folder: dirHandle ? dirHandle.name : "", canScreen: cap.screen, canFolder: cap.folder, ua: IS_MOBILE ? "mobile" : "desktop", visible: !document.hidden};
    kvSet("lstat/" + me(), s).catch(() => {});
  }
  async function poll(){
    if (polling || !localStorage.getItem("aurum_pass")) return; polling = true;
    try{
      const [cmds, ress] = await Promise.all([kvList("lcmd/"), kvList("lres/")]);
      for (const d of cmds) if (d.data && d.data.to === me()) handle(d);
      for (const d of ress) if (d.data && d.data.to === me()) await gotResult(d);
      for (const [id, p] of pending) if (Date.now() - p.at > 3 * 60e3){ pending.delete(id); p.resolve({ok:false, err:"ໝົດເວລາ: " + NAME[other()] + "ບໍ່ຕອບ (ເປີດແອັບຢູ່ເຄື່ອງນັ້ນບໍ?)"}); toast("❌ " + NAME[other()] + "ບໍ່ຕອບ"); renderPending(); }
    }catch(_){}
    polling = false;
  }
  async function peerStatus(){ try{ peer = await kvGet("lstat/" + other()); }catch(_){ peer = null; } renderStatus(); }
  function onTick(){
    tick++;
    const open = $("auLink") && $("auLink").classList.contains("open");
    // phone: only while the app is on screen. computer: keeps watching in the background.
    if (document.hidden && me() === "phone" && !pending.size) return;
    const every = (fast > 0 || pending.size) ? 2 : open ? 3 : me() === "pc" ? 4 : 8;
    if (fast > 0) fast--;
    if (tick - last >= every){ last = tick; poll(); }
    if (tick % 15 === 1) beat();
    if (tick % (open ? 5 : 30) === 2) peerStatus();
    if (tick % 600 === 5) sweep();
  }
  try{ const w = new Worker(URL.createObjectURL(new Blob(["setInterval(()=>postMessage(0),1000)"], {type:"text/javascript"}))); w.onmessage = onTick; }
  catch(_){ setInterval(onTick, 1000); }
  document.addEventListener("visibilitychange", () => { if (!document.hidden){ beat(); poll(); peerStatus(); } });

  /* ---------- use a received picture in the analysis ---------- */
  function useImage(item, ask){
    const f = new File([item.blob], item.name || "image.jpg", {type: item.mime || "image/jpeg"});
    try{
      st.img = f;
      const url = URL.createObjectURL(f);
      $("attachPrev").hidden = false;
      $("attachPrev").innerHTML = `<img src="${url}" alt="ຮູບທີ່ຮັບມາ"><span>${E(f.name)}</span><button class="btn" id="rmImg" style="padding:2px 8px">ເອົາອອກ</button>`;
      $("rmImg").onclick = clearImg;
      closeLink(); showTab("chat");
      if (ask){ if (!$("q").value.trim()) $("q").value = "ວິເຄາະຮູບໜ້າຈໍ MT5 ນີ້ຕາມແຜນເທຣດສັ້ນ: ຄວນ BUY, SELL ຫຼືລໍ? ບອກ Entry, SL, TP ເປັນລາຄາ MT5 ແລະເຫດຜົນ."; setTimeout(() => window.send(), 200); }
    }catch(e){ toast("ໃຊ້ຮູບບໍ່ໄດ້: " + e.message); }
  }

  /* ---------- UI ---------- */
  const css = document.createElement("style");
  css.textContent = `#auLink{position:fixed;inset:0;z-index:9998;background:rgba(3,6,14,.94);backdrop-filter:blur(8px);display:none;overflow:auto;padding:16px 12px 40px}
  #auLink.open{display:block}#auLink .box{max-width:560px;margin:0 auto}
  #auLink .card{background:#0b1424;border:1px solid rgba(79,227,255,.28);border-radius:16px;padding:14px;margin-bottom:12px}
  #auLink h3{margin:0;font-size:18px;color:#f2cf77}#auLink h4{margin:0 0 8px;font-size:14.5px;color:#4fe3ff}
  #auLink .st{font-size:12.5px;opacity:.85;margin-top:4px}#auLink .ok{color:#35e0a1}#auLink .no{color:#ff8a9e}
  #auLink .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}#auLink .grid .btn{padding:12px 6px;font-size:14px;width:100%}
  #auLink .seg{display:flex;gap:6px;margin-top:8px}#auLink .seg button{flex:1}#auLink .seg button[aria-pressed=true]{border-color:#f2cf77;color:#f2cf77}
  #auLink input{width:100%;padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.35);color:#fff;font-size:15px;margin-top:6px}
  #auLink .it{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid rgba(255,255,255,.08)}
  #auLink .it .th{width:84px;height:62px;border-radius:8px;object-fit:cover;background:#000;flex:none}
  #auLink .it .nm{font-size:13px;word-break:break-all}#auLink .it .acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}#auLink .it .acts .btn{padding:4px 9px;font-size:12.5px}
  #auLink .fl{display:flex;justify-content:space-between;gap:8px;padding:9px 4px;border-top:1px solid rgba(255,255,255,.07);font-size:13.5px;cursor:pointer}
  #auLink .prog{height:4px;border-radius:3px;background:rgba(255,255,255,.1);margin-top:8px;overflow:hidden}#auLink .prog i{display:block;height:100%;background:#4fe3ff;width:0}
  #lkFlash{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:10000;background:#f2cf77;color:#111;font-weight:700;padding:8px 14px;border-radius:999px;display:none;box-shadow:0 6px 24px rgba(0,0,0,.4)}#lkFlash.on{display:block}
  #lkToast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:10001;background:#0b1424;border:1px solid #4fe3ff;color:#fff;padding:9px 14px;border-radius:12px;max-width:90vw;font-size:13.5px;display:none}#lkToast.on{display:block}
  #lkScrV{width:100%;max-height:150px;border-radius:10px;background:#000;margin-top:8px;display:none}`;
  document.head.appendChild(css);
  const box = document.createElement("div"); box.id = "auLink";
  box.innerHTML = `<div class="box">
    <div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h3>📡 ເຊື່ອມ ໂທລະສັບ ↔ ຄອມພິວເຕີ</h3><button class="btn" id="lkClose">ປິດ</button></div>
      <div class="st">ເປີດແອັບນີ້ (ລິ້ງດຽວກັນ, ລະຫັດດຽວກັນ) ທັງໃນໂທລະສັບ ແລະ ໃນ Chrome ຂອງຄອມ. ເຄື່ອງນີ້ແມ່ນ:</div>
      <div class="seg"><button class="btn" data-dev="phone">📱 ໂທລະສັບ</button><button class="btn" data-dev="pc">💻 ຄອມພິວເຕີ</button></div>
      <div class="st" id="lkPeer"></div></div>
    <div class="card"><h4 id="lkRemoteT">ສັ່ງເຄື່ອງອື່ນ</h4>
      <div class="grid">
        <button class="btn pri" data-c="screen" data-an="1">🖥🤖 ຖ່າຍໜ້າຈໍ MT5 ແລ້ວວິເຄາະ</button>
        <button class="btn" data-c="screen">🖥 ຖ່າຍໜ້າຈໍ</button>
        <button class="btn" data-c="screenrec">⏺ ອັດໜ້າຈໍ 15 ວິ</button>
        <button class="btn" data-c="photo">📷 ຖ່າຍຮູບ (ກ້ອງ)</button>
        <button class="btn" data-c="video">🎥 ອັດວິດີໂອ 10 ວິ</button>
        <button class="btn" data-c="ls">📁 ເບິ່ງໄຟລ໌</button>
        <button class="btn" id="lkPut">⬆ ສົ່ງໄຟລ໌ໄປ</button>
        <button class="btn" data-c="clip">📋 ດຶງຂໍ້ຄວາມ clipboard</button>
      </div>
      <input id="lkUrl" placeholder="ລິ້ງ ຫຼື ຂໍ້ຄວາມ ທີ່ຈະສົ່ງໄປ (https://...)">
      <div class="seg"><button class="btn" id="lkOpen">🔗 ເປີດລິ້ງ</button><button class="btn" id="lkText">💬 ສົ່ງຂໍ້ຄວາມ</button></div>
      <div class="st" id="lkPend"></div><div class="st" id="lkProgT"></div><div class="prog"><i id="lkProg"></i></div></div>
    <div class="card" id="lkBrowse" hidden><h4 id="lkBrowseT">📁 ໄຟລ໌</h4><div id="lkFiles"></div></div>
    <div class="card"><h4>ເຄື່ອງນີ້ (<span id="lkMeN"></span>)</h4>
      <div class="grid">
        <button class="btn" id="lkCamOk">🎥 ອະນຸຍາດກ້ອງ</button>
        <button class="btn" id="lkScr">🖥 ເປີດແບ່ງປັນໜ້າຈໍ</button>
        <button class="btn" id="lkDir">📂 ເລືອກໂຟນເດີແບ່ງປັນ</button>
        <button class="btn" id="lkNotif">🔔 ແຈ້ງເຕືອນເຄື່ອງນີ້</button>
        <button class="btn" id="lkSnap">📷 ຖ່າຍຮູບເຄື່ອງນີ້</button>
        <button class="btn" id="lkRec">🎥 ວິດີໂອເຄື່ອງນີ້ 10 ວິ</button>
      </div>
      <video id="lkScrV" muted playsinline></video>
      <div class="st" id="lkMe"></div></div>
    <div class="card"><h4>📥 ກ່ອງຮັບ (ເກັບໄວ້ໃນເຄື່ອງນີ້)</h4><div id="lkInbox"></div></div>
  </div>
  <input type="file" id="lkFile" multiple hidden>`;
  document.body.appendChild(box);
  const fl = document.createElement("div"); fl.id = "lkFlash"; document.body.appendChild(fl);
  const tst = document.createElement("div"); tst.id = "lkToast"; document.body.appendChild(tst);
  function toast(t){ tst.textContent = t; tst.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => tst.classList.remove("on"), 4500); }
  function setProg(t, f){ $("lkProgT").textContent = t || ""; $("lkProg").style.width = t ? Math.round((f || 0) * 100) + "%" : "0"; }
  const openLink = () => { box.classList.add("open"); renderStatus(); renderInbox(); peerStatus(); fast = 10; };
  function closeLink(){ box.classList.remove("open"); }
  $("lkClose").onclick = closeLink;

  const btn = document.createElement("button"); btn.id = "auLinkBtn"; btn.className = "btn"; btn.style.cssText = "width:100%;margin:0 0 10px;border-color:rgba(79,227,255,.5)"; btn.textContent = "📡 ເຊື່ອມໂທລະສັບ ↔ ຄອມ: ຖ່າຍຮູບ, ວິດີໂອ, ໜ້າຈໍ, ໄຟລ໌";
  const more = $("v-more"); if (more){ const fab = $("auFab"); more.insertBefore(btn, fab ? fab.nextSibling : more.firstChild); }
  btn.onclick = openLink;
  window.aurumLink = {open: openLink, send: cmd, runLocal};

  box.querySelectorAll("[data-dev]").forEach(b => b.onclick = () => { localStorage.setItem("aurum_dev", b.dataset.dev); beat(); renderStatus(); peerStatus(); });
  box.querySelectorAll("[data-c]").forEach(b => b.onclick = () => {
    const t = b.dataset.c, a = t === "video" ? {sec:10} : t === "screenrec" ? {sec:15} : t === "ls" ? {path:""} : {};
    if (t === "ls") $("lkFiles").innerHTML = '<div class="st">ກຳລັງໂຫຼດ…</div>', $("lkBrowse").hidden = false;
    cmd(t, a, {analyze: !!b.dataset.an});
  });
  $("lkOpen").onclick = () => { const u = $("lkUrl").value.trim(); if (!/^https?:\/\//i.test(u)) return toast("ໃສ່ລິ້ງທີ່ຂຶ້ນຕົ້ນດ້ວຍ https://"); cmd("url", {url:u}); };
  $("lkText").onclick = () => { const u = $("lkUrl").value.trim(); if (!u) return; cmd("text", {text:u}); $("lkUrl").value = ""; };
  $("lkPut").onclick = () => $("lkFile").click();
  $("lkFile").onchange = async () => { for (const f of $("lkFile").files) await sendFile(f, f.name); $("lkFile").value = ""; };
  async function sendFile(blob, name){
    try{ setProg("⬆ ສົ່ງ " + name, 0); const ref = await putBlob(blob, f => setProg("⬆ ສົ່ງ " + name, f)); setProg(""); return cmd("put", {name, ref}); }
    catch(e){ setProg(""); toast("❌ " + e.message); }
  }
  $("lkCamOk").onclick = async () => { try{ await withCam({}, async () => {}); toast("✅ ອະນຸຍາດກ້ອງແລ້ວ"); }catch(e){ toast("❌ ກ້ອງ: " + (e.message || e.name)); } renderStatus(); };
  $("lkScr").onclick = async () => { try{ if (screenStream){ screenStream.getTracks().forEach(t => t.stop()); screenStream = null; renderStatus(); beat(); return; } await startScreen(); toast("✅ ແບ່ງປັນໜ້າຈໍແລ້ວ: ເປີດ MT5 ໄວ້ໃນໜ້າຈໍນີ້"); }catch(e){ toast("❌ " + (e.message || e.name)); } };
  $("lkDir").onclick = async () => { try{ if (window.__lkDirPending && !dirHandle){ await restoreFolder(true); if (dirHandle) return toast("✅ ໂຟນເດີ " + dirHandle.name); } await pickFolder(); toast("✅ ແບ່ງປັນໂຟນເດີ " + dirHandle.name); }catch(e){ if (e.name !== "AbortError") toast("❌ " + (e.message || e.name)); } };
  $("lkNotif").onclick = async () => { try{ const p = await Notification.requestPermission(); toast(p === "granted" ? "✅ ເປີດແຈ້ງເຕືອນແລ້ວ" : "ບໍ່ໄດ້ອະນຸຍາດ"); }catch(_){} };
  $("lkSnap").onclick = async () => { try{ const o = await runLocal("photo", {}); for (const it of o.items) await addInbox({kind:"file", from:me(), name:it.name, mime:it.blob.type, size:it.blob.size, blob:it.blob}); }catch(e){ toast("❌ " + (e.message || e.name)); } };
  $("lkRec").onclick = async () => { try{ const o = await runLocal("video", {sec:10, audio:true}); for (const it of o.items) await addInbox({kind:"file", from:me(), name:it.name, mime:it.blob.type, size:it.blob.size, blob:it.blob}); }catch(e){ toast("❌ " + (e.message || e.name)); } };

  function ago(t){ const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + " ວິ" : s < 3600 ? Math.round(s/60) + " ນາທີ" : Math.round(s/3600) + " ຊມ"; }
  function renderStatus(){
    if (!$("lkPeer")) return;
    box.querySelectorAll("[data-dev]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.dev === me())));
    $("lkMeN").textContent = NAME[me()]; $("lkRemoteT").textContent = "ສັ່ງ" + NAME[other()];
    $("lkPut").textContent = "⬆ ສົ່ງໄຟລ໌ໄປ" + (other() === "pc" ? "ຄອມ" : "ໂທລະສັບ");
    const on = peer && Date.now() - (peer.at || 0) < 45e3;
    $("lkPeer").innerHTML = !localStorage.getItem("aurum_pass") ? '<span class="no">ໃສ່ລະຫັດເຂົ້າແອັບກ່ອນ (⚙ ຕັ້ງຄ່າ)</span>'
      : on ? `<span class="ok">● ${NAME[other()]} ອອນລາຍ</span> · ກ້ອງ ${peer.cam ? "✓" : "✗"} · ໜ້າຈໍ ${peer.screen ? '<span class="ok">ແບ່ງປັນຢູ່</span>' : peer.canScreen ? '<span class="no">ຍັງບໍ່ເປີດ</span>' : "—"} · ໂຟນເດີ ${peer.folder ? E(peer.folder) : '<span class="no">ຍັງບໍ່ເລືອກ</span>'}`
      : `<span class="no">○ ${NAME[other()]} ບໍ່ອອນລາຍ</span>${peer && peer.at ? " (ເຫັນລ່າສຸດ " + ago(peer.at) + "ກ່ອນ)" : ""}: ເປີດ aurum-gold-beta.vercel.app ຢູ່ເຄື່ອງນັ້ນ ແລ້ວເລືອກວ່າເປັນ "${NAME[other()]}"`;
    $("lkScr").hidden = !cap.screen; $("lkDir").hidden = !cap.folder;
    $("lkScr").textContent = screenStream ? "⏹ ຢຸດແບ່ງປັນໜ້າຈໍ" : "🖥 ເປີດແບ່ງປັນໜ້າຈໍ";
    $("lkDir").textContent = dirHandle ? "📂 ໂຟນເດີ: " + dirHandle.name : window.__lkDirPending ? "📂 ອະນຸຍາດໂຟນເດີອີກເທື່ອ" : "📂 ເລືອກໂຟນເດີແບ່ງປັນ";
    $("lkScrV").style.display = screenStream ? "block" : "none";
    $("lkMe").innerHTML = (busyMsg ? "<b>" + E(busyMsg) + "</b><br>" : "") + (me() === "pc"
      ? "ຄອມ: ກົດ 'ເປີດແບ່ງປັນໜ້າຈໍ' (ເລືອກໜ້າຈໍທີ່ມີ MT5) ແລະ 'ເລືອກໂຟນເດີ' 1 ເທື່ອ, ແລ້ວເປີດແທັບນີ້ໄວ້ (ຫຍໍ້ໄວ້ກໍໄດ້). ໂທລະສັບຈະສັ່ງໄດ້ທັນທີ."
      : "ໂທລະສັບ: ຮັບຄຳສັ່ງໄດ້ເມື່ອເປີດແອັບຢູ່ໜ້າຈໍ. ໄຟລ໌ທີ່ສົ່ງມາຈະເຂົ້າ Downloads.");
  }
  function renderPending(){
    if (!$("lkPend")) return;
    const L = {photo:"ຖ່າຍຮູບ", video:"ອັດວິດີໂອ", screen:"ຖ່າຍໜ້າຈໍ", screenrec:"ອັດໜ້າຈໍ", ls:"ລາຍການໄຟລ໌", get:"ດຶງໄຟລ໌", put:"ສົ່ງໄຟລ໌", url:"ເປີດລິ້ງ", text:"ສົ່ງຂໍ້ຄວາມ", clip:"clipboard", ping:"ping"};
    $("lkPend").innerHTML = [...pending.values()].map(p => `⏳ ${L[p.type] || p.type}… ລໍ${NAME[other()]}ຕອບ`).join("<br>");
  }
  let browsePath = "";
  function showBrowser(list){
    browsePath = list.path || ""; $("lkBrowse").hidden = false;
    $("lkBrowseT").textContent = "📁 " + (list.root || "") + (browsePath ? "/" + browsePath : "");
    const up = browsePath ? `<div class="fl" data-up="1"><span>⬆ ກັບຂຶ້ນ</span></div>` : "";
    $("lkFiles").innerHTML = up + (list.items.length ? list.items.map((f, i) => `<div class="fl" data-i="${i}"><span>${f.kind === "dir" ? "📁" : "📄"} ${E(f.name)}</span><span class="st">${f.kind === "file" && f.size != null ? size(f.size) : ""}</span></div>`).join("") : '<div class="st">ວ່າງ</div>');
    $("lkFiles").querySelectorAll(".fl").forEach(el => el.onclick = () => {
      if (el.dataset.up){ const p = browsePath.split("/").slice(0, -1).join("/"); return cmd("ls", {path:p}); }
      const f = list.items[+el.dataset.i], p = (browsePath ? browsePath + "/" : "") + f.name;
      if (f.kind === "dir") cmd("ls", {path:p});
      else { if (f.size > MAX_FILE) return toast("ໄຟລ໌ໃຫຍ່ເກີນ 60 MB"); toast("⬇ ຂໍໄຟລ໌ " + f.name); cmd("get", {path:p}); }
    });
  }
  const urls = new Map();
  const urlOf = it => { if (!urls.has(it.id)) urls.set(it.id, URL.createObjectURL(it.blob)); return urls.get(it.id); };
  function renderInbox(){
    const el = $("lkInbox"); if (!el) return;
    if (!inbox.length){ el.innerHTML = '<div class="st">ຍັງບໍ່ມີ. ຮູບ, ວິດີໂອ, ໄຟລ໌ ແລະຂໍ້ຄວາມທີ່ຮັບມາຈະຢູ່ນີ້.</div>'; return; }
    el.innerHTML = inbox.map((it, i) => {
      const from = (it.from === me() ? "ເຄື່ອງນີ້" : "ຈາກ" + (NAME[it.from] || "")) + " · " + new Date(it.at).toLocaleTimeString("lo-LA", {hour:"2-digit", minute:"2-digit"});
      if (it.kind === "text") return `<div class="it"><div style="flex:1"><div class="nm">💬 ${E(it.text).slice(0, 600)}</div><div class="st">${E(it.note || "")} ${from}</div><div class="acts"><button class="btn" data-a="copy" data-i="${i}">ສຳເນົາ</button>${/^https?:\/\//.test(it.text) ? `<a class="btn" href="${E(it.text)}" target="_blank" rel="noopener">ເປີດ</a>` : ""}<button class="btn" data-a="del" data-i="${i}">ລຶບ</button></div></div></div>`;
      const img = /^image\//.test(it.mime), vid = /^video\//.test(it.mime);
      const th = img ? `<img class="th" src="${urlOf(it)}" alt="">` : vid ? `<video class="th" src="${urlOf(it)}" muted playsinline preload="metadata"></video>` : `<div class="th" style="display:grid;place-items:center;font-size:26px">📄</div>`;
      return `<div class="it">${th}<div style="flex:1;min-width:0"><div class="nm">${E(it.name)}</div><div class="st">${size(it.size || 0)} · ${from}</div><div class="acts">
        ${img || vid ? `<button class="btn" data-a="view" data-i="${i}">ເບິ່ງ</button>` : ""}
        ${img ? `<button class="btn pri" data-a="ai" data-i="${i}">🤖 ວິເຄາະ</button>` : ""}
        <button class="btn" data-a="save" data-i="${i}">⬇ ບັນທຶກ</button>
        ${navigator.canShare ? `<button class="btn" data-a="share" data-i="${i}">↗ ແບ່ງປັນ</button>` : ""}
        <button class="btn" data-a="fwd" data-i="${i}">➡ ສົ່ງໄປ${other() === "pc" ? "ຄອມ" : "ໂທລະສັບ"}</button>
        <button class="btn" data-a="del" data-i="${i}">ລຶບ</button></div></div></div>`;
    }).join("");
    el.querySelectorAll("[data-a]").forEach(b => b.onclick = async () => {
      const it = inbox[+b.dataset.i]; if (!it) return; const a = b.dataset.a;
      if (a === "copy"){ try{ await navigator.clipboard.writeText(it.text); toast("ສຳເນົາແລ້ວ"); }catch(_){ toast("ສຳເນົາບໍ່ໄດ້"); } }
      if (a === "view") window.open(urlOf(it), "_blank");
      if (a === "ai") useImage(it, true);
      if (a === "save"){ const l = document.createElement("a"); l.href = urlOf(it); l.download = it.name; document.body.appendChild(l); l.click(); l.remove(); }
      if (a === "share"){ try{ const f = new File([it.blob], it.name, {type: it.mime}); await navigator.share({files:[f], title: it.name}); }catch(_){} }
      if (a === "fwd") sendFile(it.blob, it.name);
      if (a === "del"){ inbox.splice(+b.dataset.i, 1); tx("inbox", "readwrite", s => s.delete(it.id)).catch(() => {}); renderInbox(); }
    });
  }

  /* ---------- say it in chat: "ຖ່າຍໜ້າຈໍຄອມ", "ອັດວິດີໂອຄອມ 20 ວິ", "ເປີດ https://... ໃນຄອມ" ---------- */
  const PC = /(ຄອມ|คอม|computer|\bpc\b|laptop|ໂນດບຸກ|โน้ตบุ๊ก)/i, PHONE = /(ມືຖື|มือถือ|ໂທລະສັບ|โทรศัพท์|phone)/i;
  function linkIntent(q){
    const target = PC.test(q) ? "pc" : PHONE.test(q) ? "phone" : null;
    if (!target || target === me()) return null;
    const sec = +((q.match(/(\d{1,2})\s*(ວິ|วิ|s\b|sec)/i) || [])[1] || 0);
    const url = (q.match(/https?:\/\/\S+/) || [])[0];
    if (url && /(ເປີດ|เปิด|open)/i.test(q)) return {t:"url", a:{url}};
    if (/(ໜ້າຈໍ|หน้าจอ|screen|ແຄັບ|แคป|mt5)/i.test(q) && /(ອັດ|อัด|record|ວິດີໂອ|วิดีโอ|video)/i.test(q)) return {t:"screenrec", a:{sec: sec || 15}};
    if (/(ໜ້າຈໍ|หน้าจอ|screen|ແຄັບ|แคป|mt5)/i.test(q)) return {t:"screen", a:{}, an: /(ວິເຄາະ|วิเคราะห์|analy|buy|sell|ເຂົ້າ|เข้า|ກຣາຟ|กราฟ|mt5)/i.test(q)};
    if (/(ວິດີໂອ|วิดีโอ|video|ອັດ|อัด)/i.test(q)) return {t:"video", a:{sec: sec || 10}};
    if (/(ຖ່າຍຮູບ|ถ่ายรูป|photo|ກ້ອງ|กล้อง)/i.test(q)) return {t:"photo", a:{}};
    if (/(ໄຟລ໌|ไฟล์|file|ໂຟນເດີ|โฟลเดอร์|folder|ເອກະສານ|เอกสาร)/i.test(q)) return {t:"ls", a:{path:""}, open:true};
    if (/(clipboard|ຄລິບບອດ|คลิปบอร์ด|ສຳເນົາ|คัดลอก)/i.test(q)) return {t:"clip", a:{}};
    return null;
  }
  try{
    const _send = window.send;
    if (typeof _send === "function"){
      window.send = async function(){
        const q = ($("q") && $("q").value.trim()) || "";
        const it = q && !st.img && linkIntent(q);
        if (!it) return _send.apply(this, arguments);
        addMsg("u", E(q)); $("q").value = "";
        const L = {screen:"ຖ່າຍໜ້າຈໍ", screenrec:"ອັດໜ້າຈໍ", video:"ອັດວິດີໂອ", photo:"ຖ່າຍຮູບ", ls:"ເປີດລາຍການໄຟລ໌", url:"ເປີດລິ້ງ", clip:"ດຶງ clipboard"};
        const m = addMsg("a", `📡 ສັ່ງ${NAME[other()]}: ${L[it.t]}${it.a.sec ? " " + it.a.sec + " ວິ" : ""}${it.an ? " ແລ້ວວິເຄາະ" : ""}…`);
        if (it.open) openLink();
        const r = await window.aurumLink.send(it.t, it.a, {analyze: !!it.an});
        m.innerHTML += r.ok ? `<br>✅ ${r.files && r.files.length ? "ໄດ້ຮັບ " + E(r.files.map(f => f.name).join(", ")) + " (ຢູ່ໃນ 📡 ກ່ອງຮັບ)" : E(r.text || "ສຳເລັດ")}` : `<br>❌ ${E(r.err || "")}`;
        if (r.ok && r.files && r.files[0] && !it.an){ const f = r.files[0]; if (/^image\//.test(f.mime)) m.innerHTML += `<br><img src="${urlOf(f)}" style="max-width:100%;border-radius:10px;margin-top:6px" alt="">`; if (/^video\//.test(f.mime)) m.innerHTML += `<br><video src="${urlOf(f)}" controls playsinline style="max-width:100%;border-radius:10px;margin-top:6px"></video>`; }
        scrollMsgs();
      };
    }
  }catch(e){ console.error("link send", e); }

  loadInbox().then(renderInbox); restoreFolder(false);
  setTimeout(() => { beat(); peerStatus(); }, 1500);
})();
