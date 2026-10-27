import { api, html, icon, state, BASE, toast } from './lib.js';
import { rigsView } from './views/rigs.js';
import { rigView } from './views/rig.js';
import { flightView } from './views/flight.js';
import { ocView } from './views/oc.js';
import { minersView } from './views/miners.js';
import { alertsView } from './views/alerts.js';
import { settingsView } from './views/settings.js';
import { setupView } from './views/setup.js';

const NAV = [
  { path: 'rigs', label: "Rig'ler", short: "Rig'ler", icon: 'rigs' },
  { path: 'flight-sheets', label: 'Flight sheet', short: 'Flight', icon: 'flight' },
  { path: 'overclock', label: 'Overclock', short: 'OC', icon: 'oc' },
  { path: 'miners', label: 'Miner kataloğu', short: 'Miner', icon: 'miners' },
  { path: 'alerts', label: 'Uyarılar', short: 'Uyarı', icon: 'alerts' },
  { path: 'setup', label: 'Flash kurulumu', short: 'Kurulum', icon: 'usb', desktopOnly: true },
  { path: 'settings', label: 'Ayarlar', short: 'Ayarlar', icon: 'settings', desktopOnly: true },
];

const ROUTES = [
  [/^rigs\/([0-9a-f-]{36})$/, rigView],
  [/^(rigs)?$/, rigsView],
  [/^flight-sheets$/, flightView],
  [/^overclock$/, ocView],
  [/^miners$/, minersView],
  [/^alerts$/, alertsView],
  [/^settings$/, settingsView],
  [/^setup$/, setupView],
];

let dispose = null;

export function navigate(path, replace = false) {
  const url = BASE + path.replace(/^\//, '');
  if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
  route();
}

const currentPath = () => decodeURIComponent(location.pathname.slice(BASE.length - 1)).replace(/^\/+|\/+$/g, '');

function themeToggle() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('wm-theme', next); } catch { /* yok say */ }
  window.dispatchEvent(new Event('themechange'));
}

function shell() {
  // Menüde uyarı sayısı rozeti gösterilmez (kullanıcı isteği); aktif uyarılar Uyarılar sayfasında ve rig kartlarında görünür
  return html`
    <div class="layout">
      <aside class="sidebar">
        <a class="brand" href="./" title="Ana sayfa"><img src="img/icon.svg" alt="">WhisperMining</a>
        <nav class="nav">
          ${NAV.map((n) => html`<a href="${n.path}" data-nav="${n.path}">${icon(n.icon)}${n.label}</a>`)}
        </nav>
        <div class="sidebar-foot nav">
          <div class="who">${state.me.email}</div>
          <a href="#" data-theme-toggle>${icon('moon')}Tema değiştir</a>
          <a href="#" data-logout>${icon('logout')}Çıkış yap</a>
        </div>
      </aside>
      <header class="topbar">
        <a class="brand" href="./" title="Ana sayfa"><img src="img/icon.svg" alt="">WhisperMining</a>
        <a class="btn ghost icon" href="setup" aria-label="Flash kurulumu">${icon('usb')}</a>
        <button class="btn ghost icon" data-theme-toggle aria-label="Tema değiştir">${icon('moon')}</button>
        <a class="btn ghost icon" href="settings" aria-label="Ayarlar">${icon('settings')}</a>
      </header>
      <main class="main" id="view"></main>
      <nav class="tabbar">
        ${NAV.filter((n) => !n.desktopOnly).map((n) => html`<a href="${n.path}" data-nav="${n.path}">${icon(n.icon)}${n.short}</a>`)}
      </nav>
    </div>`;
}

export function setAlertBadge(n) {
  state.me.open_alerts = n;
  document.querySelectorAll('[data-alert-badge]').forEach((b) => { b.textContent = n; b.classList.toggle('hidden', !n); });
}

async function route() {
  if (dispose) { try { dispose(); } catch { /* yok say */ } dispose = null; }
  const path = currentPath();
  const view = document.getElementById('view');
  if (!view) return;
  const section = path.split('/')[0] || 'rigs';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
  window.scrollTo(0, 0);
  for (const [re, fn] of ROUTES) {
    const m = path.match(re);
    if (m) {
      view.innerHTML = '<div class="boot">Yükleniyor…</div>';
      try {
        dispose = (await fn(view, m.slice(1))) || null;
      } catch (err) {
        if (err.status === 401) return start();
        view.innerHTML = String(html`<div class="card empty"><h2>Bir sorun oluştu</h2><p>${err.message}</p></div>`);
      }
      return;
    }
  }
  view.innerHTML = String(html`<div class="card empty"><h2>Sayfa bulunamadı</h2><a class="btn" href="rigs">Rig'lere dön</a></div>`);
}

function authView(needsSetup) {
  const app = document.getElementById('app');
  app.innerHTML = String(html`
    <div class="auth-wrap">
      <div class="card auth">
        <div class="brand"><img src="img/icon.svg" alt="">WhisperMining</div>
        <p class="muted" style="margin:0">${needsSetup ? 'İlk kurulum: yönetici hesabını oluşturun.' : 'Madencilik rig\'lerinizi yönetmek için giriş yapın.'}</p>
        <form>
          <div class="field"><label for="email">E-posta</label><input class="input" id="email" name="email" type="email" autocomplete="username" required></div>
          <div class="field"><label for="password">Şifre</label><input class="input" id="password" name="password" type="password"
            autocomplete="${needsSetup ? 'new-password' : 'current-password'}" required minlength="${needsSetup ? 10 : 1}">
            ${needsSetup ? html`<span class="hint">En az 10 karakter.</span>` : ''}</div>
          <div class="form-error" data-error></div>
          <button class="btn primary" type="submit">${needsSetup ? 'Hesabı oluştur' : 'Giriş yap'}</button>
        </form>
      </div>
    </div>`);
  const form = app.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api(needsSetup ? 'setup' : 'login', { method: 'POST', body: { email: form.email.value, password: form.password.value } });
      await start();
    } catch (err) {
      form.querySelector('[data-error]').textContent = err.message;
    } finally { btn.disabled = false; }
  });
}

async function start() {
  try {
    state.me = await api('me');
  } catch (err) {
    if (err.status !== 401) {
      document.getElementById('app').innerHTML = String(html`<div class="boot">Sunucuya ulaşılamadı: ${err.message}</div>`);
      return;
    }
    const { needs_setup } = await api('setup-status');
    return authView(needs_setup);
  }
  document.getElementById('app').innerHTML = String(shell());
  route();
}

// Uygulama içi bağlantılar sayfayı yenilemeden açılsın
document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-theme-toggle]')) { e.preventDefault(); themeToggle(); return; }
  if (e.target.closest('[data-logout]')) {
    e.preventDefault();
    await api('logout', { method: 'POST' }).catch(() => {});
    state.me = null;
    toast('Çıkış yapıldı.');
    return start();
  }
  const a = e.target.closest('a[href]');
  if (!a || a.target || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  const href = a.getAttribute('href');
  // Dosya indirmeleri (rig.conf, imaj) sayfa geçişi değil: tarayıcı kendisi indirsin
  if (/^(https?:|mailto:|#)/.test(href) || a.hasAttribute('download') || /^(api|downloads)\//.test(href)) return;
  e.preventDefault();
  navigate(href);
});
window.addEventListener('popstate', route);

start();
