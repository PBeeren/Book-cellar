// All communication with Supabase lives in this file.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const configured = !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.includes('YOUR-ANON-KEY');
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const ok = ({ data, error }) => { if (error) throw new Error(error.message || String(error)); return data; };

/* ---------- account ---------- */
export async function session() { return (await sb.auth.getSession()).data.session; }
export function onAuth(cb) { return sb.auth.onAuthStateChange((ev, s) => cb(ev, s)); }
export async function signIn(email, password) { ok(await sb.auth.signInWithPassword({ email, password })); }
export async function signUp(email, password) {
  return ok(await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }));
}
export async function sendReset(email) {
  ok(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }));
}
export async function setPassword(password) { ok(await sb.auth.updateUser({ password })); }
export async function signOut() { await sb.auth.signOut(); }

/* ---------- cellars & team ---------- */
export async function acceptInvites() { return ok(await sb.rpc('accept_invites')); }
export async function myCellars(uid) {
  return ok(await sb.from('members').select('role, cellars(id,name,slug)').eq('user_id', uid))
    .filter(m => m.cellars).map(m => ({ role: m.role, ...m.cellars }));
}
export async function createCellar(name, slug) { return ok(await sb.rpc('create_cellar', { p_name: name, p_slug: slug })); }
export async function getCellar(c) { return ok(await sb.from('cellars').select('*').eq('id', c).single()); }
export async function updateCellar(c, patch) { ok(await sb.from('cellars').update(patch).eq('id', c)); }
export async function members(c) { return ok(await sb.from('members').select('user_id,role,email').eq('cellar_id', c)); }
export async function invites(c) { return ok(await sb.from('invites').select('email,role').eq('cellar_id', c)); }
export async function invite(c, email, role) {
  ok(await sb.from('invites').upsert({ cellar_id: c, email: email.trim().toLowerCase(), role }));
}
export async function cancelInvite(c, email) { ok(await sb.from('invites').delete().eq('cellar_id', c).eq('email', email)); }
export async function removeMember(c, user) { ok(await sb.rpc('remove_member', { c, p_user: user })); }
export async function setRole(c, user, role) { ok(await sb.rpc('set_member_role', { c, p_user: user, p_role: role })); }

/* ---------- wines ---------- */
export function fromRow(r) {
  return {
    name: r.name || '', vintage: r.vintage || '', type: r.type || '', country: r.country || '', region: r.region || '',
    sub: r.sub || '', cls: r.cls || '', price: +r.price || 0, sell: +r.sell || 0, sellManual: !!r.sell_manual,
    shopPrice: +r.shop_price || 0, noShop: !!r.no_shop, bottles: r.bottles || 0, loc: r.loc || '',
    aliases: r.aliases || [], photo: r.photo || '', listName: r.list_name || '', desc: r.descr || '', places: {}
  };
}
function toRow(c, code, w, withStock) {
  const r = {
    cellar_id: c, code, name: w.name || '', vintage: String(w.vintage ?? ''), type: w.type || '', country: w.country || '',
    region: w.region || '', sub: w.sub || '', cls: w.cls || '', price: +w.price || 0, sell: +w.sell || 0,
    sell_manual: !!w.sellManual, shop_price: +w.shopPrice || 0, no_shop: !!w.noShop, loc: w.loc || '',
    aliases: (w.aliases || []).map(String), photo: w.photo || '', list_name: w.listName || '', descr: w.desc || ''
  };
  if (withStock) r.bottles = Math.max(0, parseInt(w.bottles) || 0);
  return r;
}
export async function loadWines(c) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const d = ok(await sb.from('wines').select('*').eq('cellar_id', c).order('code').range(from, from + 999));
    all.push(...d);
    if (d.length < 1000) break;
  }
  return all;
}
// Saves the details of one wine. Stock is only sent when withStock is true (managers).
export async function saveWine(c, code, w, withStock = false) {
  return ok(await sb.from('wines').upsert(toRow(c, code, w, withStock)).select().single());
}
export async function saveWines(c, list, withStock = false) {
  for (let i = 0; i < list.length; i += 200) {
    ok(await sb.from('wines').upsert(list.slice(i, i + 200).map(([code, w]) => toRow(c, code, w, withStock))));
  }
}
export async function patchWines(c, codes, patch) { ok(await sb.from('wines').update(patch).eq('cellar_id', c).in('code', codes)); }
export async function deleteWines(c, codes) {
  for (let i = 0; i < codes.length; i += 200) ok(await sb.from('wines').delete().eq('cellar_id', c).in('code', codes.slice(i, i + 200)));
}
export async function adjustStock(c, code, delta, kind, place = '') {
  return ok(await sb.rpc('adjust_stock', { c, p_code: code, p_delta: delta, p_kind: kind, p_place: place || '' }));
}
export async function logAdjustments(c, rows) { if (rows.length) ok(await sb.rpc('log_adjustments', { c, p_rows: rows })); }
export async function mergeWines(c, keep, others) { ok(await sb.rpc('merge_wines', { c, p_keep: keep, p_others: others })); }

/* ---------- history & orders ---------- */
export async function loadMovements(c, limit = 300) {
  return ok(await sb.from('movements').select('*').eq('cellar_id', c).order('ts', { ascending: false }).limit(limit));
}
export async function loadOrders(c, limit = 200) {
  return ok(await sb.from('orders').select('*').eq('cellar_id', c).order('created_at', { ascending: false }).limit(limit));
}
export async function setOrderStatus(id, status, note = null) {
  ok(await sb.rpc('set_order_status', { p_order: id, p_status: status, p_note: note }));
}

/* ---------- photos ---------- */
export async function uploadPhoto(c, blob) {
  const path = `${c}/${crypto.randomUUID()}.jpg`;
  ok(await sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false }));
  return path;
}
export async function deletePhoto(path) { if (path) await sb.storage.from('photos').remove([path]); }
export function photoUrl(path) { return path ? sb.storage.from('photos').getPublicUrl(path).data.publicUrl : ''; }

/* ---------- live updates ---------- */
// handlers: { wine(row), movement(row), order(row) }
// Deletions are not streamed (Supabase cannot filter them per cellar); the app
// reloads the full list when it regains focus and every few minutes instead.
export function subscribe(c, h, onStatus) {
  const ch = sb.channel('cellar-' + c)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'wines', filter: `cellar_id=eq.${c}` }, p => h.wine(p.new, false))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'wines', filter: `cellar_id=eq.${c}` }, p => h.wine(p.new, false))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'movements', filter: `cellar_id=eq.${c}` }, p => h.movement(p.new))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `cellar_id=eq.${c}` }, p => h.order(p.new))
    .subscribe(s => onStatus && onStatus(s));
  return () => sb.removeChannel(ch);
}

/* ---------- public webshop ---------- */
export async function getShop(slug) { return ok(await sb.rpc('get_shop', { p_slug: slug })); }
export async function placeOrder(slug, items, customer) {
  return ok(await sb.rpc('place_order', { p_slug: slug, p_items: items, p_customer: customer }));
}
