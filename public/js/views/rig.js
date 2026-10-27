import {
  api, html, icon, fmtHash, fmtPower, fmtTemp, fmtPct, tempClass, ago, duration, dateTime, state,
  MINER_STATUS, COMMAND_LABELS, COMMAND_STATUS, ALERT_LABELS, openDialog, confirmDialog, toast, formData, downloadUrl, confBox, wireConfBox,
} from '../lib.js';
import { navigate } from '../app.js';
import { timeChart, emptyNote } from '../charts.js';

const OC_FIELD_NAMES = { core_offset: 'Core offset (MHz)', mem_offset: 'Bellek offset (MHz)', power_limit_w: 'Güç limiti (W)', fan_pct: 'Fan (%)',
  core_clock: 'Core saat (MHz)', mem_clock: 'Bellek saat (MHz)', core_mv: 'Core voltaj (mV)', mem_mv: 'Bellek voltaj (mV)' };
const OC_LABELS = { core_offset: 'core', mem_offset: 'mem', power_limit_w: 'PL', fan_pct: 'fan', core_clock: 'core', mem_clock: 'mem', core_mv: 'mV', mem_mv: 'mem mV' };

const COMMAND_CONFIRM = {
  reboot: ['Rig yeniden başlatılsın mı?', 'Rig kapanıp açılacak. Madencilik birkaç dakika duracak.'],
  miner_stop: ['Miner durdurulsun mu?', 'Kazanç, siz tekrar başlatana kadar durur.'],
};

