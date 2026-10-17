import * as api from './db.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const eur = x => '€ ' + Number(x).toFixed(2).replace('.', ',');
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const TYPES = ['Mousserend', 'Wit', 'Rood', 'Rosé'];
const slug = (new URLSearchParams(location.search).get('k') || '').toLowerCase();
const CK = 'cb-cart-' + slug, FK = 'cb-customer';

let data = null, loaded = false;
const sv = { q: '', t: '', co: '', sort: 'name', shown: 48 };
let cart = {}, cf = {};
try { cart = JSON.parse(localStorage.getItem(CK) || '{}') || {}; } catch (e) { }
try { cf = JSON.parse(localStorage.getItem(FK) || '{}') || {}; } catch (e) { }
const saveCart = () => { try { localStorage.setItem(CK, JSON.stringify(cart)); } catch (e) { } };
const saveCf = () => { try { localStorage.setItem(FK, JSON.stringify(cf)); } catch (e) { } };

async function load() {
  if (!slug || !api.configured) { notFound(); return; }
  try { data = await api.getShop(slug); } catch (e) { if (!data) { $('svGrid').innerHTML = `<div class="meta" style="grid-column:1/-1;text-align:center;padding:30px">De shop kon niet geladen worden. Probeer het later opnieuw.</div>`; } return; }
  loaded = true;
  if (!data) { notFound(); return; }
  render();
}
function notFound() { $('svName').textContent = 'Shop niet gevonden'; $('svIntro').textContent = 'Deze webshop bestaat niet of is op dit moment gesloten.'; $('svGrid').innerHTML = ''; document.querySelector('.sh-bar').style.display = 'none'; }
const items = () => (data && data.items) || [];
const byCode = () => { const m = {}; items().forEach(i => m[i.c] = i); return m; };
const tyOf = i => i.t || 'Overig';
const photo = i => i.ph ? api.photoUrl(i.ph) : '';

function render() {
  const st = data.shop || {}, all = items();
  $('svName').textContent = st.name || 'Wijnshop'; $('svIntro').textContent = st.intro || ''; document.title = st.name || 'Wijnshop';
  const types = [...new Set(all.map(tyOf))].sort((a, b) => { const r = x => x === 'Overig' ? 99 : (TYPES.indexOf(x) >= 0 ? TYPES.indexOf(x) : 50); return r(a) - r(b) || a.localeCompare(b); });
  $('svTypes').innerHTML = types.length > 1 ? [['', 'Alle wijnen'], ...types.map(t => [t, t])].map(([k, l]) => `<button data-t="${esc(k)}" class="${sv.t === k ? 'on' : ''}">${esc(l)}</button>`).join('') : '';
  const cos = [...new Set(all.map(i => i.co).filter(Boolean))].sort();
  if ($('svCo').dataset.k !== cos.join('|')) { $('svCo').dataset.k = cos.join('|'); $('svCo').innerHTML = '<option value="">Alle landen</option>' + cos.map(c => `<option>${esc(c)}</option>`).join(''); $('svCo').value = sv.co; }
  $('svCo').style.display = cos.length > 1 ? '' : 'none';
  const q = norm(sv.q).trim();
  const list = all.filter(i => (!sv.t || tyOf(i) === sv.t) && (!sv.co || i.co === sv.co) && (!q || norm([i.n, i.v, i.co, i.r, i.s, i.cl, i.t].join(' ')).includes(q)));
  const pv = i => i.p > 0 ? +i.p : null, yv = i => parseInt(i.v) || null;
  const cmp = { name: (a, b) => a.n.localeCompare(b.n), pa: (a, b) => (pv(a) ?? 1e9) - (pv(b) ?? 1e9), pd: (a, b) => (pv(b) ?? -1) - (pv(a) ?? -1), va: (a, b) => (yv(a) ?? 1e5) - (yv(b) ?? 1e5), vd: (a, b) => (yv(b) ?? -1) - (yv(a) ?? -1) }[sv.sort];
  list.sort((a, b) => cmp(a, b) || a.n.localeCompare(b.n));
  $('svCount').textContent = all.length ? `${list.length} ${list.length === 1 ? 'wijn' : 'wijnen'}` : '';
  $('svGrid').innerHTML = list.length ? list.slice(0, sv.shown).map(i => {
    const inC = cart[i.c] || 0;
    return `<div class="wc" data-c="${esc(i.c)}"><div class="ty">${esc(tyOf(i))}${i.cl ? ' · ' + esc(i.cl) : ''}</div><div class="wn">${esc(i.n)} ${esc(i.v)}</div><div class="meta">${esc([i.co, i.r, i.s].filter(Boolean).join(' · '))}</div>${st.showQty ? `<div class="meta">${i.q <= 3 ? 'Nog maar ' + i.q + ' fles' + (i.q > 1 ? 'sen' : '') : i.q + ' flessen op voorraad'}</div>` : ''}<div class="ft"><span class="pr">${i.p > 0 ? eur(i.p) : '<span class="meta">Prijs op aanvraag</span>'}</span><button class="btn add${inC ? ' in' : ''}" data-add="${esc(i.c)}">${inC ? '✓ ' + inC + ' in mand' : '+ In mand'}</button></div></div>`;
  }).join('') : `<div class="meta" style="grid-column:1/-1;text-align:center;padding:30px">${all.length ? 'Geen wijnen gevonden.' : 'Er staan op dit moment geen wijnen in de shop.'}</div>`;
  $('svMore').classList.toggle('hide', list.length <= sv.shown);
  drawFab();
}
function cartLines() { const m = byCode(); return Object.entries(cart).filter(([c, n]) => n > 0 && m[c]).map(([c, n]) => ({ i: m[c], n: Math.min(n, m[c].q) })); }
function drawFab() { const L = cartLines(), n = L.reduce((a, l) => a + l.n, 0), t = L.reduce((a, l) => a + l.n * (l.i.p || 0), 0); $('cartFab').classList.toggle('on', n > 0); $('cartFab').textContent = `🛒 ${n} fles${n === 1 ? '' : 'sen'}${t > 0 ? ' · ' + eur(t) : ''}`; }
function add(c, d) { const i = byCode()[c]; if (!i) return; cart[c] = Math.max(0, Math.min(i.q, (cart[c] || 0) + d)); if (!cart[c]) delete cart[c]; saveCart(); render(); }
$('svQ').oninput = () => { sv.q = $('svQ').value; sv.shown = 48; render(); };
$('svCo').onchange = () => { sv.co = $('svCo').value; sv.shown = 48; render(); };
$('svSort').onchange = () => { sv.sort = $('svSort').value; render(); };
$('svTypes').onclick = e => { const b = e.target.closest('button[data-t]'); if (!b) return; sv.t = b.dataset.t; sv.shown = 48; render(); };
$('svMore').onclick = () => { sv.shown += 48; render(); };
$('svGrid').onclick = e => { const a = e.target.closest('button[data-add]'); if (a) { add(a.dataset.add, 1); return; } const c = e.target.closest('.wc[data-c]'); if (c) openWine(c.dataset.c); };

