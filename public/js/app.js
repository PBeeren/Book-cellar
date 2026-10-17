import * as api from './db.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = x => parseFloat(String(x ?? '').replace(',', '.')) || 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const eur = x => '€ ' + Number(x).toFixed(2).replace('.', ',');
const C = new URLSearchParams(location.search).get('c');

let wines = {}, log = [], orders = [], mode = 'in', pending = null, order = [], lastScan = { c: '', t: 0 };
let pricing = { factor: 3, round: 1 }, ltext = { title: 'Wine List', intro: '', foot: '', labels: {}, types: [] };
let cellar = null, myId = null, myEmail = '', role = 'employee', isMgr = false, nameOf = {};

/* ---------- start ---------- */
async function start() {
  if (!api.configured) { location.replace('index.html'); return; }
  const s = await api.session();
  if (!s || !C) { location.replace('index.html'); return; }
  myId = s.user.id; myEmail = s.user.email || '';
  try {
    cellar = await api.getCellar(C);
  } catch (e) { $('loading').innerHTML = 'You do not have access to this cellar. <a href="index.html?pick">Choose another</a>'; return; }
  const mem = await api.members(C).catch(() => []);
  mem.forEach(m => nameOf[m.user_id] = m.email);
  role = (mem.find(m => m.user_id === myId) || {}).role || 'employee';
  isMgr = role === 'owner' || role === 'manager';
  document.body.classList.toggle('emp', !isMgr);
  applyCellar();
  $('who').textContent = myEmail + ' · ' + (isMgr ? (role === 'owner' ? 'Owner' : 'Manager') : 'Employee: scan in/out, orders and wine details');
  if (!isMgr) ['wlTitle', 'wlIntro', 'wlFoot'].forEach(i => $(i).readOnly = true);
  $('loading').style.display = 'none'; $('main').style.display = '';
  await reloadAll();
  markReady();
  api.subscribe(C, {
    wine: r => { const code = r.code; wines[code] = cleanWine(api.fromRow(r)); schedRender(); },
    movement: m => { if (!log.some(x => x.id === m.id)) { log.unshift(m); log = log.slice(0, 300); schedRender(); } },
    order: o => { const i = orders.findIndex(x => x.id === o.id); if (i >= 0) orders[i] = o; else { orders.unshift(o); if (o.status === 'new') { beep(true); toastOrder(o); } } renderOrders(); }
  }, st => { $('sync').textContent = st === 'SUBSCRIBED' ? 'Live — changes by your team appear instantly' : st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' ? '⚠ Live updates interrupted — reloading when you come back' : $('sync').textContent; });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reloadAll(); });
  setInterval(() => { if (document.visibilityState === 'visible') reloadAll(); }, 5 * 60 * 1000);
}
async function reloadAll() {
  try {
    const [ws, ms, os] = await Promise.all([api.loadWines(C), api.loadMovements(C), api.loadOrders(C)]);
    const w = {}; ws.forEach(r => w[r.code] = cleanWine(api.fromRow(r))); wines = w; log = ms; orders = os;
    render(); renderOrders();
    if (!$('wl').classList.contains('hide')) renderWl();
  } catch (e) { $('sync').textContent = '⚠ Could not load: ' + e.message; $('sync').style.color = 'var(--bad)'; }
}
function applyCellar() {
  const st = cellar.settings || {};
  if (st.pricing && st.pricing.factor) pricing = st.pricing;
  ltext = { ...ltext, ...(st.ltext || {}) }; if (!ltext.labels) ltext.labels = {};
  order = st.order || [];
  $('cName').textContent = cellar.name; document.title = cellar.name + ' · Cellar Book'; $('cNameIn').value = cellar.name;
  applyLtext(); fillShopCfg(); renderShopStatus();
}
async function saveSettings(patch) {
  const settings = { ...(cellar.settings || {}), ...patch };
  await api.updateCellar(C, { settings }); cellar.settings = settings;
}
let renderT = null;
function schedRender() { clearTimeout(renderT); renderT = setTimeout(() => { render(); if (!$('wl').classList.contains('hide')) renderWl(); }, 120); }

/* ---------- saving ---------- */
function syncOk() { $('sync').style.color = ''; $('sync').textContent = 'Saved ✓'; }
function syncFail(e) { const m = '⚠ NOT SAVED: ' + (e && e.message || e); $('sync').textContent = m; $('sync').style.color = 'var(--bad)'; toast(m, 'bad'); }
async function saveWine(code, w, withStock = false) {
  wines[code] = w; render();
  try { const r = await api.saveWine(C, code, w, withStock && isMgr); wines[code] = cleanWine(api.fromRow(r)); syncOk(); render(); return true; }
  catch (e) { syncFail(e); await reloadAll(); return false; }
}
async function stock(code, delta, kind, place) {
  const n = await api.adjustStock(C, code, delta, kind, place || '');
  if (wines[code]) { wines[code].bottles = n; if (place && delta > 0) addPlace(wines[code], place.toUpperCase()); }
  render(); return n;
}

/* ---------- scanning ---------- */
function toast(msg, kind) { const t = $('toast'); t.textContent = msg; t.className = 'toast ' + kind; clearTimeout(toast.h); toast.h = setTimeout(() => t.className = 'toast', 6000); }
function beep(ok) { try { const a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(); o.frequency.value = ok ? 880 : 220; o.connect(a.destination); o.start(); o.stop(a.currentTime + .12) } catch (e) { } }
let isReady = false, readyRes; const ready = new Promise(r => readyRes = r);
function markReady() { if (isReady) return; isReady = true; readyRes(); }
async function handleCode(raw, fromCam) {
  if (!isReady) { toast('Loading your inventory… your scan is processed as soon as it is ready', 'ok'); await ready; }
  const scanned = String(raw).trim().replace(/[^\w-]/g, ''); const code = findCode(scanned);
  if (!code) return;
  const now = Date.now(), m = mode;
  if (code === lastScan.c && now - lastScan.t < (fromCam ? 2500 : 600)) { slog('Ignored: ' + code + ' was scanned twice within ' + (fromCam ? '2.5' : '0.6') + ' seconds', 'warn'); return; }
  lastScan = { c: code, t: now };
  const w = wines[code];
  if (m === 'in') {
    if (w) {
      const before = w.bottles || 0, p = $('place').value.trim().toUpperCase() || '';
      const li = slog(`IN · ${w.name} ${w.vintage || ''} · ${before} → ${before + 1} bottles · saving…`, 'pend');
      beep(true);
      try { const n = await stock(code, 1, 'in', p); slogEnd(li, true); toast(`✓ IN: ${w.name} ${w.vintage || ''} — now ${n} in stock${p ? ' · place ' + p : ''}`, 'ok'); }
      catch (e) { slogEnd(li, false, e); beep(false); toast('✗ ' + e.message, 'bad'); }
    } else { slog(`IN · barcode ${code} is new → fill in the form`, 'warn'); openForm(code); beep(true); }
  } else {
    if (!w) { slog(`OUT · barcode ${code} not found in the inventory`, 'bad'); beep(false); toast(`✗ Unknown barcode ${code}. This bottle was never registered IN.`, 'bad'); return; }
    if ((w.bottles || 0) <= 0) { slog(`OUT · ${w.name}: already 0 bottles`, 'bad'); beep(false); toast(`⚠ ${w.name}: stock is already 0 — check your records.`, 'bad'); return; }
    const before = w.bottles, op = plNames(w).join(', ');
    const li = slog(`OUT · ${w.name} ${w.vintage || ''} · ${before} → ${before - 1} bottles · saving…`, 'pend');
    beep(true);
    try { const n = await stock(code, -1, 'out'); slogEnd(li, true); toast(`✓ OUT: ${w.name} ${w.vintage || ''} ${op ? ' · from place ' + op : ''} — ${n} left${n <= 2 ? ' (low!)' : ''}`, n <= 2 ? 'bad' : 'ok'); }
    catch (e) { slogEnd(li, false, e); beep(false); toast('✗ ' + e.message, 'bad'); }
  }
}
const scanLog = [];
function slog(text, state) { const e = { t: new Date(), text, state }; scanLog.unshift(e); if (scanLog.length > 6) scanLog.length = 6; drawLog(); return e; }
function slogEnd(e, ok, err) { e.state = ok ? 'ok' : 'bad'; e.text = e.text.replace('saving…', ok ? 'saved ✓' : 'NOT saved: ' + ((err && err.message) || 'error')); drawLog(); }
function drawLog() { const el = $('scanLog'); el.innerHTML = scanLog.map(e => `<div class="meta" style="padding:3px 0;color:${e.state === 'ok' ? 'var(--ok)' : e.state === 'bad' ? 'var(--bad)' : e.state === 'warn' ? 'var(--warn)' : 'var(--mute)'}">${e.t.toLocaleTimeString('nl-NL')} · ${esc(e.text)}</div>`).join(''); }
function openForm(code) { pending = code; $('newCode').textContent = code; $('fLoc').value = $('place').value; $('newForm').classList.add('on'); $('fName').focus(); }
function closeForm() { pending = null; $('newForm').classList.remove('on'); ['fName', 'fVint', 'fLoc', 'fPrice'].forEach(i => $(i).value = ''); $('fQty').value = '1'; }
$('fSave').onclick = async () => {
  const name = $('fName').value.trim(); if (!name) { $('fName').focus(); return; }
  const qty = isMgr ? Math.max(1, parseInt($('fQty').value) || 1) : 1, code = pending; const pl = ($('fLoc').value.trim() || $('place').value.trim()).toUpperCase();
  const dk = findByKey(name, $('fVint').value.trim());
  $('fSave').disabled = true;
  try {
    if (dk && dk !== code) {
      const ex = wines[dk]; ex.aliases = [...new Set([...(ex.aliases || []), code])]; closeForm();
      await saveWine(dk, ex); const n = await stock(dk, qty, 'in', pl);
      toast(`✓ Matched existing wine "${ex.name}" — barcode linked, now ${n} in stock`, 'ok');
    } else {
      const price = num($('fPrice').value);
      const w = cleanWine({ name, vintage: $('fVint').value.trim(), loc: pl, price, sell: price > 0 ? calcSell(price) : 0, bottles: 0 });
      closeForm();
      if (await saveWine(code, w)) { await stock(code, qty, 'in', pl); toast(`✓ Registered ${name} (${qty} bottle${qty > 1 ? 's' : ''})`, 'ok'); }
    }
  } catch (e) { toast('✗ ' + e.message, 'bad'); }
  $('fSave').disabled = false;
};
$('fCancel').onclick = closeForm;
$('code').addEventListener('change', () => { if ($('code').value.trim()) $('go').click(); });
$('go').onclick = () => { handleCode($('code').value); $('code').value = ''; $('code').focus(); };
$('code').addEventListener('keydown', e => { if (e.key === 'Enter' || (e.key === 'Tab' && $('code').value.trim())) { e.preventDefault(); $('go').click(); } });
$('mIn').onclick = () => setMode('in'); $('mOut').onclick = () => setMode('out');
function setMode(m) { mode = m; $('mIn').classList.toggle('on', m === 'in'); $('mOut').classList.toggle('on', m === 'out'); $('code').focus(); }

/* ---------- camera ---------- */
let stream = null, timer = null, zx = null;
$('camBtn').onclick = async () => {
  if (stream || zx) { stopCam(); return; }
  const v = $('cam');
  try {
    if ('BarcodeDetector' in window) {
      const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code', 'itf'] });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      v.srcObject = stream; await v.play(); v.style.display = 'block'; $('camBtn').textContent = '⏹ Stop camera';
      timer = setInterval(async () => { try { const r = await det.detect(v); if (r.length) handleCode(r[0].rawValue, true); } catch (e) { } }, 350);
    } else {
      await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
      zx = new ZXing.BrowserMultiFormatReader(); v.style.display = 'block'; $('camBtn').textContent = '⏹ Stop camera';
      zx.decodeFromConstraints({ video: { facingMode: 'environment' } }, v, (r) => { if (r) handleCode(r.getText(), true); });
    }
  } catch (e) { stopCam(); toast('Camera not available here. Type the barcode or use a scanner instead.', 'bad'); }
};
function stopCam() { clearInterval(timer); timer = null; if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } if (zx) { try { zx.reset(); } catch (e) { } zx = null; } $('cam').style.display = 'none'; $('camBtn').textContent = '📷 Start camera'; }

/* ---------- inventory view ---------- */
const placesStr = w => plNames(w).join(', ') || 'No place';
function render() { try { renderCore(); } catch (e) { console.error(e); $('sync').textContent = '⚠ Display error: ' + e.message; $('sync').style.color = 'var(--bad)'; } }
function renderCore() {
  const q = $('q').value.toLowerCase(), all = Object.entries(wines);
  const val = all.reduce((a, [, w]) => a + (w.bottles || 0) * (w.price || 0), 0);
  if (isMgr) schedDup();
  if (cellar) renderShopStatus();
  $('sWin').textContent = all.filter(([, w]) => w.bottles > 0).length; $('sVal').textContent = '€' + Math.round(val).toLocaleString('nl-NL');
  const rows = all.filter(([c, w]) => (w.name + ' ' + w.vintage + ' ' + w.loc + ' ' + c + ' ' + (w.aliases || []).join(' ')).toLowerCase().includes(q)).sort(invCmp);
  const lim = rows.slice(0, listShown);
  $('list').innerHTML = rows.length ? lim.map(([c, w]) => `<div class="item">${selMode ? `<input type="checkbox" class="sc" data-c="${esc(c)}" ${selSet.has(c) ? 'checked' : ''} style="width:22px;height:22px;flex:none">` : ''}<div style="flex:1;min-width:0"><div class="nm">${esc(w.name)} ${esc(w.vintage)}${w.noShop ? ' <span class="meta">· not in shop</span>' : ''}</div><div class="meta">${[w.type, w.country, w.region, w.sub].filter(Boolean).map(esc).join(' · ')}</div><div class="meta">📍 ${esc(placesStr(w))} · ${esc(c)}<span class="mgr-only">${w.price ? ' · cost €' + w.price : ''}${w.sell ? ' · menu €' + w.sell : ''}${shopPriceOf(w) ? ' · shop €' + shopPriceOf(w) : ''}</span></div></div><div class="ctl"><button class="sm mgr-only" data-a="dec" data-c="${esc(c)}">−</button><div class="qty ${w.bottles <= 0 ? 'zero' : w.bottles <= 2 ? 'low' : ''}">${w.bottles || 0}<div class="meta" style="font-size:10px;font-weight:normal">bottles</div></div><button class="sm mgr-only" data-a="inc" data-c="${esc(c)}">+</button><button class="sm" data-a="edit" data-c="${esc(c)}">✎</button></div></div>`).join('') + (rows.length > listShown ? `<button class="btn ghost" id="listMore" style="width:100%;margin-top:8px">Show more (${rows.length - listShown} left)</button>` : '') : '<div class="meta">No wines yet. Scan a bottle IN to start.</div>';
  $('logList').innerHTML = log.length ? log.slice(0, 200).map(e => `<div class="item"><div><div class="nm">${esc(e.name)}</div><div class="meta">${new Date(e.ts).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' })}${e.place ? ' · place ' + esc(e.place) : ''}${e.order_id ? ' · order #' + e.order_id : ''}${e.by && nameOf[e.by] ? ' · ' + esc(nameOf[e.by]) : ''}</div></div><span class="tag ${e.kind}">${e.kind === 'in' ? 'IN' : e.kind === 'out' ? 'OUT' : e.kind === 'order' ? 'ORDER ' + e.delta : e.kind === 'cancel' ? 'RETURN +' + e.delta : 'ADJ ' + (e.delta > 0 ? '+' : '') + e.delta}</span></div>`).join('') : '<div class="meta">No movements yet.</div>';
}
let listShown = 150;
$('q').oninput = () => { listShown = 150; render(); };
document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === b));
  ['scan', 'stock', 'orders', 'log', 'labels', 'wl', 'settings'].forEach(s => $(s).classList.toggle('hide', s !== b.dataset.t));
  if (b.dataset.t !== 'scan') stopCam(); else setTimeout(() => $('code').focus(), 50);
  if (b.dataset.t === 'labels') renderLabels();
  if (b.dataset.t === 'wl') renderWl();
  if (b.dataset.t === 'settings') renderTeam();
});

