import { api, html, ago, toast, dateTime } from '../lib.js';

// Kazanç sayfası (WhatToMine hesaplayıcısı gibi): kart seti seç (adetle), tüm GPU coin'leri kâra göre sıralansın.
// Üstte: tüm rig'ler için otomatik coin değiştirme.
const PREF_KEY = 'wm-profit2';
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* yok say */ } };

const COLS = [
  ['name', 'Coin'], ['hashrate', 'Hashrate', 'hide-sm'], ['coins', 'Günlük coin', 'hide-sm'], ['price', 'Fiyat', 'hide-sm'],
  ['gross', 'Gelir / gün'], ['gross24', '24 sa ort.', 'hide-md'], ['elec', 'Elektrik', 'hide-sm'], ['net', 'Kâr / gün'],
  ['month', 'Aylık kâr', 'hide-md'], ['volume', 'Hacim (24 sa)', 'hide-md'], ['mcap', 'Piyasa değeri', 'hide-md'],
];

export async function profitView(el) {
  const prefs = { cur: 'TRY', showAll: false, sort: 'net', dir: -1, q: '', sel: null, ...loadPrefs() };
  let base = null;   // /profit: rig'lerdeki kartlar, elektrik fiyatı
  let calc = null;   // /profit/calc: seçilen kart setine göre coin'ler
  let auto = null;   // otomatik coin değiştirme
  let busy = false;
  let kwh = 3;
  let timer = null;

  const rate = () => (prefs.cur === 'TRY' ? calc.usd_try : 1);
  const money = (usd, digits) => {
    const v = usd * rate();
    const abs = Math.abs(v);
    const d = digits ?? (abs < 10 ? 2 : 0);
    const s = v.toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
    return prefs.cur === 'TRY' ? `${s} ₺` : `$${s}`;
  };
  const price = (usd) => {
    const v = usd * rate();
    const d = v >= 100 ? 0 : v >= 1 ? 2 : v >= 0.01 ? 4 : 6;
    const s = v.toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
    return prefs.cur === 'TRY' ? `${s} ₺` : `$${s}`;
  };
  const num = (n, max = 3) => n.toLocaleString('tr-TR', { maximumFractionDigits: n < 1 ? 5 : n < 100 ? max : 0 });
  const big = (usd) => {
    const v = usd * rate();
    const [d, u] = v >= 1e9 ? [1e9, ' mr'] : v >= 1e6 ? [1e6, ' mn'] : v >= 1e3 ? [1e3, ' b'] : [1, ''];
    return `${(v / d).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}${u} ${prefs.cur === 'TRY' ? '₺' : '$'}`;
  };
  const selection = () => prefs.sel || {};
  const gpuLabel = (key) => calc?.gpus.find((g) => g.key === key)?.label || key;

  // Rig'lerdeki kartlardan kart seti (aynı WhatToMine anahtarına düşenler toplanır)
  function fromRigs() {
    const sel = {};
    for (const c of base.cards) if (c.key) sel[c.key] = (sel[c.key] || 0) + c.count;
    return sel;
  }

  // ---------- otomatik coin değiştirme ----------
  function autoCard() {
    if (!auto) return html`<div class="card card-pad" style="margin-bottom:14px"><span class="dim small">Otomatik coin değiştirme yükleniyor…</span></div>`;
    const a = auto;
    return html`<div class="card" style="margin-bottom:14px">
      <div class="card-head"><h2>Otomatik coin değiştirme · tüm rig'ler</h2>
        <label class="check" style="font-weight:600"><input type="checkbox" data-auto ${a.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''}> Açık</label></div>
      <div class="card-pad" style="display:flex;flex-direction:column;gap:10px">
        <p class="small muted" style="margin:0">Açıkken <strong>tüm rig'ler aynı coin'i</strong> kazar: her aday coin için ${a.rig_count} rig'deki bütün kartların
          <strong>toplam</strong> net kazancı hesaplanır, en yükseği seçilir. 30 dakikada bir bakılır; yeni coin en az %${Math.round(a.min_gain * 100)} daha kârlıysa ve
          son değişiklikten ${a.min_hold_h} saat geçtiyse geçilir. Adaylar cüzdanı olan coin'lerdir (flight sheet'i yoksa "Oto · COIN" hazırlanır).
          Bir coin'i kazamayan kartlar o coin'de boşta kalır.</p>
        ${a.decision ? html`<div class="callout" style="margin:0"><strong>Son karar${a.last_check ? ` (${ago(a.last_check)})` : ''}:</strong> ${a.decision}</div>` : ''}
        ${a.candidates.length ? html`<div class="table-wrap"><table class="num">
          <thead><tr><th>Coin</th><th class="hide-sm">Flight sheet</th><th class="r">Kazan / boşta kart</th><th class="r hide-sm">Gelir</th><th class="r">Tüm rig'ler kâr/gün</th><th></th></tr></thead>
          <tbody>${a.candidates.map((c) => html`<tr>
            <td><strong>${c.coin}</strong> <span class="dim small">${c.algo}</span></td><td class="hide-sm small">${c.name}</td>
            <td class="r">${c.mining} / <span class="${c.idle ? 't-warn' : 'dim'}">${c.idle}</span></td>
            <td class="r hide-sm">${money(c.gross)}</td><td class="r ${c.net >= 0 ? 't-ok' : 't-bad'}"><strong>${money(c.net)}</strong></td>
            <td>${c.fs_id === a.current_fs_id ? html`<span class="badge">Şu an</span>` : ''}${c.fs_id === a.best_fs_id ? html` <span class="badge ok">En kârlı</span>` : ''}</td></tr>`)}</tbody>
        </table></div>` : html`<div class="small dim">Aday yok: Flight sheet sayfasından coin cüzdanı ekleyin (RVN, Pearl, ETC, Firo…).</div>`}
        <div class="btn-row">
          <button type="button" class="btn sm" data-auto-check ${busy ? 'disabled' : ''}>Şimdi kontrol et</button>
          ${a.enabled && a.best_fs_id && a.best_fs_id !== a.current_fs_id ? html`<button type="button" class="btn sm primary" data-auto-now ${busy ? 'disabled' : ''}>En kârlıya şimdi geç</button>` : ''}
        </div>
        ${a.log.length ? html`<details><summary class="small" style="cursor:pointer">Değişiklik geçmişi (${a.log.length})</summary>
          <ul class="list-plain" style="margin-top:6px">${a.log.map((l) => html`<li><span class="grow small">${l.msg}</span><span class="small dim">${dateTime(l.at)}</span></li>`)}</ul></details>` : ''}
      </div></div>`;
  }

  async function loadAuto() {
    try { auto = await api('auto-switch'); } catch (err) { auto = { enabled: false, candidates: [], log: [], decision: err.message, rig_count: 0, min_gain: 0.1, min_hold_h: 6 }; }
    if (calc) render();
  }

  async function autoAction(fn) {
    busy = true; render();
    try { auto = await fn(); } catch (err) { toast(err.message, 'bad'); } finally { busy = false; render(); }
  }

  // ---------- hesaplama ----------
  async function loadCalc() {
    const q = Object.entries(selection()).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(',');
    calc = await api(`profit/calc?c=${encodeURIComponent(q)}`);
    render();
  }
  const recalc = () => { clearTimeout(timer); timer = setTimeout(() => loadCalc().catch((err) => toast(err.message, 'bad')), 350); };

  function rowsView() {
    const elec = (w) => (w ? (w * 24 / 1000) * kwh / calc.usd_try : 0);
    const q = prefs.q.trim().toLowerCase();
    const rows = calc.rows
      .filter((r) => (prefs.showAll || r.our_algo) && (!q || `${r.name} ${r.tag} ${r.algo}`.toLowerCase().includes(q)))
      .map((r) => {
        const e = elec(r.power);
        const mcap = Number(String(r.market_cap || '').replace(/[^0-9.]/g, '')) || 0;
        return { ...r, price: r.price_usd, gross: r.usd, gross24: r.usd24, elec: e, net: r.usd - e, month: (r.usd - e) * 30, volume: r.volume_usd, mcap };
      });
    const k = prefs.sort;
    rows.sort((a, b) => (k === 'name' ? a.name.localeCompare(b.name, 'tr') * -prefs.dir : ((b[k] ?? -Infinity) - (a[k] ?? -Infinity)) * -prefs.dir));
    return rows;
  }

  function render() {
    if (!calc) return;
    const sel = selection();
    const total = Object.values(sel).reduce((s, n) => s + n, 0);
    const rows = rowsView();
    const top = [...rows].sort((a, b) => b.net - a.net)[0];
    const arrow = (key) => (prefs.sort === key ? (prefs.dir < 0 ? ' ▼' : ' ▲') : '');
    el.innerHTML = String(html`
      <div class="page-head">
        <div class="grow"><h1>Kazanç sıralaması</h1>
          <div class="sub">WhatToMine verisi · ${ago(calc.updated_at)} güncellendi · 1 BTC = $${Math.round(calc.btc_usd).toLocaleString('tr-TR')} · 1 $ = ${calc.usd_try.toFixed(2)} ₺</div></div>
        <div class="seg"><button type="button" data-cur="TRY" class="${prefs.cur === 'TRY' ? 'on' : ''}">₺ TL</button><button type="button" data-cur="USD" class="${prefs.cur === 'USD' ? 'on' : ''}">$ USD</button></div>
      </div>
      ${calc.stale ? html`<div class="callout warn" style="margin-bottom:12px">Güncel veri alınamadı, son alınan veri gösteriliyor.</div>` : ''}
      ${autoCard()}

      <div class="card" style="margin-bottom:14px">
        <div class="card-head"><h2>Kartlar</h2><span class="small dim">${total} kart · hesap bu kartların toplamına göre</span></div>
        <div class="card-pad" style="display:flex;flex-direction:column;gap:12px">
          <div style="display:flex;flex-wrap:wrap;gap:8px">${Object.entries(sel).map(([key, n]) => html`
            <span style="display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:8px;padding:4px 6px 4px 10px">
              <span class="small"><strong>${gpuLabel(key)}</strong></span>
              <input class="input num" type="number" min="0" max="500" value="${n}" data-qty="${key}" style="width:64px;padding:4px 6px">
              <button type="button" class="btn sm ghost icon" data-del="${key}" aria-label="Kaldır">×</button></span>`)}
            ${total ? '' : html`<span class="dim small">Kart seçilmedi. Aşağıdan kart ekleyin.</span>`}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
            <div class="field" style="min-width:220px;flex:1"><label>Kart ekle</label>
              <select data-add><option value="">Kart seçin…</option>${calc.gpus.filter((g) => !sel[g.key]).map((g) => html`<option value="${g.key}">${g.label}</option>`)}</select></div>
            <button type="button" class="btn" data-fill>Rig'lerimdeki kartlar</button>
            <div class="field" style="width:150px"><label>Elektrik (₺/kWh)</label>
              <input class="input num" type="number" min="0" step="0.1" data-kwh value="${kwh}"></div>
          </div>
          ${sel['10606'] ? html`<div class="small dim">P106-100 için GTX 1060 6GB değerleri kullanılır (aynı çip).</div>` : ''}
        </div>
      </div>

      ${top && top.net > 0 ? html`<div class="card card-pad" style="margin-bottom:14px;display:flex;gap:22px;flex-wrap:wrap;align-items:center">
        <div><div class="small dim">Bu kartlarla en kârlı</div><div style="font-size:22px;font-weight:700">${top.name} <span class="dim small">${top.tag}</span></div></div>
        <div><div class="small dim">Günlük kâr</div><div style="font-size:22px;font-weight:700" class="t-ok">${money(top.net)}</div></div>
        <div><div class="small dim">Aylık kâr</div><div style="font-size:22px;font-weight:700">${money(top.month)}</div></div>
        ${top.our_algo ? html`<span class="badge ok">Panelden kazılabilir</span>` : html`<span class="badge">Katalogda miner yok</span>`}
      </div>` : ''}

      <div class="card">
        <div class="card-pad" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;padding-bottom:0">
          <input class="input" data-q placeholder="Coin ya da algoritma ara…" value="${prefs.q}" style="max-width:260px">
          <label class="check"><input type="checkbox" data-show-all ${prefs.showAll ? 'checked' : ''}> Panelden kazılamayan coin'leri de göster</label>
          <span class="small dim grow" style="text-align:right">${rows.length} coin · başlığa tıklayarak sıralayın</span>
        </div>
        ${rows.length ? html`<div class="table-wrap"><table class="num">
          <thead><tr><th class="dim">#</th>${COLS.map(([k, label, cls]) => html`<th class="${k === 'name' ? '' : 'r'} ${cls || ''}" data-sort="${k}" style="cursor:pointer;user-select:none">${label}${arrow(k)}</th>`)}<th class="hide-md"></th></tr></thead>
          <tbody>${rows.map((r, i) => html`<tr${r === top ? ' style="background:var(--accent-soft)"' : ''}>
            <td class="dim">${i + 1}</td>
            <td><strong>${r.name}</strong> <span class="dim small">${r.tag}</span><div class="small dim">${r.algo}</div></td>
            <td class="r hide-sm">${num(r.hashrate, 1)} <span class="dim small">${r.unit}</span><div class="small dim">${r.power ? `${Math.round(r.power)} W` : ''}${r.cards < total ? html` · <span class="t-warn">${r.cards}/${total} kart</span>` : ''}</div></td>
            <td class="r hide-sm">${num(r.coins)}</td>
            <td class="r hide-sm">${price(r.price_usd)}${r.price_change !== null ? html`<div class="small ${r.price_change >= 0 ? 't-ok' : 't-bad'}">${r.price_change >= 0 ? '+' : ''}${(r.price_change * 100).toFixed(1)}%</div>` : ''}</td>
            <td class="r">${money(r.gross)}</td>
            <td class="r hide-md dim">${money(r.gross24)}</td>
            <td class="r hide-sm dim">${r.power ? `−${money(r.elec)}` : '—'}</td>
            <td class="r ${r.net >= 0 ? 't-ok' : 't-bad'}"><strong>${money(r.net)}</strong></td>
            <td class="r hide-md">${money(r.month)}</td>
            <td class="r hide-md dim">${r.volume ? big(r.volume) : '—'}</td>
            <td class="r hide-md dim">${r.mcap ? big(r.mcap) : '—'}</td>
            <td class="hide-md">${r.our_algo ? html`<span class="badge ok">Kazılabilir</span>` : ''}</td></tr>`)}</tbody>
        </table></div>` : html`<div class="empty">${total ? 'Bu kartlarla eşleşen coin yok.' : 'Hesap için kart seçin.'}</div>`}
      </div>
      <p class="small dim" style="margin:10px 2px">Tahmini değerlerdir; zorluk, coin fiyatı ve havuz ücreti değiştikçe gerçek kazanç değişir. Hashrate ve güç WhatToMine'ın stok kart
        ölçümleridir (OC ile değişir). "24 sa ort.": son 24 saatin ortalama zorluk ve fiyatıyla gelir. "Kazılabilir": flight sheet'te seçilebilen ve katalogda miner'ı olan coin. "3/11 kart": bu coin'i kartların sadece bir kısmı kazabilir, kalanlar hesaba katılmaz.</p>`);
  }

  // ---------- olaylar ----------
  el.addEventListener('click', (e) => {
    const s = e.target.closest('[data-sort]');
    if (s) {
      const k = s.dataset.sort;
      prefs.dir = prefs.sort === k ? -prefs.dir : (k === 'name' ? 1 : -1);
      prefs.sort = k; savePrefs(prefs); return render();
    }
    const cur = e.target.closest('[data-cur]');
    if (cur) { prefs.cur = cur.dataset.cur; savePrefs(prefs); return render(); }
    const del = e.target.closest('[data-del]');
    if (del) { const sel = { ...selection() }; delete sel[del.dataset.del]; prefs.sel = sel; savePrefs(prefs); return recalc(); }
    if (e.target.closest('[data-fill]')) { prefs.sel = fromRigs(); savePrefs(prefs); return recalc(); }
    if (e.target.closest('[data-auto-check]')) return autoAction(() => api('auto-switch/check', { method: 'POST', body: {} }));
    if (e.target.closest('[data-auto-now]')) return autoAction(() => api('auto-switch/check', { method: 'POST', body: { force: true } }));
  });
  el.addEventListener('input', (e) => {
    if (e.target.matches('[data-q]')) {
      prefs.q = e.target.value; savePrefs(prefs);
      const pos = e.target.selectionStart;
      render();
      const q = el.querySelector('[data-q]'); q.focus(); q.setSelectionRange(pos, pos);
    }
  });
  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-auto]')) {
      const on = t.checked;
      return autoAction(async () => {
        const r = await api('auto-switch', { method: 'PUT', body: { enabled: on } });
        toast(on ? 'Otomatik coin değiştirme açıldı.' : 'Otomatik coin değiştirme kapatıldı; rig\'ler şu anki coin\'de kalır.');
        return r;
      });
    }
    if (t.matches('[data-qty]')) { prefs.sel = { ...selection(), [t.dataset.qty]: Math.max(0, Math.round(Number(t.value) || 0)) }; savePrefs(prefs); return recalc(); }
    if (t.matches('[data-add]') && t.value) { prefs.sel = { ...selection(), [t.value]: 1 }; savePrefs(prefs); return recalc(); }
    if (t.matches('[data-kwh]')) {
      kwh = Number(t.value) || 0;
      render();
      // Otomatik değiştirme de aynı fiyatı kullanır: sunucuya kaydet
      api('me/power-price', { method: 'PUT', body: { value: kwh } }).then(loadAuto).catch((err) => toast(err.message, 'bad'));
      return;
    }
    if (t.matches('[data-show-all]')) { prefs.showAll = t.checked; savePrefs(prefs); render(); }
  });

  el.innerHTML = String(html`<div class="page-head"><div class="grow"><h1>Kazanç sıralaması</h1><div class="sub">Veriler alınıyor…</div></div></div>`);
  try {
    base = await api('profit');
    kwh = base.power_price ?? kwh; // elektrik fiyatı sunucuda tutulur
    if (!prefs.sel || !Object.keys(prefs.sel).length) prefs.sel = fromRigs();
    if (!Object.keys(prefs.sel).length) prefs.sel = { 3080: 1 }; // hiç rig yoksa örnek kart
    await loadCalc();
    loadAuto();
  } catch (err) {
    el.innerHTML = String(html`<div class="page-head"><div class="grow"><h1>Kazanç sıralaması</h1></div></div><div class="card"><div class="callout warn">${err.message}</div></div>`);
    return null;
  }
  return () => clearTimeout(timer);
}