function modal(html) { $('wDetail').innerHTML = `<div class="box"><button class="btn ghost" data-x="1" style="position:absolute;top:8px;right:8px">✕</button>${html}</div>`; $('wDetail').classList.add('on'); }
const close = () => $('wDetail').classList.remove('on');
function openWine(c) {
  const i = byCode()[c]; if (!i) return; const st = data.shop || {};
  modal(`${photo(i) ? `<img src="${esc(photo(i))}" alt="">` : ''}<div class="meta" style="text-transform:uppercase;letter-spacing:1px;margin-right:44px">${esc(tyOf(i))}${i.cl ? ' · ' + esc(i.cl) : ''}</div><div class="nm" style="font-size:22px;margin:4px 44px 4px 0">${esc(i.n)} ${esc(i.v)}</div><div class="meta">${esc([i.co, i.r, i.s].filter(Boolean).join(' · '))}</div>${i.d ? `<p style="font-style:italic">${esc(i.d)}</p>` : ''}${st.showQty ? `<div class="meta" style="margin-top:8px">${i.q} op voorraad</div>` : ''}<div class="tot"><span>${i.p > 0 ? eur(i.p) : 'Prijs op aanvraag'}</span><span class="row" style="align-items:center"><button class="sm" data-d="-1" data-c="${esc(c)}">−</button><b style="min-width:28px;text-align:center">${cart[c] || 0}</b><button class="sm" data-d="1" data-c="${esc(c)}">+</button></span></div><button class="btn" data-cart="1" style="width:100%">Naar winkelmand</button>`);
}
function openCart(msg) {
  const L = cartLines(), st = data.shop || {}, t = L.reduce((a, l) => a + l.n * (l.i.p || 0), 0), pa = L.some(l => !(l.i.p > 0));
  if (!L.length) { modal('<div class="nm" style="font-size:20px">Winkelmand</div><p class="meta">Je winkelmand is leeg.</p>'); return; }
  modal(`<div class="nm" style="font-size:20px;margin-bottom:6px">Winkelmand</div>${L.map(({ i, n }) => `<div class="ci"><div class="nm">${esc(i.n)} ${esc(i.v)}<div class="meta">${i.p > 0 ? eur(i.p) + ' per fles' : 'prijs op aanvraag'}</div></div><button class="sm" data-d="-1" data-c="${esc(i.c)}">−</button><b style="min-width:22px;text-align:center">${n}</b><button class="sm" data-d="1" data-c="${esc(i.c)}">+</button></div>`).join('')}
  <div class="tot"><span>Totaal</span><span>${eur(t)}${pa ? ' *' : ''}</span></div>${pa ? '<div class="meta">* exclusief wijnen met prijs op aanvraag</div>' : ''}
  ${st.note ? `<div class="card" style="margin:10px 0;white-space:pre-line;font:14px system-ui,sans-serif">${esc(st.note)}</div>` : ''}
  <div class="nm" style="margin:12px 0 6px">Jouw gegevens</div>
  <input id="coName" placeholder="Naam" autocomplete="name" value="${esc(cf.name || '')}"><div class="row"><input id="coMail" type="email" autocomplete="email" placeholder="E-mail" value="${esc(cf.email || '')}"><input id="coTel" inputmode="tel" autocomplete="tel" placeholder="Telefoon" value="${esc(cf.phone || '')}"></div>
  <select id="coHow"><option${cf.how === 'Afhalen' ? ' selected' : ''}>Afhalen</option><option${cf.how === 'Bezorgen' ? ' selected' : ''}>Bezorgen</option></select>
  <textarea id="coNote" rows="2" placeholder="Adres (bij bezorgen) of opmerking">${esc(cf.note || '')}</textarea>
  <label class="meta" style="display:block;margin-bottom:10px"><input type="checkbox" id="coAge" style="width:auto"> Ik ben 18 jaar of ouder</label>
  ${msg ? `<div class="toast bad" style="display:block">${esc(msg)}</div>` : ''}
  <button class="btn" data-order="1" style="width:100%">Bestelling plaatsen</button>
  <div class="note">Je bestelling wordt direct voor je gereserveerd. ${st.email || st.phone ? 'Vragen? ' + [st.email ? `<a href="mailto:${esc(st.email)}">${esc(st.email)}</a>` : '', st.phone ? esc(st.phone) : ''].filter(Boolean).join(' · ') : ''}</div>`);
}
function readForm() { if (!$('coName')) return; cf = { name: $('coName').value.trim(), email: $('coMail').value.trim(), phone: $('coTel').value.trim(), how: $('coHow').value, note: $('coNote').value.trim() }; saveCf(); }
$('cartFab').onclick = () => openCart();
$('wDetail').addEventListener('click', async e => {
  if (e.target === $('wDetail') || e.target.closest('[data-x]')) { readForm(); close(); return; }
  const d = e.target.closest('button[data-d]');
  if (d) { const inCart = !!$('coName'); readForm(); add(d.dataset.c, parseInt(d.dataset.d)); if (inCart) openCart(); else openWine(d.dataset.c); return; }
  if (e.target.closest('[data-cart]')) { openCart(); return; }
  const o = e.target.closest('button[data-order]'); if (!o) return;
  const age = $('coAge').checked; readForm();
  if (!cf.name || !(cf.email || cf.phone)) { openCart('Vul je naam en een e-mailadres of telefoonnummer in.'); return; }
  if (cf.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cf.email)) { openCart('Dit e-mailadres lijkt niet te kloppen.'); return; }
  if (cf.how === 'Bezorgen' && !cf.note) { openCart('Vul je bezorgadres in bij opmerking.'); return; }
  if (!age) { openCart('Je moet 18 jaar of ouder zijn om alcohol te bestellen.'); return; }
  o.disabled = true; o.textContent = 'Bezig…';
  try {
    const r = await api.placeOrder(slug, cartLines().map(({ i, n }) => ({ code: i.c, qty: n })), cf);
    cart = {}; saveCart(); await load();
    modal(`<div class="nm" style="font-size:22px">Bedankt, ${esc(cf.name.split(' ')[0])}!</div><p>Je bestelling <b>#${r.id}</b> is ontvangen en voor je gereserveerd.</p>${(r.items || []).map(x => `<div class="ln" style="display:flex;justify-content:space-between;gap:8px;font:14px system-ui,sans-serif"><span>${x.qty} × ${esc(x.name)} ${esc(x.vintage || '')}</span><span>${x.price > 0 ? eur(x.price * x.qty) : 'op aanvraag'}</span></div>`).join('')}<div class="tot"><span>Totaal</span><span>${eur(r.total)}</span></div><p class="meta">We nemen contact met je op via ${esc(cf.email || cf.phone)} om de bestelling te bevestigen.${(data.shop || {}).note ? '<br><br>' + esc(data.shop.note) : ''}</p>`);
  } catch (err) { await load(); openCart(err.message || 'Er ging iets mis. Probeer het opnieuw.'); }
});
load();
setInterval(() => { if (document.visibilityState === 'visible' && !$('wDetail').classList.contains('on')) load(); }, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