/* ---------- editor ---------- */
let editing = null, eManual = false, ePhoto = '', ePhotoOld = '', ePhotoPrev = '';
function openEd(code) {
  const isNew = !code; code = code || ('CB' + Date.now().toString(36).toUpperCase().slice(-6)); editing = code;
  const w = wines[code] || cleanWine({ name: '' });
  $('eCode').value = code; $('eCode').readOnly = !isNew; $('eName').value = w.name; $('eVint').value = w.vintage || ''; $('ePrice').value = w.price || '';
  setPlRows(w); $('eQty').value = w.bottles || 0;
  $('eType').value = w.type || ''; $('eCountry').value = w.country || ''; $('eRegion').value = w.region || ''; $('eSub').value = w.sub || ''; $('eClass').value = w.cls || ''; $('eSell').value = w.sell || ''; eManual = !!w.sellManual || (!w.price && w.sell > 0); fillDl();
  $('eShop').value = w.shopPrice || ''; $('eShop').placeholder = 'Webshop price € (blank = auto' + (w.price > 0 ? ': €' + calcShop(w.price) : '') + ')'; $('eNoShop').checked = !!w.noShop;
  $('eListName').value = w.listName || ''; $('eDesc').value = w.desc || ''; ePhoto = w.photo || ''; ePhotoOld = ePhoto; ePhotoPrev = ''; $('ePhMsg').textContent = ''; showPh();
  $('eDel').classList.toggle('hide', isNew); $('eDel').textContent = 'Delete wine'; $('eDel').dataset.arm = '';
  $('editor').classList.add('on'); $('eName').focus(); $('editor').scrollIntoView({ block: 'center' });
}
function closeEd() { editing = null; $('editor').classList.remove('on'); }
$('newWine').onclick = () => openEd();
$('eCancel').onclick = closeEd;
$('eSave').onclick = async () => {
  const code = $('eCode').value.trim().replace(/[^\w-]/g, ''), name = $('eName').value.trim();
  if (!code) { $('eCode').focus(); return; } if (!name) { $('eName').focus(); return; }
  const isNew = !wines[code], old = wines[code] || cleanWine({ name }), qty = Math.max(0, parseInt($('eQty').value) || 0);
  const w = cleanWine({ ...old, name, vintage: $('eVint').value.trim(), price: num($('ePrice').value), loc: readPl().join(', '), type: typeVal($('eType').value), photo: ePhoto, listName: $('eListName').value.trim(), desc: $('eDesc').value.trim(), country: $('eCountry').value.trim(), region: $('eRegion').value.trim(), sub: $('eSub').value.trim(), cls: $('eClass').value.trim(), sell: num($('eSell').value), sellManual: eManual, shopPrice: num($('eShop').value), noShop: $('eNoShop').checked });
  if (!isMgr) { w.price = old.price || 0; w.sell = old.sell || 0; w.sellManual = old.sellManual; w.shopPrice = old.shopPrice || 0; w.noShop = !!old.noShop; }
  w.bottles = old.bottles || 0;
  closeEd();
  if (!(await saveWine(code, w))) return;
  if (ePhotoOld && ePhotoOld !== ePhoto) api.deletePhoto(ePhotoOld).catch(() => { });
  const d = isMgr ? qty - (old.bottles || 0) : 0;
  if (d) { try { await stock(code, d, 'adj'); } catch (e) { toast('✗ Stock not changed: ' + e.message, 'bad'); } }
  if (isNew) toast(`✓ Added ${name}`, 'ok');
};
$('eDel').onclick = async () => {
  if (!isMgr) return;
  const b = $('eDel'); if (b.dataset.arm !== '1') { b.dataset.arm = '1'; b.textContent = 'Tap again to confirm'; return; }
  const c = editing, ph = wines[c] && wines[c].photo; closeEd();
  try { await api.deleteWines(C, [c]); delete wines[c]; if (ph) api.deletePhoto(ph).catch(() => { }); render(); } catch (e) { syncFail(e); }
};
$('list').onclick = async e => {
  if (e.target.id === 'listMore') { listShown += 150; render(); return; }
  const b = e.target.closest('button[data-a]'); if (!b) return; const c = b.dataset.c, w = wines[c]; if (!w) return;
  if (b.dataset.a === 'edit') { openEd(c); return; }
  if (!isMgr) return;
  try {
    if (b.dataset.a === 'inc') await stock(c, 1, 'adj');
    if (b.dataset.a === 'dec' && (w.bottles || 0) > 0) await stock(c, -1, 'adj');
  } catch (err) { toast('✗ ' + err.message, 'bad'); }
};

