import { api, html, state, toast, formData } from '../lib.js';

export async function settingsView(el) {
  const me = await api('me');
  Object.assign(state.me, me);
  el.innerHTML = String(html`
    <div class="page-head"><div class="grow"><h1>Ayarlar</h1><div class="sub">${me.email}</div></div></div>
    <div class="detail-grid">
      <form class="card card-pad" data-alerts>
        <h2 style="margin-bottom:14px">Uyarı eşikleri</h2>
        <div class="form-grid">
          <div class="field"><label>Sıcaklık sınırı (°C)</label><input class="input" type="number" name="temp_limit" min="50" max="100" value="${me.temp_limit}"></div>
          <div class="field"><label>Hashrate düşüşü (%)</label><input class="input" type="number" name="hashrate_drop_pct" min="5" max="90" value="${me.hashrate_drop_pct}">
            <span class="hint">Son 3 saatin ortalamasına göre.</span></div>
          <div class="field"><label>Çevrimdışı sayılma (sn)</label><input class="input" type="number" name="offline_after_sec" min="60" max="3600" value="${me.offline_after_sec}"></div>
          <div class="field"><label>Telegram chat ID</label><input class="input mono" name="telegram_chat_id" value="${me.telegram_chat_id || ''}" placeholder="ör. 123456789">
            <span class="hint">${me.telegram_enabled ? 'Uyarılar bu sohbete gönderilir.' : 'Sunucuda Telegram bot anahtarı tanımlı değil; şimdilik sadece panelde görünür.'}</span></div>
        </div>
        <div class="form-error" data-error></div>
        <button class="btn primary">Kaydet</button>
      </form>
      <div class="grid">
        <form class="card card-pad" data-password>
          <h2 style="margin-bottom:14px">Şifre değiştir</h2>
          <div class="grid">
            <div class="field"><label>Mevcut şifre</label><input class="input" type="password" name="current" autocomplete="current-password" required></div>
            <div class="field"><label>Yeni şifre</label><input class="input" type="password" name="next" autocomplete="new-password" minlength="10" required></div>
          </div>
          <div class="form-error" data-error></div>
          <button class="btn">Şifreyi değiştir</button>
          <div class="hint small dim" style="margin-top:8px">Diğer cihazlardaki oturumlar kapanır.</div>
        </form>
        <div class="card card-pad">
          <h2 style="margin-bottom:10px">Görünüm</h2>
          <div class="seg" data-theme-seg>
            <button type="button" data-t="">Sistem</button><button type="button" data-t="light">Açık</button><button type="button" data-t="dark">Koyu</button>
          </div>
        </div>
      </div>
    </div>`);

  const bind = (sel, fn) => {
    const form = el.querySelector(sel);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      form.querySelector('[data-error]').textContent = '';
      try { await fn(form); } catch (err) { form.querySelector('[data-error]').textContent = err.message; }
    });
  };
  bind('[data-alerts]', async (f) => {
    const d = formData(f);
    await api('me/settings', { method: 'PUT', body: d });
    Object.assign(state.me, { temp_limit: Number(d.temp_limit) });
    toast('Uyarı ayarları kaydedildi.');
  });
  bind('[data-password]', async (f) => {
    await api('me/password', { method: 'PUT', body: formData(f) });
    f.reset();
    toast('Şifre değiştirildi.');
  });

  const seg = el.querySelector('[data-theme-seg]');
  const mark = () => {
    const cur = document.documentElement.dataset.theme || '';
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === cur));
  };
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    if (b.dataset.t) document.documentElement.dataset.theme = b.dataset.t; else delete document.documentElement.dataset.theme;
    try { if (b.dataset.t) localStorage.setItem('wm-theme', b.dataset.t); else localStorage.removeItem('wm-theme'); } catch { /* yok say */ }
    window.dispatchEvent(new Event('themechange'));
    mark();
  });
  mark();
  return null;
}
