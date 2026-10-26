import {
  api, html, icon, fmtHash, fmtPower, fmtTemp, fmtPct, tempClass, ago, duration, dateTime, state,
  MINER_STATUS, COMMAND_LABELS, COMMAND_STATUS, ALERT_LABELS, openDialog, confirmDialog, toast, formData, downloadText,
} from '../lib.js';
import { navigate } from '../app.js';
import { timeChart, emptyNote } from '../charts.js';

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
                <div class="small dim"><span class="show-sm-i">GPU ${g.idx} · </span>${g.bus_id} · ${g.vram_mb ? `${Math.round(g.vram_mb / 1024)} GB` : '?'}${g.driver ? ` · ${g.driver}` : ''}</div></td>
              <td class="r">${live ? fmtHash(g.hashrate) : '—'}${live ? html`<div class="small dim show-sm">${fmtPower(g.power)} · ${fmtPct(g.fan)}</div>` : ''}</td>
              <td class="r ${live ? tempClass(g.temp) : ''}">${live ? fmtTemp(g.temp) : '—'}</td>
              <td class="r hide-md ${live ? tempClass(g.mem_temp, (state.me?.temp_limit ?? 80) + 20) : ''}">${live && g.mem_temp !== null ? fmtTemp(g.mem_temp) : '—'}</td>
              <td class="r hide-sm">${live ? fmtPct(g.fan) : '—'}</td>
              <td class="r hide-sm">${live ? fmtPower(g.power) : '—'}</td>
              <td class="r hide-md">${eff}</td>
              <td class="r hide-md">${live ? `${g.core_clk ?? '—'} / ${g.mem_clk ?? '—'}` : '—'}</td>
              <td class="r hide-md">${live ? `${g.accepted ?? 0} / ${g.rejected ?? 0}` : '—'}</td>
              <td class="hide-sm">${g.oc_name ? html`<span class="badge" title="${g.oc_source === 'gpu' ? 'Karta özel' : 'Model ataması'}">${g.oc_name}${g.oc_source === 'gpu' ? ' · kart' : ''}</span>` : html`<span class="dim small">Stok</span>`}</td>
            </tr>`;
  })}
        </tbody>
      </table>`) : String(html`<div class="empty">Agent henüz kart bilgisi göndermedi.</div>`);
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
    return html`<li><span class="grow">${COMMAND_LABELS[c.type] || c.type}${c.result ? html`<div class="small dim">${c.result}</div>` : ''}</span>
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
    renderHead(); renderTiles(); renderGpus(); renderSide();
    if (Date.now() - historyAt > 60_000) await loadHistory();
  }

  async function sendCommand(type) {
    const c = COMMAND_CONFIRM[type];
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
          <button type="button" class="btn sm" data-rotate>${icon('restart')}rig.conf'u yeniden oluştur</button>
          <button type="button" class="btn danger sm" data-delete>${icon('trash')}Rig'i hesaptan kaldır</button></div>
        <span class="hint">Yeniden oluşturunca eski rig.conf hemen geçersiz olur; yeni dosyayı flash'a kopyalayana kadar rig bağlanamaz.</span>`,
      onOpen: (dlg) => {
        dlg.querySelector('[data-rotate]').addEventListener('click', async () => {
          dlg.close();
          if (!(await confirmDialog('rig.conf yeniden oluşturulsun mu?', `"${r.name}" için yeni anahtar üretilecek. Eski rig.conf ile bağlanan rig, yeni dosya flash'a kopyalanana kadar bağlanamaz.`, 'Yeniden oluştur'))) return;
          const res = await api(`rigs/${rigId}/rotate-secret`, { method: 'POST' });
          downloadText('rig.conf', res.conf);
          toast('Yeni rig.conf indirildi. Flash belleğe kopyalayın.');
          await load();
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

  async function gpuDialog(gpuId) {
    const g = data.gpus.find((x) => x.id === gpuId);
    if (!g) return;
    const [{ oc_profiles: ocs }, h] = await Promise.all([api('oc-profiles'), api(`rigs/${rigId}/history?hours=24`)]);
    const points = h.gpus[gpuId] || [];
    const gpuCharts = [];
    const dlg = openDialog({
      title: `GPU ${g.idx} · ${g.model}`,
      wide: true,
      body: html`
        <div class="small dim"><span class="show-sm-i">GPU ${g.idx} · </span>${g.bus_id} · ${g.vram_mb ? `${Math.round(g.vram_mb / 1024)} GB` : ''} ${g.vbios ? `· VBIOS ${g.vbios}` : ''} ${g.driver ? `· Sürücü ${g.driver}` : ''}</div>
        <div class="gpu-charts">
          <div><h3 class="small muted">Hashrate</h3><div class="chart-box" style="height:150px"><canvas data-c="1"></canvas></div></div>
          <div><h3 class="small muted">Sıcaklık</h3><div class="chart-box" style="height:150px"><canvas data-c="2"></canvas></div></div>
          <div><h3 class="small muted">Güç</h3><div class="chart-box" style="height:150px"><canvas data-c="4"></canvas></div></div>
          <div><h3 class="small muted">Fan</h3><div class="chart-box" style="height:150px"><canvas data-c="3"></canvas></div></div>
        </div>
        <div class="field"><label>Bu karta özel OC profili</label>
          <select name="oc_profile_id"><option value="">Model atamasını kullan</option>
            ${ocs.filter((o) => o.vendor === g.vendor).map((o) => html`<option value="${o.id}" ${o.id === g.oc_profile_id ? 'selected' : ''}>${o.name}</option>`)}</select></div>`,
      onOpen: (d) => {
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
        await api(`rigs/${rigId}/gpus/${gpuId}`, { method: 'PUT', body: { oc_profile_id: form.oc_profile_id.value || null } });
        toast('Kart OC ayarı kaydedildi.');
        await load();
      },
    });
    dlg.addEventListener('close', () => gpuCharts.forEach((c) => c?.destroy()));
  }

  el.addEventListener('click', (e) => {
    const cmd = e.target.closest('[data-cmd]');
    if (cmd && !cmd.disabled) return sendCommand(cmd.dataset.cmd);
    if (e.target.closest('[data-edit]')) return editDialog().catch((err) => toast(err.message, 'bad'));
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