/* ---------- photos ---------- */
function showPh() { const img = $('ePhImg'); if (ePhoto) { img.src = ePhotoPrev || api.photoUrl(ePhoto); img.style.display = 'block'; } else { img.removeAttribute('src'); img.style.display = 'none'; } $('ePhDel').classList.toggle('hide', !ePhoto); }
function resizeImg(file, max = 900, q = 0.82) { return new Promise((res, rej) => { const u = URL.createObjectURL(file), i = new Image(); i.onload = () => { const k = Math.min(1, max / Math.max(i.width, i.height)), c = document.createElement('canvas'); c.width = Math.round(i.width * k); c.height = Math.round(i.height * k); c.getContext('2d').drawImage(i, 0, 0, c.width, c.height); URL.revokeObjectURL(u); c.toBlob(b => b ? res(b) : rej(new Error('Could not process the image')), 'image/jpeg', q); }; i.onerror = () => rej(new Error('Not a readable image')); i.src = u; }); }
$('ePhAdd').onclick = () => $('ePhFile').click();
$('ePhFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return; $('ePhMsg').textContent = 'Uploading…';
  try { const blob = await resizeImg(f), path = await api.uploadPhoto(C, blob); ePhoto = path; ePhotoPrev = URL.createObjectURL(blob); $('ePhMsg').textContent = 'Photo ready. Tap Save to keep it.'; showPh(); }
  catch (err) { $('ePhMsg').textContent = 'Photo failed: ' + (err.message || 'error'); }
};
$('ePhDel').onclick = () => { ePhoto = ''; ePhotoPrev = ''; showPh(); $('ePhMsg').textContent = 'Photo removed. Tap Save to confirm.'; };

/* ---------- downloads (plain browser download) ---------- */
function download(filename, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'text/plain;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- labels ---------- */
const LCSS = '@page{margin:8mm}#sheet{grid-template-columns:repeat(3,1fr);gap:4mm;font-family:Georgia,serif;color:#000;background:#fff}.lbl{border:1px dashed #999;padding:3mm;text-align:center;break-inside:avoid;overflow:hidden;color:#000}.lbl .t{font:bold 13px Georgia,serif;margin-bottom:2mm}.lbl svg{max-width:100%;height:auto}.wl{color:inherit}.wl h1{text-align:center;font:bold 28px Georgia,serif;margin:0 0 8px}.wl h2{font:bold 20px Georgia,serif;margin:18px 0 4px;border-bottom:2px solid #999;padding-bottom:2px}.wl h3{font:bold 15px Georgia,serif;margin:12px 0 2px;opacity:.85}.wl h4{font:italic 13px Georgia,serif;margin:8px 0 2px;opacity:.75}.wl .w{display:flex;justify-content:space-between;gap:12px;padding:2px 0;border-bottom:1px dotted #999;font:14px Georgia,serif}.wl .gc{font-weight:bold}.wl .p{white-space:nowrap}.wl h2.ty{font-size:24px;text-transform:uppercase;letter-spacing:2px;text-align:center;border-bottom:3px solid #7b1e3a;margin-top:26px}.wl h2.ty~h2.ty{break-before:page}.wl .intro{text-align:center;font-style:italic;margin:0 0 12px}.wl .foot{text-align:center;margin-top:24px;font-size:13px;opacity:.8}.wl .wd{display:block;font-size:12px;font-style:italic;font-weight:normal;opacity:.75}';
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: LCSS + '#sheet{display:none}@media print{body{background:#fff}.wrap,#loading{display:none!important}#sheet{display:grid!important}}' }));
let sel = {};
function renderLabels() {
  const rows = Object.entries(wines).sort((a, b) => a[1].name.localeCompare(b[1].name));
  $('lblList').innerHTML = rows.length ? rows.map(([c, w]) => `<div class="item"><label class="nm"><input type="checkbox" data-c="${esc(c)}" ${sel[c] ? 'checked' : ''} style="width:auto;margin-right:8px">${esc(w.name)} ${esc(w.vintage)}<div class="meta">${esc(c)}</div></label><input type="number" min="1" max="99" value="${sel[c] || 1}" data-n="${esc(c)}" style="width:70px"></div>`).join('') : '<div class="meta">Add a wine first (Inventory → + New wine).</div>';
}
$('lblList').onchange = e => { const t = e.target; if (t.dataset.c) sel[t.dataset.c] = t.checked ? (parseInt(t.closest('.item').querySelector('[data-n]').value) || 1) : 0; if (t.dataset.n && sel[t.dataset.n]) sel[t.dataset.n] = Math.max(1, parseInt(t.value) || 1); };
$('lAll').onclick = () => { Object.keys(wines).forEach(c => sel[c] = sel[c] || 1); renderLabels(); };
$('lNone').onclick = () => { sel = {}; renderLabels(); };
function lblHtml() {
  let h = '';
  for (const [c, n] of Object.entries(sel)) {
    const w = wines[c]; if (!w || !n) continue;
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    try { JsBarcode(s, c, { format: 'CODE128', height: 40, displayValue: true, fontSize: 12, margin: 0 }); } catch (e) { continue; }
    for (let i = 0; i < n; i++) h += `<div class="lbl"><div class="t">${esc(w.name)} ${esc(w.vintage)}</div>${s.outerHTML}</div>`;
  }
  return h;
}
$('lPrint').onclick = () => {
  if (typeof JsBarcode === 'undefined') { $('lMsg').textContent = 'Barcode library did not load. Check your connection.'; return; }
  const h = lblHtml(); if (!h) { $('lMsg').textContent = 'Tick at least one wine first.'; return; }
  $('sheet').innerHTML = h; window.print();
};
$('lDl').onclick = () => {
  if (typeof JsBarcode === 'undefined') { $('lMsg').textContent = 'Barcode library did not load. Check your connection.'; return; }
  const h = lblHtml(); if (!h) { $('lMsg').textContent = 'Tick at least one wine first.'; return; }
  download('wine-labels.html', '<!DOCTYPE html><meta charset="utf-8"><title>Wine labels</title><style>' + LCSS + '</style><div id="sheet" style="display:grid">' + h + '</div>', 'text/html');
  $('lMsg').textContent = 'Saved. Open the file and press Ctrl/Cmd+P.';
};