export async function rigView(el, [rigId]) {
  let data = null;
  let charts = [];
  let timer = null;
  let historyAt = 0;

  el.innerHTML = String(html`
    <a class="back" href="rigs">${icon('back')}Rig'ler</a>
    <div id="rig-head"></div>
    <div id="rig-tiles"></div>
    <div class="card section">
      <div class="card-head"><h2>Kartlar</h2><span class="small dim hide-sm">Satıra tıklayın: kartın 24 saatlik grafikleri</span></div>
      <div class="table-wrap" id="rig-gpus"></div>
    </div>
    <div class="card section" id="rig-tune"></div>
    <div class="charts section">
      <div class="card chart-card"><h3>Hashrate · 24 saat</h3><div class="chart-box"><canvas id="c-hash"></canvas></div></div>
      <div class="card chart-card"><h3>En yüksek sıcaklık · 24 saat</h3><div class="chart-box"><canvas id="c-temp"></canvas></div></div>
      <div class="card chart-card"><h3>Toplam güç · 24 saat</h3><div class="chart-box"><canvas id="c-power"></canvas></div></div>
    </div>
    <div class="detail-grid section" id="rig-side"></div>`);

  function renderHead() {
    const r = data.rig;
    const [label, cls] = !r.last_seen_at ? ['Bağlantı bekleniyor', 'warn'] : MINER_STATUS[r.miner_status] || MINER_STATUS.unknown;
    const running = ['running', 'starting', 'downloading'].includes(r.miner_status);
    el.querySelector('#rig-head').innerHTML = String(html`
      <div class="page-head">
        <div class="grow">
          <h1 style="display:flex;align-items:center;gap:10px"><span class="dot ${r.online ? 'ok' : 'bad'}"></span>${r.name}</h1>
          <div class="sub">
            <span class="badge ${cls}">${label}</span>
            ${r.coin ? html`<span class="badge">${r.flight_sheet} · ${r.coin}</span>` : html`<span class="badge warn">Flight sheet atanmadı</span>`}
            <span class="dim small">&nbsp;${r.online ? `Son veri ${ago(r.last_seen_at)}` : `Son görülme ${ago(r.last_seen_at)}`}</span>
          </div>
        </div>
        <div class="btn-row">
          ${running
    ? html`<button class="btn" data-cmd="miner_stop" ${r.online ? '' : 'disabled'}>${icon('stop')}Durdur</button>`
    : html`<button class="btn primary" data-cmd="miner_start" ${r.online && r.flight_sheet_id ? '' : 'disabled'}>${icon('play')}Başlat</button>`}
          <button class="btn" data-cmd="miner_restart" ${r.online && running ? '' : 'disabled'}>${icon('restart')}<span class="hide-sm">Miner'ı yeniden başlat</span></button>
          <button class="btn" data-cmd="reboot" ${r.online ? '' : 'disabled'}>${icon('power')}<span class="hide-sm">Rig'i yeniden başlat</span></button>
          <button class="btn" data-screen>${icon('rigs')}Ekranı göster</button>
          <button class="btn" data-edit>${icon('edit')}Ayarlar</button>
        </div>
      </div>`);
  }

  function renderTiles() {
    const r = data.rig;
    if (!r.last_seen_at) {
      el.querySelector('#rig-tiles').innerHTML = String(html`
        <div class="callout warn" style="margin-bottom:18px"><strong>Bu rig henüz bağlanmadı.</strong>
          İndirdiğiniz rig.conf dosyasını flash belleğin WMINING bölümüne kopyalayıp rig'i açın.
          Dosyayı kaybettiyseniz Ayarlar → "rig.conf'u yeniden oluştur".</div>`);
      return;
    }
    const total = (r.accepted || 0) + (r.rejected || 0);
    el.querySelector('#rig-tiles').innerHTML = String(html`
      ${r.miner_error ? html`<div class="callout warn" style="margin-bottom:14px"><strong>Rig'den gelen hata:</strong> ${r.miner_error}</div>` : ''}
      <div class="tiles">
        <div class="card tile"><div class="label">Hashrate${r.algo ? ` · ${r.algo}` : ''}</div><div class="value num">${r.online ? fmtHash(r.hashrate) : '—'}</div></div>
        <div class="card tile"><div class="label">Güç</div><div class="value num">${r.online ? fmtPower(r.power) : '—'}</div></div>
        <div class="card tile"><div class="label">En yüksek sıcaklık</div><div class="value num ${tempClass(r.temp_max)}">${r.online ? fmtTemp(r.temp_max) : '—'}</div></div>
        <div class="card tile"><div class="label">Share kabul / red</div>
          <div class="value num">${r.accepted || 0}<small>/ ${r.rejected || 0}${total ? ` · %${((r.rejected / total) * 100).toFixed(1)} red` : ''}</small></div></div>
      </div>`);
  }

  function renderGpus() {
    const gpus = data.gpus;
    el.querySelector('#rig-gpus').innerHTML = gpus.length ? String(html`
      <table class="num">
        <thead><tr><th class="hide-sm">#</th><th>Kart</th><th class="r">Hashrate</th><th class="r">Sıcaklık</th><th class="r hide-md">Bellek</th>
          <th class="r hide-sm">Fan</th><th class="r hide-sm">Güç</th><th class="r hide-md">Verim</th><th class="r hide-md">Core / Mem</th><th class="r hide-md">K / R</th><th class="hide-sm">OC</th></tr></thead>
        <tbody>
          ${gpus.map((g) => {
    const live = g.present && g.fresh;
    const eff = live && g.power ? `${fmtHash(g.hashrate / g.power).replace('/s', '')}/W` : '—';
    return html`
            <tr class="clickable ${g.present ? '' : 'lost'}" data-gpu="${g.id}">
              <td class="hide-sm">${g.idx}</td>
              <td><div style="display:flex;align-items:center;gap:6px"><span class="badge ${g.vendor}">${g.vendor === 'nvidia' ? 'NV' : 'AMD'}</span>
                <span class="model">${g.model}</span>${g.present ? '' : html`<span class="badge bad">Kayıp</span>`}${g.present && g.is_new ? html`<span class="badge warn">Yeni</span>` : ''}</div>
                <div class="small dim"><span class="show-sm-i">GPU ${g.idx} · </span>${g.bus_id}${g.slot ? ` · Yuva ${g.slot}` : ''} · ${g.vram_mb ? `${Math.round(g.vram_mb / 1024)} GB` : '?'}${g.driver ? ` · ${g.driver}` : ''}</div></td>
              <td class="r">${live ? fmtHash(g.hashrate) : '—'}${live ? html`<div class="small dim show-sm">${fmtPower(g.power)} · ${fmtPct(g.fan)}</div>` : ''}</td>
              <td class="r ${live ? tempClass(g.temp) : ''}">${live ? fmtTemp(g.temp) : '—'}</td>
              <td class="r hide-md ${live ? tempClass(g.mem_temp, (state.me?.temp_limit ?? 80) + 20) : ''}">${live && g.mem_temp !== null ? fmtTemp(g.mem_temp) : '—'}</td>
              <td class="r hide-sm">${live ? fmtPct(g.fan) : '—'}</td>
              <td class="r hide-sm">${live ? fmtPower(g.power) : '—'}</td>
              <td class="r hide-md">${eff}</td>
              <td class="r hide-md">${live ? `${g.core_clk ?? '—'} / ${g.mem_clk ?? '—'}` : '—'}</td>
              <td class="r hide-md">${live ? `${g.accepted ?? 0} / ${g.rejected ?? 0}` : '—'}</td>
              <td class="hide-sm">${g.oc_source === 'card' ? html`<span class="badge ok" title="Bu karta özel değerler">${fmtParams(g.oc_params)}</span>`
      : g.oc_name ? html`<span class="badge" title="${g.oc_source === 'gpu' ? 'Karta atanmış profil' : 'Model ataması'}">${g.oc_name}</span>` : html`<span class="dim small">Stok</span>`}</td>
            </tr>`;
  })}
        </tbody>
      </table>
      ${gpus.some((g) => !g.present) ? html`<div class="small dim" style="padding:10px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        Kayıp kartlar artık bu rig'de görünmüyor (çıkarıldı ya da flash başka makineye takıldı).
        <button class="btn sm" data-clear-lost>Kayıp kartları sil</button></div>` : ''}`) : String(html`<div class="empty">Agent henüz kart bilgisi göndermedi.</div>`);
  }

  const PHASES = { baseline: 'Taban ölçüm', mem: 'Bellek', power: 'Güç limiti', core: 'Çekirdek', voltage: 'Voltaj', final: 'Bitiriliyor' };
  const fmtParams = (p) => Object.entries(p || {}).map(([k, v]) => `${OC_LABELS[k] || k} ${v}`).join(' · ') || 'stok';
  const pct = (a, b) => (a && b ? ` (%${((a / b - 1) * 100).toFixed(1)})` : '');

  // Kart kart denenen değerler: ne denendi, hashrate/güç ne oldu, kararlı mıydı
  function historyTable(cards) {
    const rows = (cards || []).flatMap((c) => (c.history || []).map((h, i) => ({ ...h, idx: c.idx, n: i + 1 })));
    if (!rows.length) return '';
    return html`<details style="margin-top:10px" open><summary class="small" style="cursor:pointer">Denenen değerler (${rows.length})</summary>
      <div class="table-wrap" style="margin-top:6px"><table class="num">
        <thead><tr><th>GPU</th><th>Aşama</th><th>Değerler</th><th class="r">Hashrate</th><th class="r hide-sm">Güç</th><th class="r hide-sm">Verim</th><th>Sonuç</th></tr></thead>
        <tbody>${rows.map((h) => html`<tr><td>${h.idx}</td><td class="small">${PHASES[h.phase] || h.phase}</td><td class="mono small">${fmtParams(h.params)}</td>
          <td class="r">${fmtHash(h.hash)}</td><td class="r hide-sm">${fmtPower(h.power)}</td>
          <td class="r hide-sm small">${h.hash && h.power ? `${(h.hash / 1e6 / h.power * 1000).toFixed(0)} kH/W` : '—'}</td>
          <td>${h.ok ? html`<span class="badge ok">Kararlı</span>` : html`<span class="badge bad" title="${h.why || ''}">${h.why || 'Kararsız'}</span>`}</td></tr>`)}</tbody>
      </table></div></details>`;
  }

  function renderTune() {
    const r = data.rig;
    const t = r.tune;
    const box = el.querySelector('#rig-tune');
    const canStart = r.online && r.miner_status === 'running';
    if (!t || t.status === 'cancelled') {
      box.innerHTML = String(html`
        <div class="card-head"><h2>Otomatik OC</h2><span class="small dim hide-sm">Her kartı ayrı ayrı dener, her karta kendi en verimli kararlı değerini önerir</span></div>
        <ul class="list-plain">${data.models.map((m) => html`<li>
          <span class="badge ${m.vendor}">${m.vendor === 'nvidia' ? 'NV' : 'AMD'}</span><span class="grow">${m.model} <span class="dim">×${m.count}</span></span>
          <button class="btn sm" data-tune="${m.model}" ${canStart ? '' : 'disabled'}>${icon('oc')}Otomatik bul</button></li>`)}</ul>
        ${canStart ? '' : html`<div class="small dim" style="padding:0 16px 12px">Başlatmak için rig çevrimiçi ve miner çalışıyor olmalı.</div>`}`);
      return;
    }
    if (t.status === 'queued' || t.status === 'running') {
      const stale = t.status === 'running' && (!r.online || Date.now() / 1000 - (t.updated_at || 0) > 90);
      const el2 = t.step_elapsed ?? null;
      const settling = el2 !== null && el2 < (t.settle_sec || 0);
      const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
      box.innerHTML = String(html`
        <div class="card-head"><h2>Otomatik OC sürüyor · ${t.model}</h2><button class="btn sm danger" data-tune-cancel>${icon('stop')}İptal</button></div>
        <div class="card-pad">
          ${t.status === 'queued' ? html`<p class="muted" style="margin:0">Komut rig'e gönderiliyor…</p>` : html`
          ${stale ? html`<div class="callout warn" style="margin-bottom:10px">Rig'den ${r.online ? '90 sn\'dir' : 'şu an'} haber yok. Rig yeniden başladıysa otomatik OC yarıda kalmıştır; rig bağlanınca durum güncellenir. "İptal" ile bu kaydı hemen kapatabilirsiniz.</div>` : ''}
          ${el2 !== null ? html`<div style="margin-bottom:10px">
            <div class="small" style="display:flex;justify-content:space-between"><span>Adım ${t.step + 1} · ${settling ? 'değerler oturuyor (ölçüm sayılmaz)' : 'ölçülüyor'}</span>
              <span class="dim">${mmss(el2)} / ${mmss(t.step_sec)}</span></div>
            <div style="height:6px;border-radius:3px;background:var(--border);overflow:hidden;margin-top:4px">
              <div style="height:100%;width:${Math.min(100, Math.round((el2 / (t.step_sec || 1)) * 100))}%;background:var(--accent)"></div></div></div>` : ''}
          <dl class="kv" style="max-width:560px">
            ${t.mode === 'isolate' ? html`<dt>Durum</dt><dd><span class="t-warn">miner çöktü, sorumlu kart aranıyor (GPU ${(t.isolating || []).join(', ')})</span></dd>` : ''}
            <dt>Toplam hashrate</dt><dd>${t.baseline_hash ? html`${fmtHash(t.baseline_hash)} → ${fmtHash(t.best_hash)}${pct(t.best_hash, t.baseline_hash)}` : 'ilk ölçüm bekleniyor'}</dd>
            <dt>Toplam güç</dt><dd>${t.baseline_power ? html`${fmtPower(t.baseline_power)} → ${fmtPower(t.best_power)}` : '—'}</dd>
            <dt>Kalan (tahmini)</dt><dd>${t.eta_sec ? `~${Math.ceil(t.eta_sec / 60)} dk` : '—'}</dd>
          </dl>
          ${(t.card_list || []).length ? html`<div class="table-wrap" style="margin-top:10px"><table class="num">
            <thead><tr><th>GPU</th><th>Aşama</th><th>Şu an denenen</th><th class="r">Şu anki ölçüm</th><th class="r hide-sm">En iyi kararlı</th></tr></thead>
            <tbody>${t.card_list.map((c) => html`<tr><td>${c.idx}</td><td>${c.done ? html`<span class="badge ok">Bitti</span>` : PHASES[c.phase] || c.phase}</td>
              <td class="mono small">${fmtParams(c.current)}</td>
              <td class="r">${c.live ? html`${fmtHash(c.live.hash)}<div class="small dim">${fmtPower(c.live.power)}</div>` : html`<span class="dim small">${settling ? 'bekleniyor' : '—'}</span>`}</td>
              <td class="r hide-sm">${c.hash ? html`${fmtHash(c.hash)}<div class="small dim mono">${fmtParams(c.good)}</div>` : '—'}</td></tr>`)}</tbody>
          </table></div>
          ${historyTable(t.card_list)}` : ''}`}
          <p class="small dim" style="margin:10px 0 0">Her adım ${t.step_sec ? Math.round(t.step_sec / 60) : 3} dk sürer. Bu sırada rig'i ya da miner'ı yeniden başlatmayın; başlatırsanız deneme yarıda kalır.
            Kararsızlık görülürse kart kendiliğinden son sağlam değere döner.</p>
        </div>`);
      return;
    }
    if (t.status === 'done' && t.result && Array.isArray(t.result.cards)) {
      const res = t.result;
      box.innerHTML = String(html`
        <div class="card-head"><h2>Otomatik OC tamamlandı · ${res.model}</h2><button class="btn sm ghost" data-tune-dismiss>Kapat</button></div>
        <div class="card-pad">
          ${res.before ? html`<p style="margin:0 0 10px"><strong>Toplam:</strong> ${fmtHash(res.before.hash)} / ${fmtPower(res.before.power)} → ${fmtHash(res.after.hash)} / ${fmtPower(res.after.power)}
            · verim ${pct(res.after.hash / res.after.power, res.before.hash / res.before.power).replace(/[()]/g, '')}</p>` : ''}
          <div class="table-wrap"><table class="num">
            <thead><tr><th>GPU</th><th>Önerilen (bu karta özel)</th><th class="r">Hashrate</th><th class="r">Güç</th></tr></thead>
            <tbody>${res.cards.map((c) => html`<tr>
              <td>${c.idx}${c.start_was_unstable ? html` <span class="badge warn" title="Kartın eski değeri kararsızdı, güvenli değerlerden başlandı">!</span>` : ''}</td>
              <td class="mono small">${c.failed ? html`<span class="t-bad">${c.failed}</span>` : fmtParams(c.params)}</td>
              <td class="r">${c.before ? html`${fmtHash(c.before.hash)} → ${fmtHash(c.after.hash)}` : '—'}</td>
              <td class="r">${c.before ? html`${fmtPower(c.before.power)} → ${fmtPower(c.after.power)}` : '—'}</td></tr>`)}</tbody>
          </table></div>
          ${historyTable(res.cards)}
          <p class="small muted" style="margin:10px 0">Her kart kendi değerini aldı. Uygulayana kadar kartlar eski ayarlarıyla çalışır.</p>
          <div class="btn-row"><button class="btn primary" data-tune-apply-cards>${icon('apply')}Her karta kendi değerini uygula</button></div>
        </div>`);
      return;
    }
    if (t.status === 'done' && t.result) {
      const res = t.result;
      box.innerHTML = String(html`
        <div class="card-head"><h2>Otomatik OC tamamlandı · ${res.model}</h2><button class="btn sm ghost" data-tune-dismiss>Kapat</button></div>
        <div class="card-pad">
          <dl class="kv" style="max-width:560px">
            <dt>Önerilen</dt><dd class="mono">${fmtParams(res.params)}</dd>
            ${res.before ? html`<dt>Hashrate</dt><dd>${fmtHash(res.before.hash)} → ${fmtHash(res.after.hash)}${pct(res.after.hash, res.before.hash)}</dd>
            <dt>Güç</dt><dd>${fmtPower(res.before.power)} → ${fmtPower(res.after.power)}${pct(res.after.power, res.before.power)}</dd>
            <dt>Verim</dt><dd>${pct(res.after.hash / res.after.power, res.before.hash / res.before.power).replace(/[()]/g, '')}</dd>` : ''}
          </dl>
          <p class="small muted" style="margin:10px 0">Öneri OC profillerine kaydedildi. Uygulayana kadar kartlar eski ayarlarıyla çalışır.</p>
          <div class="btn-row"><button class="btn primary" data-tune-apply="${t.result_profile_id}" data-model="${res.model}" ${t.result_profile_id ? '' : 'disabled'}>${icon('apply')}Bu modele uygula</button></div>
        </div>`);
      return;
    }
    box.innerHTML = String(html`
      <div class="card-head"><h2>Otomatik OC tamamlanamadı${t.model ? ` · ${t.model}` : ''}</h2><button class="btn sm ghost" data-tune-dismiss>Kapat</button></div>
      <div class="card-pad"><div class="callout warn">${t.message || 'Bilinmeyen bir sorun oluştu.'}</div>${historyTable(t.card_list)}</div>`);
  }

  // Komut sonucu: kısa olan satırda, uzun olan (miner kaydı, otomatik OC verisi) açılır kutuda; satırlar kırılır
  function commandResult(c) {
    if (!c.result) return '';
    const text = c.result;
    if (c.type === 'oc_tune') {
      try {
        const r = JSON.parse(text);
        if (r.summary) return html`<div class="small dim">${r.summary}</div>`;
        if (Array.isArray(r.cards)) { // özetsiz sonuç: kart kart ne olduğu
          const bad = r.cards.filter((c) => c.failed);
          return html`<div class="small dim">${r.cards.length}× ${r.model || 'kart'} · ${r.algo || ''}${bad.length ? html` · <span class="t-warn">${bad.length} kart sorunlu</span>` : ' · tamamlandı'}</div>
            ${bad.map((c) => html`<div class="small dim" style="overflow-wrap:anywhere">GPU ${c.idx} (${c.bus_id}): ${c.failed}</div>`)}`;
        }
      } catch { /* düz yazı */ }
    }
    if (text.length <= 160 && !text.includes('\n')) return html`<div class="small dim" style="overflow-wrap:anywhere">${text}</div>`;
    return html`<details><summary class="small dim" style="cursor:pointer">Çıktıyı göster (${text.split('\n').length} satır)</summary><pre class="cmd-out">${text}</pre></details>`;
  }

  function renderSide() {
    const r = data.rig;
    el.querySelector('#rig-side').innerHTML = String(html`
      <div class="grid">
        <div class="card">
          <div class="card-head"><h2>Son komutlar</h2></div>
          ${data.commands.length ? html`<ul class="list-plain">
            ${data.commands.map((c) => {
    const [l, cls] = COMMAND_STATUS[c.status] || ['?', ''];
    return html`<li style="align-items:flex-start"><span class="grow">${COMMAND_LABELS[c.type] || c.type}${c.cmd ? html` <span class="mono small">${c.cmd}</span>` : ''}${commandResult(c)}</span>
                <span class="small dim">${dateTime(c.created_at)}</span><span class="badge ${cls}">${l}</span></li>`;
  })}</ul>` : html`<div class="empty small">Henüz komut gönderilmedi.</div>`}
        </div>
        <div class="card">
          <div class="card-head"><h2>Uyarılar</h2><a class="small" href="alerts">Tümü</a></div>
          ${data.alerts.length ? html`<ul class="list-plain">
            ${data.alerts.map((a) => html`<li>
              <span class="dot ${a.resolved_at ? '' : a.severity === 'critical' ? 'bad' : 'warn'}"></span>
              <span class="grow"><strong>${ALERT_LABELS[a.type] || a.type}</strong> <span class="muted">${a.message}</span></span>
              <span class="small dim">${a.resolved_at ? `Düzeldi ${ago(a.resolved_at)}` : ago(a.started_at)}</span></li>`)}</ul>`
    : html`<div class="empty small">Uyarı yok.</div>`}
        </div>
      </div>
      <div class="card card-pad">
        <h2 style="margin-bottom:12px">Sistem</h2>
        <dl class="kv">
          <dt>Miner çalışma süresi</dt><dd>${r.online && r.miner_status === 'running' ? duration(r.miner_uptime_sec) : '—'}</dd>
          <dt>CPU</dt><dd title="${r.cpu_model || ''}">${r.cpu_model || '—'}</dd>
          <dt>CPU yükü</dt><dd>${r.cpu_load !== null && r.online ? r.cpu_load.toFixed(2) : '—'}</dd>
          <dt>RAM</dt><dd>${r.ram_total_mb ? `${r.ram_used_mb ?? '?'} / ${r.ram_total_mb} MB` : '—'}</dd>
          <dt>İşletim sistemi</dt><dd title="${r.os_info || ''}">${r.os_info || '—'}</dd>
          <dt>Agent sürümü</dt><dd>${r.agent_version || '—'}</dd>
          <dt>IP</dt><dd>${r.last_ip || '—'}</dd>
          <dt>Ayar sürümü</dt><dd>v${r.config_version}</dd>
          <dt>Eklenme</dt><dd>${dateTime(r.paired_at)}</dd>
          <dt>Rig ID</dt><dd class="mono" title="${r.id}">${r.id.slice(0, 8)}…</dd>
        </dl>
      </div>`);
  }

  function destroyCharts() { charts.forEach((c) => c?.destroy()); charts = []; }

  async function loadHistory() {
    const h = await api(`rigs/${rigId}/history?hours=24`);
    historyAt = Date.now();
    destroyCharts();
    const limit = state.me?.temp_limit ?? 80;
    const specs = [
      ['#c-hash', { points: h.rig.map((p) => [p[0], p[1]]), colorVar: '--series-1', label: 'Hashrate', format: fmtHash }],
      ['#c-temp', { points: h.rig.filter((p) => p[3] !== null).map((p) => [p[0], p[3]]), colorVar: '--series-2', label: 'Sıcaklık', format: fmtTemp, fill: false, ref: { value: limit, label: 'Sınır' }, suggestedMax: limit + 5 }],
      ['#c-power', { points: h.rig.map((p) => [p[0], p[2]]), colorVar: '--series-7', label: 'Güç', format: fmtPower }],
    ];
    for (const [sel, opts] of specs) {
      const canvas = el.querySelector(sel);
      if (!canvas) continue;
      if (opts.points.length < 2) emptyNote(canvas, 'Grafik için en az 10 dakikalık veri gerekiyor');
      else charts.push(timeChart(canvas, opts));
    }
  }

  async function load() {
    data = await api(`rigs/${rigId}`);
    renderHead(); renderTiles(); renderGpus(); renderTune(); renderSide();
    if (Date.now() - historyAt > 60_000) await loadHistory();
  }

  async function sendCommand(type) {
    const tuning = data.rig.tune?.status === 'running' && ['reboot', 'miner_restart', 'miner_stop'].includes(type);
    const c = tuning ? ['Otomatik OC yarıda kalacak', `Otomatik OC şu an çalışıyor. "${COMMAND_LABELS[type]}" derseniz deneme yarıda kalır ve baştan başlatmanız gerekir. Yine de devam edilsin mi?`]
      : COMMAND_CONFIRM[type];
    if (c && !(await confirmDialog(c[0], c[1], 'Evet'))) return;
    try {
      await api(`rigs/${rigId}/commands`, { method: 'POST', body: { type } });
      toast(`${COMMAND_LABELS[type]} komutu gönderildi.`);
      await load();
    } catch (err) { toast(err.message, 'bad'); }
  }

  async function editDialog() {
    const [{ flight_sheets: sheets }, { oc_profiles: ocs }] = await Promise.all([api('flight-sheets'), api('oc-profiles')]);
    const r = data.rig;
    const opt = (list, sel) => list.map((x) => html`<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${x.name}</option>`);
    openDialog({
      title: 'Rig ayarları',
      body: html`
        <div class="field"><label>Rig adı</label><input class="input" name="name" value="${r.name}" maxlength="40" required></div>
        <div class="field"><label>Flight sheet</label>
          <select name="flight_sheet_id"><option value="">— Yok (miner çalışmaz) —</option>${opt(sheets, r.flight_sheet_id)}</select>
          ${sheets.length ? '' : html`<span class="hint">Önce <a href="flight-sheets">flight sheet</a> oluşturun.</span>`}</div>
        <div class="field"><label>OC profili (kart modeline göre)</label>
          ${data.models.length ? html`<div class="oc-models">${data.models.map((m) => html`
            <div class="oc-model-row"><span><span class="badge ${m.vendor}">${m.vendor === 'nvidia' ? 'NV' : 'AMD'}</span> ${m.model} <span class="dim">×${m.count}</span></span>
              <select data-oc-model="${m.model}"><option value="">Stok ayarlar</option>${opt(ocs.filter((o) => o.vendor === m.vendor), m.oc_profile_id)}</select></div>`)}</div>`
    : html`<span class="hint">Rig kartlarını bildirdiğinde burada model başına OC seçebilirsiniz.</span>`}
          <span class="hint">Profil sadece seçilen modele uygulanır. Sonradan takılan farklı bir model stok ayarla başlar. Karta özel OC için kart satırına tıklayın.</span></div>
        <hr style="border:0;border-top:1px solid var(--border);margin:4px 0">
        <div class="btn-row">
          ${r.has_conf ? html`<button type="button" class="btn sm" data-conf-show>${icon('download')}rig.conf indir</button>` : ''}
          <button type="button" class="btn sm" data-rotate>${icon('restart')}rig.conf'u yeniden oluştur</button>
          <button type="button" class="btn danger sm" data-delete>${icon('trash')}Rig'i hesaptan kaldır</button></div>
        <span class="hint">Yeniden oluşturunca eski rig.conf hemen geçersiz olur; yeni dosyayı flash'a kopyalayana kadar rig bağlanamaz.</span>`,
      onOpen: (dlg) => {
        dlg.querySelector('[data-conf-show]')?.addEventListener('click', async () => {
          const res = await api(`rigs/${rigId}/rig-conf-text`);
          dlg.close();
          openDialog({
            title: 'rig.conf',
            body: html`<p class="muted" style="margin:0">Dosyayı flash belleğin <strong>WMINING</strong> bölümüne kopyalayın.</p>${confBox(res)}`,
            onOpen: (d) => { wireConfBox(d); downloadUrl(res.conf_url); },
          });
        });
        dlg.querySelector('[data-rotate]').addEventListener('click', async () => {
          dlg.close();
          if (!(await confirmDialog('rig.conf yeniden oluşturulsun mu?', `"${r.name}" için yeni anahtar üretilecek. Eski rig.conf ile bağlanan rig, yeni dosya flash'a kopyalanana kadar bağlanamaz.`, 'Yeniden oluştur'))) return;
          const res = await api(`rigs/${rigId}/rotate-secret`, { method: 'POST' });
          await load();
          openDialog({
            title: 'Yeni rig.conf',
            body: html`<p class="muted" style="margin:0">Dosyayı flash belleğin <strong>WMINING</strong> bölümüne kopyalayın (eskisinin üzerine yazın).</p>${confBox(res)}`,
            onOpen: (d) => { wireConfBox(d); downloadUrl(res.conf_url); },
          });
        });
        dlg.querySelector('[data-delete]').addEventListener('click', async () => {
        dlg.close();
        if (!(await confirmDialog('Rig kaldırılsın mı?', `"${r.name}" hesabınızdan kaldırılacak ve geçmiş verisi silinecek. Tekrar eklemek için rig'i yeniden başlatıp yeni kodla eşleştirmeniz gerekir.`, 'Kaldır'))) return;
        await api(`rigs/${rigId}`, { method: 'DELETE' });
        toast('Rig kaldırıldı.');
        navigate('rigs');
        });
      },
      onSubmit: async (form) => {
        const f = formData(form);
        const ocModels = Object.fromEntries([...form.querySelectorAll('[data-oc-model]')].map((sel) => [sel.dataset.ocModel, sel.value || null]));
        await api(`rigs/${rigId}`, { method: 'PUT', body: { name: f.name, flight_sheet_id: f.flight_sheet_id || null, oc_models: ocModels } });
        toast('Ayarlar kaydedildi, rig\'e gönderiliyor.');
        await load();
      },
    });
  }

  async function tuneAction(b) {
    if (b.dataset.tune) {
      const m = data.models.find((x) => x.model === b.dataset.tune);
      const ok = await confirmDialog(`${m.model} için otomatik OC başlatılsın mı?`,
        `${m.count} kartın HER BİRİ için bellek, güç limiti ve ${m.vendor === 'amd' ? 'voltaj' : 'çekirdek'} değerleri ayrı ayrı denenecek (genelde 30–60 dk; kartlar miner'ı çökertirse 2 saate kadar). `
        + 'Bu sürede hashrate dalgalanabilir. Kararsızlık, çökme ya da sıcaklık sınırı aşılırsa son sağlam değere dönülür. Sonuç size öneri olarak sunulur.',
        'Başlat', false);
      if (!ok) return;
      await api(`rigs/${rigId}/oc-tune`, { method: 'POST', body: { model: m.model } });
      toast('Otomatik OC başlatıldı.');
    } else if (b.hasAttribute('data-tune-cancel')) {
      if (!(await confirmDialog('Otomatik OC iptal edilsin mi?', 'Kartlar başlangıç değerlerine döner.', 'İptal et'))) return;
      await api(`rigs/${rigId}/oc-tune/cancel`, { method: 'POST' });
      toast('İptal ediliyor.');
    } else if (b.hasAttribute('data-tune-dismiss')) {
      await api(`rigs/${rigId}/oc-tune/dismiss`, { method: 'POST' });
    } else if (b.hasAttribute('data-tune-apply-cards')) {
      const r = await api(`rigs/${rigId}/oc-tune/apply`, { method: 'POST' });
      toast(`${r.applied} karta kendi değeri uygulandı, rig'e gönderiliyor.`);
    } else if (b.dataset.tuneApply) {
      await api(`rigs/${rigId}`, { method: 'PUT', body: { oc_models: { [b.dataset.model]: Number(b.dataset.tuneApply) } } });
      await api(`rigs/${rigId}/oc-tune/dismiss`, { method: 'POST' });
      toast("Profil uygulandı, rig'e gönderiliyor.");
    }
    await load();
  }

  async function gpuDialog(gpuId) {
    const g = data.gpus.find((x) => x.id === gpuId);
    if (!g) return;
    const [{ oc_profiles: ocs, fields }, h] = await Promise.all([api('oc-profiles'), api(`rigs/${rigId}/history?hours=24`)]);
    const shown = g.oc_params || g.oc_effective || {};
    const points = h.gpus[gpuId] || [];
    const gpuCharts = [];
    const dlg = openDialog({
      title: `GPU ${g.idx} · ${g.model}`,
      wide: true,
      body: html`
        <div class="small dim"><span class="show-sm-i">GPU ${g.idx} · </span>${g.bus_id}${g.slot ? ` · Yuva ${g.slot}` : ''} · ${g.vram_mb ? `${Math.round(g.vram_mb / 1024)} GB` : ''} ${g.vbios ? `· VBIOS ${g.vbios}` : ''} ${g.driver ? `· Sürücü ${g.driver}` : ''}</div>
        <div class="gpu-charts">
          <div><h3 class="small muted">Hashrate</h3><div class="chart-box" style="height:150px"><canvas data-c="1"></canvas></div></div>
          <div><h3 class="small muted">Sıcaklık</h3><div class="chart-box" style="height:150px"><canvas data-c="2"></canvas></div></div>
          <div><h3 class="small muted">Güç</h3><div class="chart-box" style="height:150px"><canvas data-c="4"></canvas></div></div>
          <div><h3 class="small muted">Fan</h3><div class="chart-box" style="height:150px"><canvas data-c="3"></canvas></div></div>
        </div>
        <div>
          <h3 style="margin-bottom:6px">Bu kartın OC değerleri</h3>
          <p class="small muted" style="margin:0 0 10px">Şu an: <strong>${g.oc_source === 'card' ? 'karta özel değerler' : g.oc_name ? `profil (${g.oc_name})` : 'stok'}</strong>.
            Alanlar şu anki değerlerle dolu; değiştirip kaydederseniz bu değerler sadece bu karta uygulanır (aynı model diğer kartlar etkilenmez). Boş alan = stok.</p>
          <div class="form-grid">${Object.entries(fields[g.vendor]).map(([k, [min, max]]) => html`
            <div class="field"><label>${OC_FIELD_NAMES[k] || k}</label>
              <input class="input num" type="number" name="own_${k}" min="${min}" max="${max}" step="1" value="${shown[k] ?? ''}" placeholder="stok">
              <span class="hint">${min} … ${max}</span></div>`)}</div>
          ${g.oc_params ? html`<button type="button" class="btn sm" data-clear-own style="margin-top:8px">${icon('x')}Karta özel değerleri kaldır</button>` : ''}
        </div>
        <div class="field"><label>Ya da bu karta bir OC profili ata</label>
          <select name="oc_profile_id"><option value="">Model atamasını kullan</option>
            ${ocs.filter((o) => o.vendor === g.vendor).map((o) => html`<option value="${o.id}" ${o.id === g.oc_profile_id ? 'selected' : ''}>${o.name}</option>`)}</select>
          <span class="hint">Öncelik: karta özel değerler → karta atanan profil → model profili.</span></div>`,
      onOpen: (d) => {
        d.querySelector('[data-clear-own]')?.addEventListener('click', async () => {
          await api(`rigs/${rigId}/gpus/${gpuId}`, { method: 'PUT', body: { oc_params: null } });
          toast('Karta özel değerler kaldırıldı.');
          d.close();
          await load();
        });
        const spec = { 1: ['--series-1', 'Hashrate', fmtHash], 2: ['--series-2', 'Sıcaklık', fmtTemp], 3: ['--series-3', 'Fan', fmtPct], 4: ['--series-7', 'Güç', fmtPower] };
        d.querySelectorAll('canvas[data-c]').forEach((c) => {
          const i = Number(c.dataset.c);
          const pts = points.filter((p) => p[i] !== null).map((p) => [p[0], p[i]]);
          if (pts.length < 2) return emptyNote(c);
          const [colorVar, label, format] = spec[i];
          gpuCharts.push(timeChart(c, { points: pts, colorVar, label, format, fill: i === 1 || i === 4, suggestedMax: i === 3 ? 100 : undefined }));
        });
      },
      onSubmit: async (form) => {
        const ownParams = {};
        let changed = false;
        for (const k of Object.keys(fields[g.vendor])) {
          const v = form[`own_${k}`].value;
          if (v !== '') ownParams[k] = Number(v);
          if (v !== String(shown[k] ?? '')) changed = true;
        }
        const body = { oc_profile_id: form.oc_profile_id.value || null };
        // Alanlara dokunulmadıysa karta özel değer oluşturma (profil/model ataması geçerli kalsın)
        if (changed || g.oc_params) body.oc_params = Object.keys(ownParams).length ? ownParams : null;
        await api(`rigs/${rigId}/gpus/${gpuId}`, { method: 'PUT', body });
        toast("Kart OC ayarı kaydedildi, rig'e gönderiliyor.");
        await load();
      },
    });
    dlg.addEventListener('close', () => gpuCharts.forEach((c) => c?.destroy()));
  }

  // Rig'in monitöründeki canlı ekran + miner çıktısı (agent 1.0.6+). Pencere açıkken 3 sn'de bir yenilenir.
  function screenDialog() {
    let poll = null;
    const pre = 'margin:0;padding:12px;border-radius:8px;background:#0d1117;color:#d1d7e0;font:12px/1.45 ui-monospace,Consolas,monospace;'
      + 'white-space:pre;overflow:auto;flex-shrink:0';
    openDialog({
      title: 'Rig ekranı',
      wide: true,
      body: html`
        <div class="small muted" data-screen-meta>Rig'den ekran isteniyor…</div>
        <pre data-screen-text style="${pre};min-height:180px">Bekleniyor… (rig birkaç saniye içinde göndermeye başlar)</pre>
        <h3 style="margin:4px 0 0">Komut</h3>
        <pre data-term style="${pre};max-height:260px;display:none"></pre>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input class="input mono" data-term-input placeholder="Komut yazın, Enter'a basın (ör. miner restart, nvidia-smi) · liste: yardim"
            autocomplete="off" spellcheck="false" style="flex:1;min-width:220px">
          <button type="button" class="btn" data-term-send>Gönder</button>
        </div>
        <div class="btn-row" style="gap:6px">${['miner restart', 'miner stop', 'miner start', 'nvidia-smi', 'miner log', 'sreboot'].map((c) =>
          html`<button type="button" class="btn sm" data-term-quick="${c}">${c}</button>`)}</div>
        <h3 style="margin:4px 0 0">Miner çıktısı</h3>
        <pre data-screen-log style="${pre};max-height:260px"></pre>`,
      onOpen: (dlg) => {
        const meta = dlg.querySelector('[data-screen-meta]');
        const textEl = dlg.querySelector('[data-screen-text]');
        const logEl = dlg.querySelector('[data-screen-log]');
        const tick = async () => {
          try {
            const s = await api(`rigs/${rigId}/screen`);
            const age = s.at ? s.server_time - s.at : null;
            const old = /^1\.0\.[0-5]$/.test(s.agent_version || '');
            meta.textContent = !s.online ? 'Rig çevrimdışı. Aşağıdaki son görüntü.'
              : old ? `Bu özellik agent 1.0.6 ile geliyor (rig'de ${s.agent_version}). Rig güncellenince ekran burada görünür.`
              : age === null || age > 20 ? 'Rig ekran göndermeye başlıyor… (10 sn kadar sürebilir)'
              : `Canlı · ${age} sn önce güncellendi`;
            if (s.text) textEl.textContent = s.text;
            if (s.log !== null && s.log !== undefined) {
              const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
              logEl.textContent = s.log || '(miner çalışmıyor)';
              if (atBottom) logEl.scrollTop = logEl.scrollHeight;
            }
          } catch (err) { meta.textContent = err.message; }
        };
        tick();
        poll = setInterval(tick, 3000);

        // Komut satırı: izinli komutlar rig'e gider, çıktısı burada görünür
        const term = dlg.querySelector('[data-term]');
        const input = dlg.querySelector('[data-term-input]');
        const print = (text) => {
          term.style.display = '';
          term.textContent += `${term.textContent ? '\n' : ''}${text}`;
          term.scrollTop = term.scrollHeight;
        };
        const HELP = ['miner start · miner stop · miner restart · miner log · miner api (miner\'ın ham verisi)', 'oc (OC değerlerini tekrar uygula) · sreboot (rig\'i yeniden başlat)',
          'nvidia-smi · clinfo (AMD OpenCL) · lspci (kartlar) · yuva (kartın takılı olduğu yuva) · dmesg (sistem hataları)',
          'uptime · free · df · ip · ping · log (agent kaydı) · bilgi · guncelle'].join('\n');
        let busy = false;
        const run = async (line) => {
          line = line.trim();
          if (!line || busy) return;
          if (['yardim', 'yardım', 'help', 'wm yardim'].includes(line.toLowerCase())) return print(`$ ${line}\n${HELP}`);
          if (['sreboot', 'reboot'].includes(line.toLowerCase())
            && !(await confirmDialog('Rig yeniden başlatılsın mı?', 'Miner durur, rig birkaç dakika içinde tekrar açılır.', 'Yeniden başlat'))) return;
          busy = true;
          print(`$ ${line}`);
          try {
            const { id } = await api(`rigs/${rigId}/console`, { method: 'POST', body: { line } });
            const until = Date.now() + 60_000;
            for (;;) {
              await new Promise((r) => setTimeout(r, 1500));
              const c = await api(`rigs/${rigId}/commands/${id}`);
              if (c.status === 'done' || c.status === 'failed' || c.status === 'expired') {
                print(c.result || (c.status === 'done' ? '(tamam)' : `(${c.status})`));
                break;
              }
              if (Date.now() > until) { print('(rig 60 sn içinde yanıt vermedi; sonuç sonra "Son komutlar"da görünür)'); break; }
            }
          } catch (err) { print(`! ${err.message}`); } finally { busy = false; }
        };
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          run(input.value);
          input.value = '';
        });
        dlg.querySelector('[data-term-send]').addEventListener('click', () => { run(input.value); input.value = ''; });
        dlg.querySelectorAll('[data-term-quick]').forEach((b) => b.addEventListener('click', () => run(b.dataset.termQuick)));
        dlg.addEventListener('close', () => clearInterval(poll));
      },
    });
  }

  el.addEventListener('click', (e) => {
    const cmd = e.target.closest('[data-cmd]');
    if (cmd && !cmd.disabled) return sendCommand(cmd.dataset.cmd);
    if (e.target.closest('[data-edit]')) return editDialog().catch((err) => toast(err.message, 'bad'));
    if (e.target.closest('[data-screen]')) return screenDialog();
    const tb = e.target.closest('[data-tune],[data-tune-cancel],[data-tune-dismiss],[data-tune-apply],[data-tune-apply-cards]');
    if (tb && !tb.disabled) return tuneAction(tb).catch((err) => toast(err.message, 'bad'));
    if (e.target.closest('[data-clear-lost]')) {
      return (async () => {
        const n = data.gpus.filter((g) => !g.present).length;
        if (!(await confirmDialog('Kayıp kartlar silinsin mi?', `${n} kart listeden ve geçmişten silinecek. Kart tekrar takılırsa yeni kart olarak görünür.`, 'Sil'))) return;
        await api(`rigs/${rigId}/lost-gpus`, { method: 'DELETE' });
        toast('Kayıp kartlar silindi.');
        await load();
      })().catch((err) => toast(err.message, 'bad'));
    }
    const row = e.target.closest('[data-gpu]');
    if (row) gpuDialog(Number(row.dataset.gpu)).catch((err) => toast(err.message, 'bad'));
  });

  try {
    await load();
  } catch (err) {
    if (err.status === 404) {
      el.innerHTML = String(html`<div class="card empty"><h2>Rig bulunamadı</h2><a class="btn" href="rigs">Rig'lere dön</a></div>`);
      return null;
    }
    throw err;
  }
  const onTheme = () => { historyAt = 0; loadHistory().catch(() => {}); };
  window.addEventListener('themechange', onTheme);
  timer = setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]')) load().catch(() => {}); }, 10_000);
  return () => { clearInterval(timer); destroyCharts(); window.removeEventListener('themechange', onTheme); };
}
