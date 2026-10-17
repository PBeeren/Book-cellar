// In-memory stand-in for js/db.js, used only by the browser tests.
const M = window.__mock || (window.__mock = {});
const S = M.store || (M.store = { cellars: {}, members: [], invites: [], wines: {}, movements: [], orders: [], seq: 1 });
const user = M.user || { id: 'u1', email: 'owner@a.nl' };
const subs = [];
export const configured = true;
const role = c => (S.members.find(m => m.cellar_id === c && m.user_id === user.id) || {}).role;
const isMgr = c => ['owner', 'manager'].includes(role(c));
const wkey = (c, code) => c + '|' + code;
const tick = () => new Promise(r => setTimeout(r, 5));
const emit = (kind, row) => subs.forEach(s => s.c === row.cellar_id && s.h[kind] && setTimeout(() => s.h[kind](JSON.parse(JSON.stringify(row))), 10));

export async function session() { return M.signedOut ? null : { user }; }
export function onAuth() { }
export async function signIn() { } export async function signUp() { return { session: { user } }; }
export async function sendReset() { } export async function setPassword() { } export async function signOut() { M.signedOut = true; }
export async function acceptInvites() { return 0; }
export async function myCellars() { return S.members.filter(m => m.user_id === user.id).map(m => ({ role: m.role, ...S.cellars[m.cellar_id] })); }
export async function createCellar(name, slug) { const id = 'c' + (S.seq++); S.cellars[id] = { id, name, slug, settings: {}, shop: { enabled: false, factor: 1.8, round: 1 } }; S.members.push({ cellar_id: id, user_id: user.id, role: 'owner', email: user.email }); return id; }
export async function getCellar(c) { await tick(); if (!role(c)) throw new Error('not found'); return JSON.parse(JSON.stringify(S.cellars[c])); }
export async function updateCellar(c, p) { if (!isMgr(c)) return; Object.assign(S.cellars[c], JSON.parse(JSON.stringify(p))); }
export async function members(c) { return S.members.filter(m => m.cellar_id === c).map(m => ({ ...m })); }
export async function invites(c) { return S.invites.filter(i => i.cellar_id === c); }
export async function invite(c, email, role) { if (!isMgr(c)) throw new Error('new row violates row-level security policy'); S.invites.push({ cellar_id: c, email, role }); }
export async function cancelInvite(c, email) { S.invites = S.invites.filter(i => !(i.cellar_id === c && i.email === email)); }
export async function removeMember(c, u) { S.members = S.members.filter(m => !(m.cellar_id === c && m.user_id === u)); }
export async function setRole(c, u, r) { const m = S.members.find(m => m.cellar_id === c && m.user_id === u); if (m) m.role = r; }

