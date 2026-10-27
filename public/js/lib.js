// Ortak yardımcılar: API, güvenli HTML, biçimlendirme, bildirim, diyalog

export const BASE = document.querySelector('base').getAttribute('href'); // ör. "/mining/"
export const state = { me: null };

// ---- API ----
export async function api(path, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && state.me?.csrf) headers['x-csrf-token'] = state.me.csrf;
  const res = await fetch(`${BASE}api/${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch { /* boş yanıt */ }
  if (!res.ok) {
    const err = new Error(data?.message || `İstek başarısız (${res.status})`);
    err.status = res.status;
    err.code = data?.error;
    throw err;
  }
  return data;
}

// ---- Güvenli HTML şablonu: değerler otomatik kaçışlanır ----
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
function part(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === false || v === null || v === undefined) return '';
  return esc(v);
}
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += part(v) + strings[i + 1]; });
  return new Raw(out);
}

// ---- Biçimlendirme ----
export function fmtHash(h) {
  if (h === null || h === undefined || !Number.isFinite(h)) return '—';
  const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s'];
  let i = 0;
  while (h >= 1000 && i < units.length - 1) { h /= 1000; i++; }
  return `${h >= 100 ? h.toFixed(0) : h >= 10 ? h.toFixed(1) : h.toFixed(2)} ${units[i]}`;
}
export function splitHash(h) {
  const [v, u] = fmtHash(h).split(' ');
  return html`${v}<small>${u || ''}</small>`;
}
export const fmtPower = (w) => (w === null || w === undefined ? '—' : w >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`);
export const fmtTemp = (t) => (t === null || t === undefined ? '—' : `${Math.round(t)}°C`);
export const fmtPct = (p) => (p === null || p === undefined ? '—' : `${Math.round(p)}%`);
export function tempClass(t, limit = state.me?.temp_limit ?? 80) {
  if (t === null || t === undefined) return '';
  return t >= limit ? 't-bad' : t >= limit - 10 ? 't-warn' : 't-ok';
}
export function ago(ts) {
  if (!ts) return 'hiç';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s} sn önce`;
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa önce`;
  return `${Math.floor(s / 86400)} gün önce`;
}
export function duration(sec) {
  if (!sec && sec !== 0) return '—';
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}g ${h}s` : h ? `${h}s ${m}dk` : `${m}dk`;
}
export const dateTime = (ts) => (ts ? new Date(ts * 1000).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export const MINER_STATUS = {
  running: ['Çalışıyor', 'ok'], stopped: ['Durduruldu', ''], starting: ['Başlıyor', 'warn'], downloading: ['İndiriliyor', 'warn'],
  error: ['Hata', 'bad'], unknown: ['Bilinmiyor', ''], offline: ['Çevrimdışı', 'bad'],
};
export const COMMAND_LABELS = {
  miner_start: 'Miner başlat', miner_stop: 'Miner durdur', miner_restart: 'Miner yeniden başlat', reboot: 'Rig yeniden başlat', apply_oc: 'OC uygula', oc_tune: 'Otomatik OC', oc_tune_cancel: 'Otomatik OC iptal', console: 'Ekrandan komut',
};
export const COMMAND_STATUS = { queued: ['Sırada', 'warn'], sent: ['Gönderildi', 'warn'], done: ['Tamam', 'ok'], failed: ['Başarısız', 'bad'], expired: ['Zaman aşımı', ''] };
export const ALERT_LABELS = { offline: 'Rig çevrimdışı', gpu_lost: 'Kart kayboldu', high_temp: 'Sıcaklık yüksek', hashrate_drop: 'Hashrate düştü', hw_changed: 'Donanım değişti', new_gpu: 'Yeni kart algılandı', no_miner: 'Kart boşta' };

// Metni dosya olarak indir (rig.conf için)
// Sunucudan "attachment" olarak gelen dosyayı indirir (sayfa değişmez)
export function downloadUrl(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = 'rig.conf';
  (document.querySelector('dialog[open]') || document.body).append(a);
  a.click();
  a.remove();
}

// rig.conf içeriğini gösteren kutu: indirme bağlantısı + elle kopyalama yedeği
export function confBox(res) {
  return html`<div class="conf-box" style="display:flex;flex-direction:column;gap:8px">
    <div class="btn-row"><a class="btn primary" href="${res.conf_url}" download="rig.conf">${icon('download')}rig.conf indir</a>
      <button type="button" class="btn" data-conf-copy>${icon('copy')}İçeriği kopyala</button></div>
    <textarea class="mono small" readonly rows="7" spellcheck="false" data-conf-text>${res.conf}</textarea>
    <span class="hint">İndirme olmazsa: içeriği kopyalayın, Not Defteri'ne yapıştırıp flash'taki WMINING sürücüsüne <strong>rig.conf</strong> adıyla kaydedin. Dosyayı sonradan da rig ayarlarından tekrar indirebilirsiniz. İçerik bu rig'in anahtarıdır, kimseyle paylaşmayın.</span>
  </div>`;
}

export function wireConfBox(root) {
  root.querySelector('[data-conf-copy]')?.addEventListener('click', async () => {
    const ta = root.querySelector('[data-conf-text]');
    try { await navigator.clipboard.writeText(ta.value); } catch { ta.select(); document.execCommand('copy'); }
    toast('rig.conf içeriği kopyalandı.');
  });
}

export function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Bildirim balonu ----
export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 5000 : 3000);
}

// ---- Diyalog ----
// body: HTML; onSubmit(form) true/undefined dönerse kapanır; hata fırlatırsa mesaj gösterilir
export function openDialog({ title, body, submitLabel = 'Kaydet', danger = false, onSubmit, onOpen, wide = false }) {
  const dlg = document.createElement('dialog');
  if (wide) dlg.style.width = 'min(760px, calc(100vw - 24px))';
  dlg.innerHTML = String(html`
    <form method="dialog" novalidate>
      <div class="dlg-head"><h2>${title}</h2><button type="button" class="btn ghost icon" data-close aria-label="Kapat">${icon('x')}</button></div>
      <div class="dlg-body">${body}<div class="form-error" data-error></div></div>
      <div class="dlg-foot">
        <button type="button" class="btn" data-close>Vazgeç</button>
        ${onSubmit ? html`<button class="btn ${danger ? 'danger' : 'primary'}" value="ok" data-submit>${submitLabel}</button>` : ''}
      </div>
    </form>`);
  document.body.append(dlg);
  const form = dlg.querySelector('form');
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); // Enter tuşu da kaydet düğmesi gibi davranır
    if (!onSubmit) return;
    const btn = dlg.querySelector('[data-submit]');
    btn.disabled = true;
    dlg.querySelector('[data-error]').textContent = '';
    try {
      const keep = await onSubmit(form, dlg);
      if (keep !== false) dlg.close();
    } catch (err) {
      dlg.querySelector('[data-error]').textContent = err.message;
    } finally { btn.disabled = false; }
  });
  dlg.addEventListener('close', () => dlg.remove());
  // Kaydı olmayan pencereler (ekran, grafik) dışına dokununca kapanır: telefonda kapatma düğmesi görünmese de çıkılabilsin
  if (!onSubmit) dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.showModal();
  onOpen?.(dlg);
  return dlg;
}

export function confirmDialog(title, message, label = 'Onayla', danger = true) {
  return new Promise((resolve) => {
    const d = openDialog({ title, body: html`<p class="muted" style="margin:0">${message}</p>`, submitLabel: label, danger, onSubmit: () => resolve(true) });
    d.addEventListener('close', () => resolve(false));
  });
}

export const formData = (form) => Object.fromEntries(new FormData(form).entries());

// ---- İkonlar (çizgi, 24px) ----
const ICONS = {
  rigs: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
  flight: '<path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="16" r="3"/>',
  oc: '<path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5"/><circle cx="12" cy="12" r="4"/>',
  miners: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  alerts: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  restart: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  power: '<path d="M12 3v9"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  apply: '<path d="M20 6 9 17l-5-5"/>',
  usb: '<rect x="7" y="2" width="10" height="8" rx="1"/><path d="M5 10h14v6a6 6 0 0 1-6 6h-2a6 6 0 0 1-6-6z"/><path d="M10 5h.01M14 5h.01"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  profit: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
};
export const icon = (name) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`);
