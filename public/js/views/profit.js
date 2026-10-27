import { api, html, ago } from '../lib.js';

// Kazanç sıralaması: rig'lerdeki her kart modeli için TÜM GPU coin'lerinin günlük kazancı (WhatToMine verisi).
const PREF_KEY = 'wm-profit';
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* yok say */ } };
const CARD_NOTE = { 10606: 'P106-100 için GTX 1060 6GB değerleri kullanılır (aynı çip).' };

export async function profitView(el) {
  const prefs = { cur: 'TRY', kwh: 3, all: false, mineable: false, ...loadPrefs() };
  let data = null;
  let sel = null;

  const money = (usd) => {
    const v = prefs.cur === 'TRY' ? usd * data.usd_try : usd;
    const abs = Math.abs(v);
    const s = v.toLocaleString('tr-TR', { minimumFractionDigits: abs < 10 ? 2 : 0, maximumFractionDigits: abs < 10 ? 2 : 0 });
    return prefs.cur === 'TRY' ? `${s} ₺` : `$${s}`;
  };
  const coins = (n) => n.toLocaleString('tr-TR', { maximumFractionDigits: n < 1 ? 5 : n < 100 ? 3 : 0 });

  function render() {
    if (!data.cards.length) {
      el.innerHTML = String(html`
        <div class="page-head"><div class="grow"><h1>Kazanç sıralaması</h1></div></div>
        <div class="card empty">Henüz rig'lerinizden kart bilgisi gelmedi. Bir rig bağlanınca kartları burada sıralanır.</div>`);
      return;
    }
    const card = data.cards.find((c) => c.model === sel) || data.cards[0];
    sel = card.model;
    const mult = prefs.all ? card.count : 1;
    const elecUsd = (w) => (w ? (w * 24 / 1000) * Number(prefs.kwh || 0) / data.usd_try : 0);
    const rows = card.rows.filter((r) => !prefs.mineable || r.our_algo)
      .map((r) => ({ ...r, elec: elecUsd(r.power) * mult, gross: r.usd * mult, net: r.usd * mult - elecUsd(r.power) * mult }))
      .sort((a, b) => b.net - a.net);
    const best = rows[0];

    el.innerHTML = String(html`
      <div class="page-head">
        <div class="grow"><h1>Kazanç sıralaması</h1>
          <div class="sub">Tüm GPU coin'leri, sizin kartlarınıza göre tahmini günlük kazanç · WhatToMine verisi, ${ago(data.updated_at)} güncellendi
            · 1 BTC = $${Math.round(data.btc_usd).toLocaleString('tr-TR')} · 1 $ = ${data.usd_try.toFixed(2)} ₺</div></div>
      </div>
      ${data.stale ? html`<div class="callout warn" style="margin-bottom:12px">Güncel veri alınamadı, son alınan veri gösteriliyor.</div>` : ''}

      <div class="card card-pad" style="margin-bottom:14px;display:flex;flex-direction:column;gap:12px">
        <div class="seg" style="flex-wrap:wrap">${data.cards.map((c) => html`<button type="button" data-card="${c.model}" class="${c.model === sel ? 'on' : ''}">${c.model.replace(/^(NVIDIA|AMD Radeon) (GeForce )?/i, '')} ×${c.count}</button>`)}</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end">
          <div class="field" style="width:150px"><label>Elektrik (₺/kWh)</label>
            <input class="input num" type="number" min="0" step="0.1" data-kwh value="${prefs.kwh}"></div>
          <div class="seg"><button type="button" data-cur="TRY" class="${prefs.cur === 'TRY' ? 'on' : ''}">₺ TL</button><button type="button" data-cur="USD" class="${prefs.cur === 'USD' ? 'on' : ''}">$ USD</button></div>
          <label class="check"><input type="checkbox" data-all ${prefs.all ? 'checked' : ''}> Tüm ${card.count} kart için toplam</label>
          <label class="check"><input type="checkbox" data-mineable ${prefs.mineable ? 'checked' : ''}> Sadece panelden kazılabilenler</label>
        </div>
        ${CARD_NOTE[card.key] ? html`<div class="small dim">${CARD_NOTE[card.key]}</div>` : ''}
      </div>

      ${!card.key ? html`<div class="card empty">"${card.model}" için WhatToMine'da hashrate verisi yok.</div>`
      : !rows.length ? html`<div class="card empty">Bu kart için listede coin yok.</div>` : html`
      ${best ? html`<div class="card card-pad" style="margin-bottom:14px;display:flex;gap:18px;flex-wrap:wrap;align-items:center">
        <div><div class="small dim">En kârlı</div><div style="font-size:22px;font-weight:700">${best.name} <span class="dim small">${best.tag}</span></div></div>
        <div><div class="small dim">Günlük net</div><div style="font-size:22px;font-weight:700" class="${best.net >= 0 ? 't-ok' : 't-bad'}">${money(best.net)}</div></div>
        <div><div class="small dim">Aylık net (30 gün)</div><div style="font-size:22px;font-weight:700">${money(best.net * 30)}</div></div>
        ${best.our_algo ? html`<span class="badge ok">Panelden kazılabilir</span>` : html`<span class="badge">Bu coin için katalogda miner yok</span>`}
      </div>` : ''}
      <div class="card"><div class="table-wrap"><table class="num">
        <thead><tr><th>#</th><th>Coin</th><th class="hide-sm">Algoritma</th><th class="r hide-sm">Günlük coin</th><th class="r">Gelir</th>
          <th class="r hide-sm">Elektrik</th><th class="r">Net</th><th class="r hide-md">Güç</th><th class="hide-md"></th></tr></thead>
        <tbody>${rows.map((r, i) => html`<tr>
          <td class="dim">${i + 1}</td>
          <td><strong>${r.name}</strong> <span class="dim small">${r.tag}</span></td>
          <td class="hide-sm small">${r.algo}</td>
          <td class="r hide-sm">${coins(r.coins * mult)}</td>
          <td class="r">${money(r.gross)}</td>
          <td class="r hide-sm dim">${r.power ? `−${money(r.elec)}` : '—'}</td>
          <td class="r ${r.net >= 0 ? 't-ok' : 't-bad'}"><strong>${money(r.net)}</strong></td>
          <td class="r hide-md dim">${r.power ? `${Math.round(r.power * mult)} W` : '—'}</td>
          <td class="hide-md">${r.our_algo ? html`<span class="badge ok">Kazılabilir</span>` : ''}</td></tr>`)}</tbody>
      </table></div></div>
      <p class="small dim" style="margin:10px 2px">Tahmini değerlerdir: zorluk, coin fiyatı ve havuz ücreti değiştikçe gerçek kazanç farklı olur.
        Hashrate ve güç WhatToMine'ın stok kart ölçümleridir; OC ile değişir. "Kazılabilir": flight sheet'te seçilebilen ve katalogda miner'ı olan coin.</p>`}`);
  }

  el.addEventListener('click', (e) => {
    const c = e.target.closest('[data-card]');
    if (c) { sel = c.dataset.card; return render(); }
    const cur = e.target.closest('[data-cur]');
    if (cur) { prefs.cur = cur.dataset.cur; savePrefs(prefs); return render(); }
  });
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-kwh]')) prefs.kwh = Number(e.target.value) || 0;
    else if (e.target.matches('[data-all]')) prefs.all = e.target.checked;
    else if (e.target.matches('[data-mineable]')) prefs.mineable = e.target.checked;
    else return;
    savePrefs(prefs);
    render();
  });

  el.innerHTML = String(html`<div class="page-head"><div class="grow"><h1>Kazanç sıralaması</h1><div class="sub">Veriler alınıyor…</div></div></div>`);
  try {
    data = await api('profit');
  } catch (err) {
    el.innerHTML = String(html`<div class="page-head"><div class="grow"><h1>Kazanç sıralaması</h1></div></div><div class="card"><div class="callout warn">${err.message}</div></div>`);
    return null;
  }
  render();
  return null;
}
