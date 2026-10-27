import { api, html, icon, state, toast, formData } from '../lib.js';

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
        </div>
        <div class="form-error" data-error></div>
        <button class="btn primary">Kaydet</button>
      </form>
      <div class="card card-pad" data-telegram></div>
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

  // ---- Telegram ----
  const tgBox = el.querySelector('[data-telegram]');
  let linkTimer = null;
  const renderTg = () => {
    const linked = !!me.telegram_chat_id;
    tgBox.innerHTML = String(html`
      <h2 style="margin-bottom:10px">Telegram bildirimleri</h2>
      ${!me.telegram_enabled ? html`
        ${me.is_admin ? html`
          <p class="muted" style="margin:0 0 10px">Uyarıların Telegram'a gelmesi için bir kez bot oluşturmanız gerekiyor:</p>
          <ol class="muted" style="margin:0 0 12px;padding-left:20px;line-height:1.7">
            <li>Telegram'da <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> ile sohbet açın, <span class="mono">/newbot</span> yazın.</li>
            <li>Bota bir ad verin (ör. <span class="mono">WhisperMining</span>), sonra sonu <span class="mono">bot</span> ile biten bir kullanıcı adı verin (ör. <span class="mono">whispermining_emrah_bot</span>).</li>
            <li>BotFather'ın verdiği <strong>anahtarı</strong> (ör. <span class="mono">123456789:AA...</span>) aşağıya yapıştırın.</li>
          </ol>
          <form data-tg-token style="display:flex;gap:8px;flex-wrap:wrap">
            <input class="input mono" type="password" name="token" autocomplete="off" placeholder="Bot anahtarı" style="flex:1;min-width:220px" required>
            <button class="btn primary">Kaydet</button>
          </form>
          <div class="form-error" data-error></div>
          <span class="hint">Bu bot sadece bu panel için kullanılmalı. Anahtar sunucuda şifreli saklanır.</span>`
        : html`<p class="muted" style="margin:0">Telegram botu henüz kurulmadı. Yöneticinin bot anahtarını girmesi gerekiyor.</p>`}`
      : html`
        <p class="muted" style="margin:0 0 12px">Bot: <a href="https://t.me/${me.telegram_bot}" target="_blank" rel="noopener" class="mono">@${me.telegram_bot}</a></p>
        ${linked ? html`
          <div class="callout" style="background:var(--accent-soft);color:var(--ok);margin-bottom:12px"><strong>Bağlı.</strong> Uyarılar Telegram'a gönderiliyor.</div>
          <div class="btn-row"><button type="button" class="btn" data-tg-test>Test mesajı gönder</button>
            <button type="button" class="btn ghost" data-tg-unlink>Bağlantıyı kaldır</button></div>`
        : html`
          <p class="muted" style="margin:0 0 12px">Aşağıdaki düğmeye basın; Telegram açılınca <strong>Başlat</strong> (START) deyin. Bağlantı kendiliğinden kurulur.</p>
          <div class="btn-row"><button type="button" class="btn primary" data-tg-link>Telegram'ı bağla</button></div>
          <div class="hint" data-tg-wait></div>`}
        ${me.is_admin ? html`<div style="margin-top:12px"><button type="button" class="btn sm ghost" data-tg-remove>Bot anahtarını kaldır</button></div>` : ''}`}`);
  };
  const refreshMe = async () => { Object.assign(me, await api('me')); renderTg(); };
  tgBox.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.closest('[data-tg-token]');
    if (!f) return;
    tgBox.querySelector('[data-error]').textContent = '';
    try {
      const r = await api('admin/telegram', { method: 'PUT', body: formData(f) });
      toast(`Bot kaydedildi: @${r.username}`);
      await refreshMe();
    } catch (err) { tgBox.querySelector('[data-error]').textContent = err.message; }
  });
  tgBox.addEventListener('click', async (e) => {
    try {
      if (e.target.closest('[data-tg-link]')) {
        const r = await api('me/telegram/link', { method: 'POST' });
        window.open(r.url, '_blank', 'noopener');
        tgBox.querySelector('[data-tg-wait]').innerHTML = String(html`Telegram açılmadıysa <a href="${r.url}" target="_blank" rel="noopener">buraya tıklayın</a>. Başlat'a bastıktan sonra bu sayfa kendiliğinden güncellenir…`);
        clearInterval(linkTimer);
        const until = Date.now() + r.expires_in * 1000;
        linkTimer = setInterval(async () => {
          if (!document.body.contains(tgBox) || Date.now() > until) return clearInterval(linkTimer);
          const m = await api('me').catch(() => null);
          if (m?.telegram_chat_id) { clearInterval(linkTimer); Object.assign(me, m); renderTg(); toast('Telegram bağlandı.'); }
        }, 3000);
      } else if (e.target.closest('[data-tg-test]')) {
        await api('me/telegram/test', { method: 'POST' });
        toast("Test mesajı gönderildi, Telegram'a bakın.");
      } else if (e.target.closest('[data-tg-unlink]')) {
        await api('me/telegram', { method: 'DELETE' });
        await refreshMe();
      } else if (e.target.closest('[data-tg-remove]')) {
        await api('admin/telegram', { method: 'DELETE' });
        await refreshMe();
      }
    } catch (err) { toast(err.message, 'bad'); }
  });
  renderTg();

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
  return () => clearInterval(linkTimer);
}