/* ---------- wine list ---------- */
function fillDl() { fillTypes(); const u = k => [...new Set(Object.values(wines).map(w => w[k]).filter(Boolean))].sort();[['dlCountry', 'country'], ['dlRegion', 'region'], ['dlSub', 'sub']].forEach(([id, k]) => $(id).innerHTML = u(k).map(v => `<option value="${esc(v)}">`).join('')); }
const CLS = ['grand cru', 'premier cru', 'village', 'regional'];
const clsRank = c => { const i = CLS.indexOf((c || '').toLowerCase()); return i < 0 ? 9 : i; };
const TYPES = ['Mousserend', 'Wit', 'Rood', 'Rosé'], TYPE_NONE = 'Overig';
const TSYN = { Mousserend: ['mousserend', 'sparkling', 'champagne', 'cava', 'prosecco', 'cremant', 'sekt', 'spumante', 'frizzante', 'bubbels', 'bubbly'], Wit: ['wit', 'white', 'blanc', 'bianco', 'blanco', 'weiss', 'weisswein'], Rood: ['rood', 'red', 'rouge', 'rosso', 'tinto', 'rot', 'rotwein'], 'Rosé': ['rose', 'rosato', 'rosado'] };
function normType(x) { const t = String(x == null ? '' : x).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim(); if (!t) return ''; for (const [k, l] of Object.entries(TSYN)) if (l.includes(t)) return k; return ''; }
function capType(v) { v = String(v == null ? '' : v).trim(); return v.charAt(0).toUpperCase() + v.slice(1); }
function typeVal(v) { return normType(v) || capType(v); }
function fillTypes() { const u = new Set([...TYPES, ...(ltext.types || [])]); Object.values(wines).forEach(w => { if (w.type) u.add(w.type); }); $('dlType').innerHTML = [...u].map(v => `<option value="${esc(v)}">`).join(''); }
function ksort(o, pre) {
  return Object.keys(o).sort((a, b) => {
    const ia = order.indexOf(pre + a), ib = order.indexOf(pre + b);
    if (ia >= 0 && ib >= 0) return ia - ib; if (ia >= 0) return -1; if (ib >= 0) return 1;
    if (pre === 'T:') { const rk = x => x === TYPE_NONE ? 99 : (TYPES.indexOf(x) >= 0 ? TYPES.indexOf(x) : 50); return rk(a) - rk(b) || a.localeCompare(b); }
    return a === 'Other' ? 1 : b === 'Other' ? -1 : a === '-' ? -1 : b === '-' ? 1 : a.localeCompare(b);
  });
}
function wlTree() {
  const inStock = $('wlStock').checked, gcOnly = $('wlGC').checked, byType = $('wlByType').checked;
  const arr = Object.entries(wines).filter(([, w]) => (!inStock || w.bottles > 0) && (!gcOnly || (w.cls || '').toLowerCase() === 'grand cru')).map(([c, w]) => ({ ...w, _c: c }));
  const g = (o, k, d) => o[k] || (o[k] = d), tree = {};
  arr.forEach(w => g(g(g(g(tree, byType ? (w.type || TYPE_NONE) : '-', {}), w.country || 'Other', {}), w.region || '-', {}), w.sub || '-', []).push(w));
  return { arr, tree };
}
function wlHtml(ui) {
  const prices = $('wlPrice').checked, showDesc = $('wlDesc').checked, { arr, tree } = wlTree();
  const mv = (pre, name, obj) => { if (!ui) return ''; const sib = ksort(obj, pre).map(x => pre + x).join('~~'); return `<span class="mv" style="float:right"><button class="sm" data-ren="${esc(pre + name)}" data-orig="${esc(name)}">✎</button> <button class="sm" data-mv="${esc(pre + name)}" data-d="-1" data-sib="${esc(sib)}">▲</button> <button class="sm" data-mv="${esc(pre + name)}" data-d="1" data-sib="${esc(sib)}">▼</button></span>`; };
  const intro = $('wlIntro').value.trim(), foot = $('wlFoot').value.trim();
  let h = `<h1>${esc($('wlTitle').value)}</h1>` + (intro ? `<p class="intro">${esc(intro).replace(/\n/g, '<br>')}</p>` : '');
  if (!arr.length) return h + '<div class="meta">No wines match yet.</div>';
  for (const t of ksort(tree, 'T:')) {
    if (t !== '-') h += `<h2 class="ty">${esc(lab('T:' + t, t))}${mv('T:', t, tree)}</h2>`;
    const ct = tree[t];
    for (const c of ksort(ct, 'C:')) {
      h += `<h2>${esc(lab('C:' + c, c))}${mv('C:', c, ct)}</h2>`;
      for (const r of ksort(ct[c], 'R:' + c + '|')) {
        if (r !== '-') h += `<h3>${esc(lab('R:' + c + '|' + r, r))}${mv('R:' + c + '|', r, ct[c])}</h3>`;
        for (const s of ksort(ct[c][r], 'S:' + c + '|' + r + '|')) {
          if (s !== '-') h += `<h4>${esc(lab('S:' + c + '|' + r + '|' + s, s))}${mv('S:' + c + '|' + r + '|', s, ct[c][r])}</h4>`;
          ct[c][r][s].sort(wlCmp).forEach(w => { h += `<div class="w"${ui !== undefined ? ` data-c="${esc(w._c)}"` : ''}><span>${esc(w.listName || (w.name + ' ' + w.vintage))}${!w.listName && w.cls ? ' · ' + esc(w.cls) : ''}${w.photo && ui !== undefined ? ' 📷' : ''}${showDesc && w.desc ? `<span class="wd">${esc(w.desc)}</span>` : ''}</span><span class="p">${prices && w.sell ? '€ ' + w.sell.toFixed(2).replace('.', ',') : ''}</span></div>`; });
        }
      }
    }
  }
  return h + (foot ? `<p class="foot">${esc(foot).replace(/\n/g, '<br>')}</p>` : '');
}
function wlFlat() {
  const { tree } = wlTree(), out = [];
  for (const t of ksort(tree, 'T:')) for (const c of ksort(tree[t], 'C:')) for (const r of ksort(tree[t][c], 'R:' + c + '|')) for (const s of ksort(tree[t][c][r], 'S:' + c + '|' + r + '|'))
    tree[t][c][r][s].sort(wlCmp).forEach(w => out.push({ t, c, r: r === '-' ? '' : r, s: s === '-' ? '' : s, w, code: w._c }));
  return out;
}
function wlCmp(a, b) {
  const m = $('wlSort').value, pa = a.sell > 0 ? a.sell : null, pb = b.sell > 0 ? b.sell : null;
  const byName = a.name.localeCompare(b.name) || String(a.vintage).localeCompare(String(b.vintage));
  if (m === 'cls') return clsRank(a.cls) - clsRank(b.cls) || byName;
  if (pa === null && pb === null) return byName; if (pa === null) return 1; if (pb === null) return -1;
  return (m === 'desc' ? pb - pa : pa - pb) || byName;
}
let arrange = false;
function renderWl() { $('wlOut').innerHTML = wlHtml(arrange); }
async function saveOrder() { renderWl(); try { await saveSettings({ order }); } catch (e) { $('wlMsg').textContent = 'Could not save the order: ' + e.message; } }
$('wlArr').onclick = () => { arrange = !arrange; $('wlArr').textContent = arrange ? '✓ Done arranging' : '↕ Arrange order'; renderWl(); };
$('wlOut').onclick = async e => {
  const rb = e.target.closest('button[data-ren]'); if (rb) { openRename(rb.dataset.ren, rb.dataset.orig); return; }
  const row = e.target.closest('.w[data-c]'); if (row && !arrange) { openDetail(row.dataset.c); return; }
  const b = e.target.closest('button[data-mv]'); if (!b) return;
  const k = b.dataset.mv, sib = b.dataset.sib.split('~~'), i = sib.indexOf(k), j = i + parseInt(b.dataset.d);
  if (i < 0 || j < 0 || j >= sib.length) return;[sib[i], sib[j]] = [sib[j], sib[i]]; order = order.filter(x => !sib.includes(x)).concat(sib); await saveOrder();
};
['wlTitle', 'wlIntro', 'wlFoot', 'wlDesc', 'wlByType', 'wlStock', 'wlPrice', 'wlGC', 'wlSort'].forEach(i => $(i).addEventListener('input', renderWl));
$('wlPrint').onclick = () => { $('sheet').innerHTML = '<div class="wl" style="grid-column:1/-1">' + wlHtml() + '</div>'; window.print(); };
function imgData(path) { return new Promise(res => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => { const k = Math.min(1, 700 / Math.max(i.width, i.height)), c = document.createElement('canvas'); c.width = Math.round(i.width * k); c.height = Math.round(i.height * k); try { c.getContext('2d').drawImage(i, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', 0.78)); } catch (e) { res(''); } }; i.onerror = () => res(''); i.src = api.photoUrl(path); }); }
async function wlDlHtml() {
  $('wlMsg').textContent = 'Preparing the interactive list…';
  const prices = $('wlPrice').checked, det = {};
  for (const { w, code } of wlFlat()) det[code] = { n: (w.listName || (w.name + ' ' + (w.vintage || ''))).trim(), x: w.desc || '', i: [w.type, w.country, w.region, w.sub, w.cls].filter(Boolean).join(' · '), p: prices && w.sell > 0 ? eur(w.sell) : '', img: w.photo ? await imgData(w.photo) : '' };
  const css = 'body{max-width:760px;margin:20px auto;padding:0 16px;font-family:Georgia,serif;color:#000}.w[data-c]{cursor:pointer}.w[data-c]:hover{background:#f3e9ee}#m{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;padding:16px}#m.on{display:flex}#mb{background:#fff;color:#000;border-radius:14px;max-width:460px;width:100%;max-height:90vh;overflow:auto;padding:16px;position:relative}#mb img{width:100%;max-height:55vh;object-fit:contain;border-radius:8px;margin-bottom:10px}#mb h3{margin:0 30px 4px 0;font-size:20px;opacity:1}#mx{position:absolute;top:8px;right:10px;border:0;background:none;font-size:22px;cursor:pointer}';
  const js = "const D=" + JSON.stringify(det).replace(/</g, '\\u003c') + ";const m=document.getElementById('m'),mb=document.getElementById('mb');document.addEventListener('click',e=>{if(e.target===m||e.target.id==='mx'){m.classList.remove('on');return}const r=e.target.closest('.w[data-c]');if(!r)return;const d=D[r.dataset.c];if(!d)return;mb.innerHTML='<button id=\"mx\">✕</button>';if(d.img){const i=document.createElement('img');i.src=d.img;mb.appendChild(i)}const h=document.createElement('h3');h.textContent=d.n;mb.appendChild(h);const p=document.createElement('div');p.textContent=d.i;p.style.opacity='.7';mb.appendChild(p);if(d.x){const t=document.createElement('p');t.textContent=d.x;t.style.cssText='font-style:italic;margin:10px 0 0';mb.appendChild(t)}if(d.p){const q=document.createElement('div');q.textContent=d.p;q.style.cssText='font:bold 22px sans-serif;margin-top:10px';mb.appendChild(q)}m.classList.add('on')});";
  const doc = '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc($('wlTitle').value) + '</title><style>' + LCSS + css + '</style><div id="sheet" style="display:block"><div class="wl">' + wlHtml(false) + '</div></div><div id="m"><div id="mb"></div></div><script>' + js + '<\/script>';
  download('wine-list.html', doc, 'text/html'); $('wlMsg').textContent = 'Saved. Open the file in any browser; tap a wine to see its photo.';
}
function csvOf(src) {
  const q = v => { v = String(v == null ? '' : v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const n = x => x > 0 ? String(x).replace('.', ',') : '';
  const rows = [['Barcode', 'Name', 'Vintage', 'Type', 'Country', 'Region', 'Sub-region', 'Classification', 'Cost price', 'Menu price', 'Shop price', 'Bottles', 'Place']];
  src.forEach(({ w, code }) => rows.push([code, w.name, w.vintage || '', w.type || '', w.country || '', w.region || '', w.sub || '', w.cls || '', n(w.price), n(w.sell), n(w.shopPrice), w.bottles || 0, plNames(w).join(', ')]));
  return '﻿' + rows.map(r => r.map(q).join(';')).join('\r\n');
}
function wlPdf() {
  const J = window.jspdf && window.jspdf.jsPDF; if (!J) throw new Error('PDF library did not load');
  const doc = new J({ unit: 'mm', format: 'a4' }), W = 210, M = 18, prices = $('wlPrice').checked; let y = 22, lt = null, lc = null, lr = '', ls = '', first = true;
  const np = h => { if (y + h > 285) { doc.addPage(); y = 22; } };
  doc.setFont('times', 'bold'); doc.setFontSize(22); doc.text($('wlTitle').value || 'Wine List', W / 2, y, { align: 'center' }); y += 12;
  const intro = $('wlIntro').value.trim(), foot = $('wlFoot').value.trim(), showDesc = $('wlDesc').checked;
  if (intro) { doc.setFont('times', 'italic'); doc.setFontSize(10.5); const il = doc.splitTextToSize(intro, W - 2 * M); doc.text(il, W / 2, y, { align: 'center' }); y += 5 * il.length + 3; }
  for (const { t, c, r, s, w } of wlFlat()) {
    if (t !== lt) {
      if (t !== '-') {
        if (!first) { doc.addPage(); y = 22; }
        doc.setFont('times', 'bold'); doc.setFontSize(20); doc.text(lab('T:' + t, t).toUpperCase(), W / 2, y + 4, { align: 'center' });
        doc.setDrawColor(123, 30, 58); doc.setLineWidth(0.6); doc.line(M, y + 7, W - M, y + 7); doc.setLineWidth(0.2); y += 14;
      }
      lt = t; lc = null; lr = ''; ls = ''; first = false;
    }
    if (c !== lc) { np(20); y += 4; doc.setFont('times', 'bold'); doc.setFontSize(16); doc.text(lab('C:' + c, c), M, y); doc.setDrawColor(150); doc.line(M, y + 1.5, W - M, y + 1.5); y += 8; lc = c; lr = ''; ls = ''; }
    if (r && r !== lr) { np(14); doc.setFont('times', 'bold'); doc.setFontSize(12); doc.text(lab('R:' + c + '|' + r, r), M, y); y += 6; lr = r; ls = ''; }
    if (s && s !== ls) { np(11); doc.setFont('times', 'italic'); doc.setFontSize(10.5); doc.text(lab('S:' + c + '|' + r + '|' + s, s), M + 2, y); y += 5; ls = s; }
    doc.setFont('times', 'normal'); doc.setFontSize(10);
    const lines = doc.splitTextToSize(w.listName || `${w.name} ${w.vintage || ''}${w.cls ? ' · ' + w.cls : ''}`, W - 2 * M - 36);
    np(5.5 * lines.length); doc.text(lines, M + 4, y);
    if (prices && w.sell > 0) doc.text('€ ' + w.sell.toFixed(2).replace('.', ','), W - M, y, { align: 'right' });
    y += 5.5 * lines.length;
    if (showDesc && w.desc) { doc.setFont('times', 'italic'); doc.setFontSize(8.5); const dl = doc.splitTextToSize(w.desc, W - 2 * M - 36); np(4 * dl.length); doc.text(dl, M + 4, y - 1); y += 4 * dl.length; }
  }
  if (foot) { np(14); y += 6; doc.setFont('times', 'italic'); doc.setFontSize(10); const fl = doc.splitTextToSize(foot, W - 2 * M); doc.text(fl, W / 2, y, { align: 'center' }); }
  return doc.output('blob');
}
$('wlDl').onclick = async () => {
  const f = $('wlFmt').value;
  try {
    if (f === 'html') return await wlDlHtml();
    if (f === 'csv') download('wine-list.csv', csvOf(wlFlat()), 'text/csv;charset=utf-8');
    else download('wine-list.pdf', wlPdf());
    $('wlMsg').textContent = 'Saved as ' + f.toUpperCase() + '.';
  } catch (e) { $('wlMsg').textContent = 'Could not download: ' + e.message; }
};
$('expBtn').onclick = () => download('wine-inventory.csv', csvOf(Object.entries(wines).sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([code, w]) => ({ w, code }))), 'text/csv;charset=utf-8');

/* ---------- guest view & detail ---------- */
function openDetail(code) {
  const w = wines[code]; if (!w) return;
  const bits = [w.type, w.country, w.region, w.sub, w.cls].filter(Boolean).map(esc).join(' · ');
  $('wDetail').innerHTML = `<div class="box"><button class="btn ghost" id="wdClose" style="position:absolute;top:8px;right:8px">✕</button>${w.photo ? `<img src="${esc(api.photoUrl(w.photo))}" alt="">` : ''}<div class="nm" style="font-size:20px;margin-right:44px">${esc(w.listName || (w.name + ' ' + w.vintage))}</div><div class="meta" style="margin:4px 0 10px">${bits}</div>${w.desc ? `<p style="font-style:italic;margin:0 0 10px">${esc(w.desc)}</p>` : ''}${$('wlPrice').checked && w.sell > 0 ? `<div style="font:700 22px system-ui,sans-serif">${eur(w.sell)}</div>` : ''}</div>`;
  $('wDetail').classList.add('on'); $('wdClose').onclick = () => $('wDetail').classList.remove('on');
}
$('wDetail').onclick = e => { if (e.target === $('wDetail')) $('wDetail').classList.remove('on'); };
$('guestBtn').onclick = () => { arrange = false; $('wlArr').textContent = '↕ Arrange order'; document.body.classList.add('guest'); renderWl(); };
$('guestExit').onclick = () => document.body.classList.remove('guest');

/* ---------- editable list text ---------- */
const lab = (k, n) => (ltext.labels && ltext.labels[k]) || n;
function applyLtext() {
  if (document.activeElement !== $('wlTitle')) $('wlTitle').value = ltext.title || 'Wine List';
  if (document.activeElement !== $('wlIntro')) $('wlIntro').value = ltext.intro || '';
  if (document.activeElement !== $('wlFoot')) $('wlFoot').value = ltext.foot || '';
}
async function saveLtext() { if (!isMgr) return; try { await saveSettings({ ltext }); } catch (e) { $('wlMsg').textContent = 'Could not save the list text: ' + e.message; } }
let ltT = null;
['wlTitle', 'wlIntro', 'wlFoot'].forEach(i => $(i).addEventListener('input', () => { ltext.title = $('wlTitle').value; ltext.intro = $('wlIntro').value; ltext.foot = $('wlFoot').value; clearTimeout(ltT); ltT = setTimeout(saveLtext, 700); }));
function openRename(key, orig) {
  $('wDetail').innerHTML = `<div class="box"><div class="nm" style="margin-bottom:8px">Heading text</div><input id="rnIn" value="${esc(lab(key, orig))}"><div class="meta" style="margin:6px 0 10px">Original: ${esc(orig)}</div><div class="row"><button class="btn" id="rnSave" style="flex:1">Save</button><button class="btn ghost" id="rnReset">Reset</button><button class="btn ghost" id="rnCancel">Cancel</button></div></div>`;
  $('wDetail').classList.add('on'); $('rnIn').focus();
  const done = () => $('wDetail').classList.remove('on');
  $('rnSave').onclick = async () => { const v = $('rnIn').value.trim(); ltext.labels = ltext.labels || {}; if (v && v !== orig) ltext.labels[key] = v; else delete ltext.labels[key]; done(); renderWl(); await saveLtext(); };
  $('rnReset').onclick = async () => { ltext.labels = ltext.labels || {}; delete ltext.labels[key]; done(); renderWl(); await saveLtext(); };
  $('rnCancel').onclick = done;
}

/* ---------- import (Excel / CSV / JSON backup) ---------- */
const ALIAS = { code: ['barcode', 'ean', 'code', 'sku', 'gtin', 'artikelnummer'], name: ['name', 'wine', 'wijn', 'naam', 'wijnnaam', 'description', 'omschrijving'], type: ['type', 'soort', 'kleur', 'color', 'colour', 'winetype', 'wijnsoort', 'wijntype', 'style'], vintage: ['vintage', 'year', 'jaar', 'jaargang', 'millesime'], country: ['country', 'land'], region: ['region', 'regio'], sub: ['subregion', 'subregio', 'appellation', 'sub'], cls: ['classification', 'class', 'cru', 'classificatie', 'level'], price: ['costprice', 'cost', 'price', 'purchaseprice', 'inkoopprijs', 'inkoop'], sell: ['menuprice', 'sellprice', 'sellingprice', 'verkoopprijs', 'verkoop', 'listprice'], shopPrice: ['shopprice', 'webshopprice', 'winkelprijs', 'webshopprijs'], bottles: ['bottles', 'quantity', 'qty', 'stock', 'aantal', 'voorraad', 'flessen'], place: ['place', 'location', 'plaats', 'locatie', 'position', 'rack', 'shelf'] };
let impRows = [], impMap = {}, impJson = null;
function mapCols(rows) { const hdr = Object.keys(rows[0] || {}), m = {}; for (const [f, al] of Object.entries(ALIAS)) { const h = hdr.find(x => al.includes(x.toLowerCase().replace(/[^a-z0-9]/g, ''))); if (h !== undefined) m[f] = h; } return m; }
$('impBtn').onclick = () => $('impCard').classList.toggle('on');
$('impClose').onclick = () => $('impCard').classList.remove('on');
$('impFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; $('impGo').disabled = true; impJson = null; impRows = [];
  try {
    if (/\.json$/i.test(f.name)) {
      const d = JSON.parse(await f.text()), list = Array.isArray(d) ? d : (d.wines || []);
      impJson = list.filter(x => x && x.code && x.name);
      if (!impJson.length) throw new Error('no wines found in this backup');
      $('impInfo').textContent = `Cellar Book backup with ${impJson.length} wines. Wines with the same barcode are replaced; stock is set to the numbers in the backup.`;
    } else {
      if (typeof XLSX === 'undefined') throw new Error('spreadsheet library did not load');
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      impRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }); impMap = mapCols(impRows);
      if (!impRows.length) throw new Error('the file has no data rows');
      if (impMap.name === undefined) throw new Error('no Name column found (use a header like Name, Wine or Wijn)');
      $('impInfo').textContent = `${impRows.length} rows found. Columns recognised: ` + Object.entries(impMap).map(([k, h]) => `${k} ← "${h}"`).join(', ') + '. Existing wines with the same barcode are updated.';
    }
    $('impGo').disabled = false;
  } catch (err) { $('impInfo').textContent = 'Could not read file: ' + err.message; }
};
$('impGo').onclick = async () => {
  if (!isMgr) return; $('impGo').disabled = true;
  const batch = new Map(), adj = [];
  const put = (code, w) => { const before = wines[code] ? wines[code].bottles : 0; batch.set(code, cleanWine(w)); const d = (w.bottles || 0) - before; adj.push({ code, name: w.name, delta: d }); };
  let skip = 0;
  if (impJson) {
    for (const x of impJson) { const code = String(x.code).replace(/[^\w-]/g, '').slice(0, 64); if (!code) { skip++; continue; } put(code, { ...x, photo: '' }); }
  } else {
    const m = impMap;
    for (let i = 0; i < impRows.length; i++) {
      const r = impRows[i], v = k => m[k] === undefined ? undefined : String(r[m[k]]).trim();
      const name = v('name'); if (!name) { skip++; continue; }
      let code = (v('code') || '').replace(/[^\w-]/g, ''); const had = !!code;
      if (!code) code = 'CB' + Date.now().toString(36).toUpperCase().slice(-5) + String(i).padStart(3, '0');
      const given = code, fc = findCode(code);
      if (wines[fc] || batch.has(fc)) code = fc; else { const ex = findByKey(name, v('vintage') ?? ''); if (ex) code = ex; }
      const old = batch.get(code) || wines[code], w = { bottles: 0, ...(old ? JSON.parse(JSON.stringify(old)) : {}) }; w.name = name;
      if (had && given !== code) w.aliases = [...new Set([...(w.aliases || []), given])];
      ['vintage', 'country', 'region', 'sub', 'cls'].forEach(k => { const x = v(k); if (x !== undefined) w[k] = x; });
      { const tv = v('type'); if (tv !== undefined) w.type = typeVal(tv); }
      ['price', 'sell', 'shopPrice'].forEach(k => { const x = v(k); if (x !== undefined) w[k] = num(x); });
      if (v('sell') && num(v('sell')) > 0) w.sellManual = true;
      else if (w.price > 0 && !w.sellManual) { w.sell = calcSell(w.price); w.sellManual = false; }
      const q = v('bottles'); if (q !== undefined && q !== '') w.bottles = Math.max(0, parseInt(q) || 0);
      const pl = (v('place') || '').split(/[,;]/).map(x => x.trim().toUpperCase()).filter(Boolean); if (pl.length) w.loc = pl.join(', ');
      put(code, w);
    }
  }
  const list = [...batch.entries()];
  try {
    $('impInfo').textContent = `Importing ${list.length} wines…`;
    await api.saveWines(C, list, true);
    const seen = new Set(), rows = adj.reverse().filter(a => !seen.has(a.code) && seen.add(a.code)).filter(a => a.delta);
    for (let i = 0; i < rows.length; i += 300) await api.logAdjustments(C, rows.slice(i, i + 300));
    await reloadAll();
    $('impInfo').textContent = `Done: ${list.length} wines imported or updated` + (skip ? `, ${skip} rows skipped (no name)` : '') + '. Wines without a barcode got an internal code: print their labels in the Labels tab.';
  } catch (e) { $('impInfo').textContent = 'Import stopped: ' + e.message + '. Nothing is lost: run the import again.'; }
  $('impFile').value = ''; impRows = []; impJson = null;
};
$('impTpl').onclick = () => download('wine-import-template.csv', 'Barcode,Name,Vintage,Type,Country,Region,Sub-region,Classification,Cost price,Menu price,Shop price,Bottles,Place\n8712345678901,Gevrey-Chambertin Les Cazetiers,2018,Rood,France,Bourgogne,Gevrey-Chambertin,Premier Cru,65,140,,6,A12\n', 'text/csv');
$('bkBtn').onclick = () => {
  const data = { app: 'cellar-book', version: 1, exported: new Date().toISOString(), cellar: cellar.name, wines: Object.entries(wines).map(([code, w]) => ({ code, ...w, places: undefined })) };
  download(`cellar-book-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 1), 'application/json');
  $('acctMsg').textContent = 'Backup saved. Keep it somewhere safe; you can import it via Inventory → Import.';
};

/* ---------- pricing ---------- */
function calcSell(cost) { const f = parseFloat(pricing.factor) || 3, st = parseFloat(pricing.round) || 0; let p = cost * f; if (st > 0) p = Math.ceil(p / st - 1e-9) * st; return Math.round(p * 100) / 100; }
$('ePrice').oninput = () => { if (!eManual) { const c = num($('ePrice').value); $('eSell').value = c > 0 ? calcSell(c) : ''; } };
$('eSell').oninput = () => { eManual = $('eSell').value.trim() !== ''; };
$('eAuto').onclick = () => { eManual = false; const c = num($('ePrice').value); $('eSell').value = c > 0 ? calcSell(c) : ''; };
$('prBtn').onclick = () => { $('prF').value = pricing.factor; $('prR').value = String(pricing.round); $('prCard').classList.toggle('on'); };
$('prClose').onclick = () => $('prCard').classList.remove('on');
async function savePricing() { pricing = { factor: num($('prF').value) || 3, round: parseFloat($('prR').value) || 0 }; await saveSettings({ pricing }); }
$('prSave').onclick = async () => { try { await savePricing(); $('prMsg').textContent = 'Rule saved. It is used whenever you enter a cost price.'; } catch (e) { $('prMsg').textContent = 'Could not save: ' + e.message; } };
$('prAll').onclick = async () => {
  try {
    await savePricing();
    const list = Object.entries(wines).filter(([, w]) => !w.sellManual && w.price > 0).map(([c, w]) => [c, { ...w, sell: calcSell(w.price), sellManual: false }]);
    await api.saveWines(C, list, false); list.forEach(([c, w]) => wines[c] = w); render();
    $('prMsg').textContent = `Recalculated ${list.length} wines. Prices you set by hand were left alone.`;
  } catch (e) { $('prMsg').textContent = 'Could not recalculate: ' + e.message; }
};

/* ---------- webshop settings ---------- */
let shopCfg = {};
function calcShop(c) { const f = parseFloat(shopCfg.factor) || 1.8, st = shopCfg.round === undefined ? 1 : (parseFloat(shopCfg.round) || 0); let p = c * f; if (st > 0) p = Math.ceil(p / st - 1e-9) * st; return Math.round(p * 100) / 100; }
function shopPriceOf(w) { return w.shopPrice > 0 ? w.shopPrice : (w.price > 0 ? calcShop(w.price) : 0); }
function fillShopCfg() {
  shopCfg = { factor: 1.8, round: 1, ...(cellar.shop || {}) };
  const s = shopCfg; $('shOn').checked = !!s.enabled; $('shName').value = s.name || ''; $('shIntro').value = s.intro || ''; $('shEmail').value = s.email || ''; $('shPhone').value = s.phone || ''; $('shNote').value = s.note || ''; $('shF').value = s.factor; $('shR').value = String(s.round); $('shQty').checked = !!s.showQty;
  const link = location.origin + location.pathname.replace(/[^/]*$/, '') + 'shop.html?k=' + cellar.slug;
  $('shLink').value = link; $('shOpen').href = link;
}
function renderShopStatus() {
  const n = Object.values(wines).filter(w => w.bottles > 0 && !w.noShop && w.name).length, np = Object.values(wines).filter(w => w.bottles > 0 && !w.noShop && !shopPriceOf(w)).length;
  $('shStatus').textContent = (shopCfg.enabled ? '🟢 Open' : '⚪ Closed — customers see nothing until you switch it on') + ` · ${n} wines in the shop` + (np ? ` · ${np} without price (“prijs op aanvraag”)` : '');
}
$('shSave').onclick = async () => {
  const shop = { enabled: $('shOn').checked, name: $('shName').value.trim(), intro: $('shIntro').value.trim(), email: $('shEmail').value.trim(), phone: $('shPhone').value.trim(), note: $('shNote').value.trim(), factor: num($('shF').value) || 1.8, round: parseFloat($('shR').value) || 0, showQty: $('shQty').checked };
  $('shMsg').textContent = 'Saving…';
  try { await api.updateCellar(C, { shop }); cellar.shop = shop; fillShopCfg(); renderShopStatus(); render(); $('shMsg').textContent = 'Saved. The shop shows the changes right away.'; }
  catch (e) { $('shMsg').textContent = 'Could not save: ' + e.message; }
};
$('shCopy').onclick = async () => { try { await navigator.clipboard.writeText($('shLink').value); $('shCopy').textContent = 'Copied'; setTimeout(() => $('shCopy').textContent = 'Copy', 1500); } catch (e) { $('shLink').select(); } };
$('cNameSave').onclick = async () => { const n = $('cNameIn').value.trim(); if (!n) return; try { await api.updateCellar(C, { name: n }); cellar.name = n; $('cName').textContent = n; $('acctMsg').textContent = 'Name saved.'; } catch (e) { $('acctMsg').textContent = e.message; } };
$('signOut').onclick = async () => { await api.signOut(); location.replace('index.html'); };

/* ---------- team ---------- */
async function renderTeam() {
  renderShopStatus();
  if (!isMgr) return;
  try {
    const [ms, inv] = await Promise.all([api.members(C), api.invites(C)]);
    ms.forEach(m => nameOf[m.user_id] = m.email);
    $('team').innerHTML = ms.map(m => `<div class="item"><div><div class="nm" style="font-size:15px">${esc(m.email || 'member')}${m.user_id === myId ? ' (you)' : ''}</div></div>${m.role === 'owner' ? '<span class="meta">Owner</span>' : `<div class="ctl"><select data-role="${esc(m.user_id)}" style="width:auto;padding:6px"><option value="employee"${m.role === 'employee' ? ' selected' : ''}>Employee</option><option value="manager"${m.role === 'manager' ? ' selected' : ''}>Manager</option></select>${m.user_id === myId ? '' : `<button class="sm" data-rm="${esc(m.user_id)}" title="Remove">✕</button>`}</div>`}</div>`).join('')
      + inv.map(i => `<div class="item"><div><div class="nm" style="font-size:15px">${esc(i.email)}</div><div class="meta">Invited as ${esc(i.role)} — waiting for them to create an account</div></div><button class="sm" data-ci="${esc(i.email)}" title="Cancel">✕</button></div>`).join('');
  } catch (e) { $('team').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
$('team').onchange = async e => { const s = e.target.closest('select[data-role]'); if (!s) return; try { await api.setRole(C, s.dataset.role, s.value); $('invMsg').textContent = 'Role changed.'; } catch (x) { $('invMsg').textContent = x.message; } renderTeam(); };
$('team').onclick = async e => {
  const rm = e.target.closest('[data-rm]'), ci = e.target.closest('[data-ci]');
  try {
    if (rm) { if (rm.dataset.arm !== '1') { rm.dataset.arm = '1'; rm.textContent = '?'; return; } await api.removeMember(C, rm.dataset.rm); }
    if (ci) await api.cancelInvite(C, ci.dataset.ci);
  } catch (x) { $('invMsg').textContent = x.message; }
  if (rm || ci) renderTeam();
};
$('invGo').onclick = async () => {
  const em = $('invEmail').value.trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { $('invMsg').textContent = 'Enter a valid e-mail address.'; return; }
  try { await api.invite(C, em, $('invRole').value); $('invEmail').value = ''; $('invMsg').textContent = `Invited ${em}. Send them this link to create an account: ${location.origin + location.pathname.replace(/[^/]*$/, '')}`; renderTeam(); }
  catch (e) { $('invMsg').textContent = e.message; }
};

/* ---------- orders ---------- */
const OST = { new: 'New', confirmed: 'Confirmed', ready: 'Ready', done: 'Done', cancelled: 'Cancelled' };
let ordFilter = 'open';
function renderOrders() {
  const open = orders.filter(o => ['new', 'confirmed', 'ready'].includes(o.status)), nw = orders.filter(o => o.status === 'new').length;
  $('ordBadge').textContent = nw; $('ordBadge').classList.toggle('hide', !nw);
  $('ordFilter').innerHTML = [['open', `Open (${open.length})`], ['all', 'All']].map(([k, l]) => `<button data-f="${k}" class="${ordFilter === k ? 'on' : ''}">${l}</button>`).join('');
  const list = ordFilter === 'open' ? open : orders;
  $('ordList').innerHTML = list.length ? list.map(o => {
    const c = o.customer || {}, next = { new: ['confirmed', 'Confirm'], confirmed: ['ready', 'Ready for pick-up'], ready: ['done', 'Done'] }[o.status];
    return `<div class="ord"><div class="hd"><b>#${o.id} · ${esc(c.name)}</b><span class="st ${o.status}">${OST[o.status]}</span></div>
      <div class="meta">${new Date(o.created_at).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' })} · ${esc(c.how || '')}${c.email ? ` · <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}${c.phone ? ` · <a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''}</div>
      ${c.note ? `<div class="meta" style="margin-top:4px;white-space:pre-line">“${esc(c.note)}”</div>` : ''}
      <div style="margin-top:8px">${(o.items || []).map(i => { const w = wines[i.code]; return `<div class="ln"><span>${i.qty} × ${esc(i.name)} ${esc(i.vintage || '')}${w ? ` <span class="meta">📍 ${esc(placesStr(w))}</span>` : ''}</span><span>${i.price > 0 ? eur(i.price * i.qty) : 'on request'}</span></div>`; }).join('')}
      <div class="ln" style="font-weight:bold;border-top:1px solid var(--line);margin-top:4px;padding-top:4px"><span>Total</span><span>${eur(o.total)}</span></div></div>
      ${o.status === 'cancelled' || o.status === 'done' ? '' : `<div class="acts">${next ? `<button class="btn" data-os="${next[0]}" data-o="${o.id}">${next[1]}</button>` : ''}<button class="btn ghost" data-os="cancelled" data-o="${o.id}" style="color:var(--bad)">Cancel (bottles back in stock)</button></div>`}</div>`;
  }).join('') : `<div class="meta">${ordFilter === 'open' ? 'No open orders.' : 'No orders yet.'} Orders from your webshop appear here instantly.</div>`;
}
$('ordFilter').onclick = e => { const b = e.target.closest('[data-f]'); if (b) { ordFilter = b.dataset.f; renderOrders(); } };
$('ordList').onclick = async e => {
  const b = e.target.closest('button[data-os]'); if (!b) return;
  if (b.dataset.os === 'cancelled' && b.dataset.arm !== '1') { b.dataset.arm = '1'; b.textContent = 'Tap again to cancel the order'; return; }
  b.disabled = true;
  try { await api.setOrderStatus(+b.dataset.o, b.dataset.os); const o = orders.find(x => x.id === +b.dataset.o); if (o) o.status = b.dataset.os; renderOrders(); if (b.dataset.os === 'cancelled') { const ws = await api.loadWines(C); ws.forEach(r => wines[r.code] = cleanWine(api.fromRow(r))); render(); } }
  catch (x) { toast('✗ ' + x.message, 'bad'); b.disabled = false; }
};
function toastOrder(o) { toast(`🛒 New order #${o.id} from ${(o.customer || {}).name || 'a customer'} — see Orders`, 'ok'); }

/* ---------- duplicates ---------- */
function findCode(c) { if (wines[c]) return c; const u = String(c).toUpperCase(); for (const [k, w] of Object.entries(wines)) if (k.toUpperCase() === u || (w.aliases || []).some(a => String(a).toUpperCase() === u)) return k; return c; }
const STOP = new Set('chateau domaine domain dom cuvee de du des la le les l d the et and of vin vino wine wines estate weingut tenuta bodega bodegas cave maison cantina azienda agricola'.split(' '));
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
const toks = n => norm(n).split(/\s+/).filter(t => t && !STOP.has(t)).map(t => t === '1er' || t === '1ere' ? 'premier' : t);
const vk = v => norm(v).replace(/\s+/g, '');
function lev(a, b) { const m = a.length, n = b.length; if (!m) return n; if (!n) return m; let p = Array.from({ length: n + 1 }, (_, j) => j); for (let i = 1; i <= m; i++) { const c = [i]; for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; } return p[n]; }
function similar(a, b) {
  if (vk(a.vintage) !== vk(b.vintage)) return false;
  if (a.cls && b.cls && norm(a.cls).trim() !== norm(b.cls).trim()) return false;
  const ta = toks(a.name), tb = toks(b.name); if (!ta.length || !tb.length) return false;
  if (ta.slice().sort().join(' ') === tb.slice().sort().join(' ')) return true;
  const A = new Set(ta), B = new Set(tb); let inter = 0; A.forEach(t => { if (B.has(t)) inter++; });
  if (Math.min(A.size, B.size) >= 2 && inter / (A.size + B.size - inter) >= 0.75) return true;
  const ja = ta.join(''), jb = tb.join(''), L = Math.max(ja.length, jb.length);
  return L >= 6 && 1 - lev(ja, jb) / L >= 0.88;
}
function findByKey(name, vint) { const probe = { name, vintage: vint }; return Object.keys(wines).find(c => similar(wines[c], probe)) || null; }
function dupGroups() {
  const codes = Object.keys(wines), par = {}; codes.forEach(c => par[c] = c);
  const f = c => { while (par[c] !== c) { par[c] = par[par[c]]; c = par[c]; } return c; };
  const idx = {};
  codes.forEach(c => { const w = wines[c], v = vk(w.vintage), t = toks(w.name); if (!t.length) return; const keys = new Set(t.map(x => v + '|t|' + x)); keys.add(v + '|p|' + t.join('').slice(0, 3)); keys.forEach(k => (idx[k] = idx[k] || []).push(c)); });
  const seen = new Set();
  Object.values(idx).forEach(g => { if (g.length < 2 || g.length > 80) return; for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) { const a = g[i], b = g[j], k = a < b ? a + '~' + b : b + '~' + a; if (seen.has(k) || f(a) === f(b)) continue; seen.add(k); if (similar(wines[a], wines[b])) par[f(a)] = f(b); } });
  const m = {}; codes.forEach(c => { const r = f(c); (m[r] = m[r] || []).push(c); });
  return Object.values(m).filter(a => a.length > 1);
}
let dupT = null, merging = false, mergeMsg = '';
function schedDup() { clearTimeout(dupT); dupT = setTimeout(() => { try { updateDup(); } catch (e) { console.error(e); } }, 400); }
function updateDup() {
  if (merging) return; const n = dupGroups().length;
  $('dupBar').style.display = ''; $('dupBar').style.color = n ? 'var(--warn)' : 'var(--ink)';
  $('dupBar').textContent = n ? `⚠ Find doubles — ${n} possible duplicate${n > 1 ? 's' : ''} found` : '🔍 Find doubles';
  if ($('dupCard').classList.contains('on')) renderDup();
}
function renderDup() {
  const gs = dupGroups();
  $('dupCard').innerHTML = (mergeMsg ? `<div class="toast bad" style="display:block">${esc(mergeMsg)}</div>` : '') + (gs.length ? `<div class="meta" style="margin-bottom:8px">Same or very similar name with the same vintage (spelling differences and words like Château or Domaine are ignored). Check the names before merging. Merging adds the bottle counts and places together, and every barcode keeps working.</div><button class="btn" data-mall="1" style="width:100%;margin-bottom:6px">Merge all (${gs.length})</button>` + gs.map(g => `<div class="item"><div><div class="nm">${esc(wines[g[0]].name)} ${esc(wines[g[0]].vintage)}</div><div class="meta">${g.map(c => esc(wines[c].name) + ' · ' + esc(c) + ' (' + (wines[c].bottles || 0) + ')').join('<br>')}</div></div><button class="btn" data-m="${esc(g.join('~~'))}">Merge</button></div>`).join('') : '<div class="meta">No duplicates found.</div>');
}
async function runMerge(groups) {
  if (merging) return; merging = true; mergeMsg = ''; let done = 0;
  try {
    for (const g of groups) {
      $('dupBar').textContent = `Merging… ${done}/${groups.length}`;
      const isBar = c => /^\d{6,}$/.test(c) ? 1 : 0;
      const pk = [...g].sort((a, b) => (isBar(b) - isBar(a)) || ((wines[b].bottles || 0) - (wines[a].bottles || 0)))[0];
      await api.mergeWines(C, pk, g.filter(c => c !== pk)); done++;
    }
  } catch (e) { mergeMsg = 'Merge stopped after ' + done + ' of ' + groups.length + ': ' + e.message; }
  merging = false; await reloadAll(); renderDup();
}
$('dupBar').onclick = () => { $('dupCard').classList.toggle('on'); renderDup(); };
$('dupCard').onclick = async e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.m) await runMerge([b.dataset.m.split('~~')]); else if (b.dataset.mall) await runMerge(dupGroups()); };

/* ---------- select several wines ---------- */
let selMode = false; const selSet = new Set();
function selUpdate() { const b = $('selDel'); b.textContent = `Delete (${selSet.size})`; b.disabled = !selSet.size; b.dataset.arm = ''; }
$('selBtn').onclick = () => { fillTypes(); selMode = !selMode; selSet.clear(); $('selBtn').textContent = selMode ? '✕ Cancel selecting' : '☑ Select'; ['selAll', 'selDel', 'selType'].forEach(i => $(i).classList.toggle('hide', !selMode)); selUpdate(); render(); };
$('selAll').onclick = () => { const q = $('q').value.toLowerCase(); Object.entries(wines).filter(([c, w]) => (w.name + ' ' + w.vintage + ' ' + w.loc + ' ' + c).toLowerCase().includes(q)).forEach(([c]) => selSet.add(c)); selUpdate(); render(); };
$('list').addEventListener('change', e => { const t = e.target; if (t.classList && t.classList.contains('sc')) { if (t.checked) selSet.add(t.dataset.c); else selSet.delete(t.dataset.c); selUpdate(); } });
$('selDel').onclick = async () => {
  const b = $('selDel'); if (!selSet.size) return;
  if (b.dataset.arm !== '1') { b.dataset.arm = '1'; b.textContent = `Tap again to delete ${selSet.size} wine${selSet.size > 1 ? 's' : ''}`; setTimeout(() => { if (b.dataset.arm === '1') selUpdate(); }, 4000); return; }
  b.disabled = true; const codes = [...selSet];
  try { await api.deleteWines(C, codes); codes.forEach(c => { const ph = wines[c] && wines[c].photo; if (ph) api.deletePhoto(ph).catch(() => { }); delete wines[c]; }); selSet.clear(); }
  catch (e) { syncFail(e); }
  selUpdate(); render();
};
$('selType').onchange = async () => {
  const v = typeVal($('selType').value); if (!v || !selSet.size) return;
  try { await api.patchWines(C, [...selSet], { type: v }); [...selSet].forEach(c => { if (wines[c]) wines[c].type = v; }); syncOk(); } catch (e) { syncFail(e); }
  $('selType').value = ''; selSet.clear(); selUpdate(); render();
};

/* ---------- places ---------- */
function plRow(p) {
  const d = document.createElement('div'); d.className = 'row'; d.style.marginBottom = '6px';
  d.innerHTML = '<input class="pp" placeholder="Place (e.g. A12)" style="margin:0"><button class="sm" type="button">✕</button>';
  d.querySelector('.pp').value = p || ''; d.querySelector('button').onclick = () => d.remove(); return d;
}
function setPlRows(w) { const box = $('ePlRows'); box.innerHTML = ''; plNames(w).forEach(p => box.appendChild(plRow(p))); }
function readPl() { const a = []; document.querySelectorAll('#ePlRows .pp').forEach(i => { const p = i.value.trim().toUpperCase(); if (p && !a.includes(p)) a.push(p); }); return a; }
$('ePlAdd').onclick = () => { const r = plRow(''); $('ePlRows').appendChild(r); r.querySelector('.pp').focus(); };
function plNames(w) { const a = []; String(w.loc || '').split(',').forEach(x => { x = x.trim().toUpperCase(); if (x && !a.includes(x)) a.push(x); }); return a; }
function addPlace(w, p) { const l = plNames(w); if (!l.includes(p)) l.push(p); w.loc = l.join(', '); }
function cleanWine(w) {
  w.name = w.name == null ? '' : String(w.name); w.vintage = w.vintage == null ? '' : String(w.vintage);
  w.bottles = Number(w.bottles) || 0; w.price = Number(w.price) || 0; w.sell = Number(w.sell) || 0; w.shopPrice = Number(w.shopPrice) || 0; w.noShop = !!w.noShop; w.sellManual = !!w.sellManual;
  w.loc = w.loc == null ? '' : String(w.loc); w.type = typeVal(w.type); w.photo = typeof w.photo === 'string' ? w.photo : ''; w.listName = w.listName == null ? '' : String(w.listName); w.desc = w.desc == null ? '' : String(w.desc); w.cls = w.cls == null ? '' : String(w.cls);
  ['country', 'region', 'sub'].forEach(k => w[k] = w[k] == null ? '' : String(w[k]));
  if (!Array.isArray(w.aliases)) w.aliases = []; w.places = {};
  return w;
}

/* ---------- sortable inventory ---------- */
const SORTS = [['name', 'Name'], ['vintage', 'Year'], ['type', 'Type'], ['country', 'Country'], ['region', 'Region'], ['sub', 'Sub-region'], ['place', 'Place'], ['price', 'Cost', 1], ['sell', 'Menu price', 1], ['bottles', 'Bottles']];
let invSort = { k: 'name', dir: 1 };
function sortVal(w, k) {
  switch (k) {
    case 'name': return w.name || null; case 'vintage': return parseInt(w.vintage) || null;
    case 'type': return w.type ? (TYPES.indexOf(w.type) >= 0 ? TYPES.indexOf(w.type) : 50) : null;
    case 'country': return w.country || null; case 'region': return w.region || null; case 'sub': return w.sub || null;
    case 'place': return plNames(w)[0] || null; case 'price': return w.price > 0 ? w.price : null; case 'sell': return w.sell > 0 ? w.sell : null;
    case 'bottles': return w.bottles || 0;
  }
  return null;
}
function invCmp(A, B) {
  const a = A[1], b = B[1], va = sortVal(a, invSort.k), vb = sortVal(b, invSort.k), byName = (a.name || '').localeCompare(b.name || '');
  if (va === null && vb === null) return byName; if (va === null) return 1; if (vb === null) return -1;
  const d = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
  return (d * invSort.dir) || byName;
}
function drawSortBar() { $('sortBar').innerHTML = SORTS.map(([k, l, m]) => `<button data-k="${k}" class="${invSort.k === k ? 'on' : ''}${m ? ' mgr-only' : ''}">${l}${invSort.k === k ? (invSort.dir > 0 ? ' ▲' : ' ▼') : ''}</button>`).join(''); }
$('sortBar').onclick = e => { const b = e.target.closest('button[data-k]'); if (!b) return; if (invSort.k === b.dataset.k) invSort.dir *= -1; else invSort = { k: b.dataset.k, dir: 1 }; drawSortBar(); render(); };
drawSortBar();

start();
