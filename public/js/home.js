import * as api from './db.js';
import { APP_NAME } from './config.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const show = v => { ['vAuth', 'vNewPass', 'vPick', 'loading'].forEach(x => $(x).style.display = x === v ? '' : 'none'); };
const msg = (id, t, good) => { $(id).className = good ? 'okmsg' : 'err'; $(id).textContent = t || ''; };
$('appName').textContent = APP_NAME; document.title = APP_NAME;
if (!api.configured) $('cfgWarn').style.display = '';

let mode = 'in', recovering = location.hash.includes('type=recovery');
document.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
  mode = b.dataset.m; document.querySelectorAll('[data-m]').forEach(x => x.classList.toggle('on', x === b));
  $('aGo').textContent = mode === 'in' ? 'Sign in' : 'Create account';
  $('aPass').autocomplete = mode === 'in' ? 'current-password' : 'new-password'; msg('aMsg', '');
});
$('aPass').addEventListener('keydown', e => { if (e.key === 'Enter') $('aGo').click(); });
$('aGo').onclick = async () => {
  const email = $('aEmail').value.trim(), pass = $('aPass').value;
  if (!email || pass.length < 8) return msg('aMsg', 'Enter your e-mail and a password of at least 8 characters.');
  $('aGo').disabled = true;
  try {
    if (mode === 'in') { await api.signIn(email, pass); await route(); }
    else {
      const r = await api.signUp(email, pass);
      if (r && r.session) await route();
      else msg('aMsg', 'Almost done: open the confirmation e-mail we just sent you, then sign in.', true);
    }
  } catch (e) { msg('aMsg', e.message === 'Invalid login credentials' ? 'Wrong e-mail or password.' : e.message); }
  $('aGo').disabled = false;
};
$('aForgot').onclick = async () => {
  const email = $('aEmail').value.trim(); if (!email) return msg('aMsg', 'Enter your e-mail address first.');
  try { await api.sendReset(email); msg('aMsg', 'Check your e-mail for a link to choose a new password.', true); }
  catch (e) { msg('aMsg', e.message); }
};
$('npGo').onclick = async () => {
  const p = $('npPass').value; if (p.length < 8) return msg('npMsg', 'Use at least 8 characters.');
  try { await api.setPassword(p); recovering = false; history.replaceState(null, '', location.pathname); await route(); }
  catch (e) { msg('npMsg', e.message); }
};
$('out').onclick = async () => { await api.signOut(); show('vAuth'); };

const slugify = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
let slugTouched = false;
$('ncName').oninput = () => { if (!slugTouched) $('ncSlug').value = slugify($('ncName').value); hint(); };
$('ncSlug').oninput = () => { slugTouched = true; hint(); };
function hint() { const s = slugify($('ncSlug').value); $('ncHint').textContent = s ? 'Shop link: ' + location.origin + location.pathname.replace(/[^/]*$/, '') + 'shop.html?k=' + s : ''; }
$('ncGo').onclick = async () => {
  const name = $('ncName').value.trim(), slug = slugify($('ncSlug').value);
  if (!name) return msg('ncMsg', 'Enter a name.');
  if (slug.length < 3) return msg('ncMsg', 'The web address needs at least 3 letters or digits.');
  $('ncGo').disabled = true;
  try { const id = await api.createCellar(name, slug); location.href = 'app.html?c=' + id; }
  catch (e) { msg('ncMsg', /duplicate|unique/i.test(e.message) ? 'That web address is already taken. Try another one.' : e.message); }
  $('ncGo').disabled = false;
};

async function route() {
  if (!api.configured) { show('vAuth'); return; }
  const s = await api.session();
  if (recovering && s) { show('vNewPass'); return; }
  if (!s) { show('vAuth'); return; }
  try { await api.acceptInvites(); } catch (e) { }
  let list = [];
  try { list = await api.myCellars(s.user.id); } catch (e) { $('cellars').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  const pick = new URLSearchParams(location.search).has('pick');
  if (list.length === 1 && !pick) { location.replace('app.html?c=' + list[0].id); return; }
  $('who').textContent = 'Signed in as ' + s.user.email;
  $('cellars').innerHTML = list.length ? list.map(c => `<a class="cl" href="app.html?c=${esc(c.id)}"><span><b>${esc(c.name)}</b><div class="meta">${esc(c.role)}</div></span><span>›</span></a>`).join('')
    : '<div class="meta">You have no cellar yet. Create one below, or ask the restaurant to invite you.</div>';
  show('vPick');
}
api.onAuth(ev => { if (ev === 'PASSWORD_RECOVERY') { recovering = true; show('vNewPass'); } });
route();