const FIELDS = ['name', 'vintage', 'type', 'country', 'region', 'sub', 'cls', 'price', 'sell', 'sell_manual', 'shop_price', 'no_shop', 'bottles', 'loc', 'aliases', 'photo', 'list_name', 'descr'];
export function fromRow(r) {
  return { name: r.name || '', vintage: r.vintage || '', type: r.type || '', country: r.country || '', region: r.region || '', sub: r.sub || '', cls: r.cls || '', price: +r.price || 0, sell: +r.sell || 0, sellManual: !!r.sell_manual, shopPrice: +r.shop_price || 0, noShop: !!r.no_shop, bottles: r.bottles || 0, loc: r.loc || '', aliases: r.aliases || [], photo: r.photo || '', listName: r.list_name || '', desc: r.descr || '', places: {} };
}
function toRow(c, code, w, withStock) {
  const r = { cellar_id: c, code, name: w.name || '', vintage: String(w.vintage ?? ''), type: w.type || '', country: w.country || '', region: w.region || '', sub: w.sub || '', cls: w.cls || '', price: +w.price || 0, sell: +w.sell || 0, sell_manual: !!w.sellManual, shop_price: +w.shopPrice || 0, no_shop: !!w.noShop, loc: w.loc || '', aliases: w.aliases || [], photo: w.photo || '', list_name: w.listName || '', descr: w.desc || '' };
  if (withStock) r.bottles = Math.max(0, parseInt(w.bottles) || 0); return r;
}
function upsert(r) {
  const k = wkey(r.cellar_id, r.code), old = S.wines[k];
  if (!role(r.cellar_id)) throw new Error('row-level security');
  const n = { ...(old || { bottles: 0 }), ...r };
  if (!isMgr(r.cellar_id)) { const o = old || { price: 0, sell: 0, sell_manual: false, shop_price: 0, no_shop: false, bottles: 0 };['price', 'sell', 'sell_manual', 'shop_price', 'no_shop', 'bottles'].forEach(f => n[f] = o[f] ?? 0); }
  if (n.bottles == null) n.bottles = 0;
  S.wines[k] = n; emit('wine', n); M.writes = (M.writes || 0) + 1; return n;
}
export async function loadWines(c) { await tick(); return Object.values(S.wines).filter(w => w.cellar_id === c).map(w => ({ ...w })); }
export async function saveWine(c, code, w, ws = false) { await tick(); return { ...upsert(toRow(c, code, w, ws)) }; }
export async function saveWines(c, list, ws = false) { await tick(); list.forEach(([code, w]) => upsert(toRow(c, code, w, ws))); }
export async function patchWines(c, codes, p) { codes.forEach(code => { const w = S.wines[wkey(c, code)]; if (w) { Object.assign(w, p); emit('wine', w); } }); }
export async function deleteWines(c, codes) { if (!isMgr(c)) throw new Error('denied'); codes.forEach(code => delete S.wines[wkey(c, code)]); }
export async function adjustStock(c, code, delta, kind, place = '') {
  await tick(); const r = role(c); if (!r) throw new Error('You are not a member of this cellar');
  if (kind === 'adj' && !isMgr(c)) throw new Error('Only managers can correct stock');
  const w = S.wines[wkey(c, code)]; if (!w) throw new Error('Unknown wine');
  if (w.bottles + delta < 0) throw new Error('Not enough bottles in stock');
  w.bottles += delta; const pl = String(place || '').toUpperCase().trim();
  if (pl && !w.loc.split(',').map(x => x.trim().toUpperCase()).includes(pl)) w.loc = w.loc ? w.loc + ', ' + pl : pl;
  const m = { id: S.seq++, cellar_id: c, ts: new Date().toISOString(), code, name: w.name, kind, delta, place: pl, by: user.id };
  S.movements.unshift(m); emit('wine', w); emit('movement', m); return w.bottles;
}
export async function logAdjustments(c, rows) { rows.forEach(x => { const m = { id: S.seq++, cellar_id: c, ts: new Date().toISOString(), code: x.code, name: x.name, kind: 'adj', delta: x.delta, place: '', by: user.id }; S.movements.unshift(m); }); }
export async function mergeWines(c, keep, others) {
  const k = S.wines[wkey(c, keep)];
  others.forEach(o => { const w = S.wines[wkey(c, o)]; if (!w) return; k.bottles += w.bottles; k.aliases = [...new Set([...k.aliases, o, ...w.aliases])]; delete S.wines[wkey(c, o)]; });
}
export async function loadMovements(c) { return S.movements.filter(m => m.cellar_id === c).slice(0, 300); }
export async function loadOrders(c) { return S.orders.filter(o => o.cellar_id === c).map(o => JSON.parse(JSON.stringify(o))); }
export async function setOrderStatus(id, st) {
  const o = S.orders.find(o => o.id === id);
  if (st === 'cancelled' && o.status !== 'cancelled') o.items.forEach(i => { const w = S.wines[wkey(o.cellar_id, i.code)]; if (w) w.bottles += i.qty; });
  o.status = st; emit('order', o);
}
export async function uploadPhoto(c) { return c + '/test.jpg'; }
export async function deletePhoto() { }
export function photoUrl(p) { return p ? 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' : ''; }
export function subscribe(c, h, onStatus) { subs.push({ c, h }); setTimeout(() => onStatus && onStatus('SUBSCRIBED'), 20); return () => { }; }
function shopPrice(w, s) { if (w.shop_price > 0) return w.shop_price; if (!(w.price > 0)) return 0; const f = s.factor || 1.8, r = s.round ?? 1; let p = w.price * f; if (r > 0) p = Math.ceil(Math.round(p / r * 1e6) / 1e6) * r; return Math.round(p * 100) / 100; }
export async function getShop(slug) {
  await tick(); const c = Object.values(S.cellars).find(c => c.slug === slug && c.shop.enabled); if (!c) return null;
  const items = Object.values(S.wines).filter(w => w.cellar_id === c.id && w.bottles > 0 && !w.no_shop && w.name).map(w => ({ c: w.code, n: w.list_name || w.name, v: w.vintage, t: w.type, co: w.country, r: w.region, s: w.sub, cl: w.cls, d: w.descr, ph: w.photo, q: w.bottles, p: shopPrice(w, c.shop) })).sort((a, b) => a.n.localeCompare(b.n));
  const s = c.shop; return { shop: { name: s.name || c.name, intro: s.intro || '', email: s.email || '', phone: s.phone || '', note: s.note || '', showQty: !!s.showQty }, items };
}
export async function placeOrder(slug, items, cust) {
  await tick(); const c = Object.values(S.cellars).find(c => c.slug === slug && c.shop.enabled); if (!c) throw new Error('Deze webshop bestaat niet of is gesloten');
  let total = 0; const lines = [];
  for (const it of items) { const w = S.wines[wkey(c.id, it.code)]; if (!w || w.no_shop) throw new Error('Een wijn in je mand is niet meer beschikbaar'); if (w.bottles < it.qty) throw new Error(`Nog maar ${w.bottles} fles(sen) van ${w.name} beschikbaar`); }
  for (const it of items) { const w = S.wines[wkey(c.id, it.code)], p = shopPrice(w, c.shop); w.bottles -= it.qty; total += p * it.qty; lines.push({ code: w.code, name: w.list_name || w.name, vintage: w.vintage, qty: it.qty, price: p }); emit('wine', w); }
  const o = { id: S.seq++, cellar_id: c.id, created_at: new Date().toISOString(), status: 'new', customer: cust, items: lines, total, staff_note: '' };
  S.orders.unshift(o); emit('order', o); return { id: o.id, total, items: lines };
}
