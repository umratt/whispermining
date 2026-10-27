import { api, html, icon, openDialog, confirmDialog, toast, formData } from '../lib.js';

// Bilinen havuzlar (27.10.2026'da stratum el sıkışmasıyla tek tek doğrulandı). İlk sıradaki önerilen.
const POOLS = {
  ETC: [['2Miners', 'etc.2miners.com:1010'], ['HeroMiners', 'etc.herominers.com:1150'], ['Kryptex', 'etc.kryptex.network:7033'],
    ['F2Pool', 'etc.f2pool.com:8118'], ['WoolyPooly', 'pool.woolypooly.com:35000']],
  RVN: [['2Miners', 'rvn.2miners.com:6060'], ['HeroMiners', 'ravencoin.herominers.com:1140'], ['Kryptex', 'rvn.kryptex.network:7031'],
    ['Nanopool', 'rvn-eu1.nanopool.org:10400'], ['WoolyPooly', 'pool.woolypooly.com:55555']],
  ERG: [['2Miners', 'erg.2miners.com:8888'], ['HeroMiners', 'ergo.herominers.com:1180'], ['Kryptex', 'erg.kryptex.network:7021'],
    ['WoolyPooly', 'pool.woolypooly.com:3100']],
  KAS: [['2Miners', 'kas.2miners.com:2020'], ['HeroMiners', 'kaspa.herominers.com:1206'], ['Kryptex', 'kas.kryptex.network:7777'],
    ['F2Pool', 'kas.f2pool.com:1400'], ['WoolyPooly', 'pool.woolypooly.com:3112']],
  ALPH: [['HeroMiners', 'alephium.herominers.com:1199'], ['Kryptex', 'alph.kryptex.network:7777'], ['WoolyPooly', 'pool.woolypooly.com:3106']],
  CFX: [['HeroMiners', 'conflux.herominers.com:1170'], ['F2Pool', 'cfx.f2pool.com:6800'], ['WoolyPooly', 'pool.woolypooly.com:3094']],
  FIRO: [['WoolyPooly', 'pool.woolypooly.com:3104']],
  // Pearl kendi stratum protokolünü kullanır: portun açık olduğu doğrulandı (standart el sıkışmaya yanıt vermez)
  PRL: [['Kryptex', 'prl.kryptex.network:7048'], ['Kryptex Avrupa', 'prl-eu.kryptex.network:7048']],
  // Quantus da kendi protokolünü kullanır: portun açık olduğu doğrulandı
  QUANTUS: [['Kryptex', 'qtc.kryptex.network:7049'], ['Kryptex Avrupa', 'qtc-eu.kryptex.network:7049']],
  EVR: [['Evrpool Avrupa', 'eu.evrpool.com:1111'], ['Evrpool ABD', 'us.evrpool.com:1111']],
};
POOLS.EVRMORE = POOLS.EVR;
POOLS.PEARL = POOLS.PRL; // cüzdan "Pearl" diye eklenmiş olabilir
// Her kartta çalışmayan algoritmalar için formda uyarı
const ALGO_NOTES = {
  pearl: 'Pearl sadece NVIDIA RTX 20 ve üstü (ve AMD RX 6600–6950) kartlarda çalışır. P106-100, GTX 10xx ve RX 580 bu coin\'i kazamaz; '
    + 'karışık rig\'de o kartlar boşta kalır. Miner: BzMiner ya da SRBMiner-Multi.',
  quantus: 'Quantus sadece NVIDIA RTX 30 ve üstü ile AMD RX 6000 ve üstü kartlarda çalışır. P106-100, GTX 10xx, RTX 20xx ve RX 580 kazamaz; '
    + 'karışık rig\'de o kartlar boşta kalır. Miner: SRBMiner-Multi ya da BzMiner.',
};
const poolUrl = (hp) => `stratum+tcp://${hp}`;
const KNOWN_POOLS = new Set(Object.values(POOLS).flat().map(([, hp]) => poolUrl(hp)));
// [coin, algoritma, önerilen havuz]
const COINS = [['ETC', 'etchash'], ['RVN', 'kawpow'], ['ERG', 'autolykos2'], ['CFX', 'octopus'], ['FIRO', 'firopow'],
  ['KAS', 'kaspa'], ['ALPH', 'alephium'], ['BEAM', 'beamhash'], ['PRL', 'pearl'], ['PEARL', 'pearl'], ['QUANTUS', 'quantus'],
  ['EVR', 'evrprogpow'], ['EVRMORE', 'evrprogpow']].map(([c, a]) => [c, a, POOLS[c] ? poolUrl(POOLS[c][0][1]) : undefined]);
const coinInfo = (c) => COINS.find(([k]) => k === String(c || '').trim().toUpperCase());
const poolOptions = (coin) => {
  const list = POOLS[String(coin || '').trim().toUpperCase()] || [];
  return list.length ? `<option value="">Hazır havuz seçin…</option>${list.map(([n, hp]) => `<option value="${poolUrl(hp)}">${n} · ${hp}</option>`).join('')}`
    : '<option value="">Bu coin için hazır havuz yok, adresi elle yazın</option>';
};
const VENDOR_LABEL = { all: 'Tüm kartlar', nvidia: 'Sadece NVIDIA', amd: 'Sadece AMD' };

export async function flightView(el) {
  async function load() {
    const [{ flight_sheets: sheets }, { wallets }, { miners }, { rigs }] = await Promise.all([
      api('flight-sheets'), api('wallets'), api('miners'), api('rigs'),
    ]);
    el.innerHTML = String(html`
      <div class="page-head">
        <div class="grow"><h1>Flight sheet</h1><div class="sub">Coin, havuz, cüzdan ve miner seçimi. Rig'e atayınca agent ayarı otomatik çeker.</div></div>
        <button class="btn primary" data-new ${wallets.length ? '' : 'disabled'}>${icon('plus')}Yeni flight sheet</button>
      </div>
      ${wallets.length ? '' : html`<div class="callout warn" style="margin-bottom:14px">Flight sheet oluşturmak için önce aşağıdan bir cüzdan ekleyin.</div>`}
      <div class="card">
        ${sheets.length ? html`<div class="table-wrap"><table class="wrap-cells">
          <thead><tr><th>Ad</th><th>Coin</th><th class="hide-md">Havuz</th><th>Miner</th><th class="r">Rig</th><th></th></tr></thead>
          <tbody>${sheets.map((f) => html`<tr>
            <td><strong>${f.name}</strong><div class="small dim">${f.wallet_name || 'Cüzdan yok'}</div></td>
            <td><span class="badge">${f.coin}</span> <span class="small dim">${f.algo}</span></td>
            <td class="hide-md mono" title="${f.pools.join('\n')}">${f.pools[0] || ''}${f.pools.length > 1 ? ` +${f.pools.length - 1}` : ''}</td>
            <td>${f.miners.map((m) => html`<div>${m.name} ${m.version} <span class="small dim">${VENDOR_LABEL[m.gpu_vendor]}</span>
              ${m.sha256_ok ? '' : html` <span class="badge warn" title="Katalogda SHA256 girilmemiş; agent indirmez">SHA yok</span>`}</div>`)}</td>
            <td class="r num">${f.rig_count}</td>
            <td class="r"><div class="btn-row" style="justify-content:flex-end">
              <button class="btn sm" data-apply="${f.id}" ${rigs.length ? '' : 'disabled'}>${icon('apply')}<span class="hide-sm">Rig'lere uygula</span></button>
              <button class="btn sm icon" data-edit="${f.id}" aria-label="Düzenle">${icon('edit')}</button>
              <button class="btn sm icon danger" data-del="${f.id}" aria-label="Sil">${icon('trash')}</button></div></td>
          </tr>`)}</tbody></table></div>`
    : html`<div class="empty"><h2>Henüz flight sheet yok</h2><p>Örnek: ETC · havuz adresi · cüzdanınız · lolMiner.</p></div>`}
      </div>

      <div class="page-head section" style="margin-top:28px">
        <div class="grow"><h2>Cüzdanlar</h2><div class="sub">Rig'e sadece cüzdan adresi gönderilir.</div></div>
        <button class="btn" data-wallet-new>${icon('plus')}Cüzdan ekle</button>
      </div>
      <div class="card">
        ${wallets.length ? html`<ul class="list-plain">${wallets.map((w) => html`<li>
          <span class="badge">${w.coin}</span><span class="grow"><strong>${w.name}</strong><div class="mono dim" style="overflow:hidden;text-overflow:ellipsis">${w.address}</div></span>
          <button class="btn sm icon" data-wallet-edit="${w.id}" aria-label="Düzenle">${icon('edit')}</button>
          <button class="btn sm icon danger" data-wallet-del="${w.id}" aria-label="Sil">${icon('trash')}</button></li>`)}</ul>`
    : html`<div class="empty small">Cüzdan yok.</div>`}
      </div>`);

    const ctx = { sheets, wallets, miners, rigs };
    el.onclick = (e) => {
      const t = (s) => e.target.closest(`[${s}]`);
      let b;
      if ((b = t('data-new'))) return sheetDialog(ctx, null);
      if ((b = t('data-edit'))) return sheetDialog(ctx, sheets.find((f) => f.id === Number(b.dataset.edit)));
      if ((b = t('data-apply'))) return applyDialog(ctx, sheets.find((f) => f.id === Number(b.dataset.apply)));
      if ((b = t('data-del'))) return removeSheet(sheets.find((f) => f.id === Number(b.dataset.del)));
      if ((b = t('data-wallet-new'))) return walletDialog(null);
      if ((b = t('data-wallet-edit'))) return walletDialog(wallets.find((w) => w.id === Number(b.dataset.walletEdit)));
      if ((b = t('data-wallet-del'))) return removeWallet(wallets.find((w) => w.id === Number(b.dataset.walletDel)));
    };
  }

  async function removeSheet(f) {
    if (!(await confirmDialog('Flight sheet silinsin mi?', `"${f.name}" silinecek. Bu sheet'i kullanan ${f.rig_count} rig'de miner durur.`, 'Sil'))) return;
    await api(`flight-sheets/${f.id}`, { method: 'DELETE' });
    toast('Flight sheet silindi.');
    load();
  }

  async function removeWallet(w) {
    if (!(await confirmDialog('Cüzdan silinsin mi?', `"${w.name}" silinecek.`, 'Sil'))) return;
    try { await api(`wallets/${w.id}`, { method: 'DELETE' }); toast('Cüzdan silindi.'); load(); } catch (err) { toast(err.message, 'bad'); }
  }

  function walletDialog(w) {
    openDialog({
      title: w ? 'Cüzdanı düzenle' : 'Cüzdan ekle',
      body: html`
        <div class="form-grid">
          <div class="field"><label>Coin</label><input class="input" name="coin" value="${w?.coin || 'ETC'}" maxlength="12" required></div>
          <div class="field"><label>Ad</label><input class="input" name="name" value="${w?.name || ''}" maxlength="40" placeholder="ör. Binance ETC" required></div>
          <div class="field full"><label>Adres</label><input class="input mono" name="address" value="${w?.address || ''}" maxlength="200" spellcheck="false" required></div>
        </div>`,
      onSubmit: async (form) => {
        const r = await api(w ? `wallets/${w.id}` : 'wallets', { method: w ? 'PUT' : 'POST', body: formData(form) });
        const made = r.flight_sheets_created || [];
        toast(made.length ? `Cüzdan kaydedildi. Havuzu ve miner'ı seçilmiş flight sheet hazırlandı: ${made.map((c) => `Oto · ${c}`).join(', ')}`
          : 'Cüzdan kaydedildi.');
        load();
      },
    });
  }

  function minerRow(versions, m = {}) {
    return html`<div class="miner-row" data-miner-row>
      <div class="field wide"><label>Miner</label><select name="mv">${versions.map((v) => html`<option value="${v.id}" data-label="${v.label}" ${v.id === m.miner_version_id ? 'selected' : ''}>${v.label}</option>`)}</select></div>
      <div class="field"><label>Kartlar</label><select name="vendor">${Object.entries(VENDOR_LABEL).map(([k, l]) => html`<option value="${k}" ${k === (m.gpu_vendor || 'all') ? 'selected' : ''}>${l}</option>`)}</select></div>
      <div class="field"><label>Ek parametreler</label><input class="input mono" name="args" value="${m.extra_args || ''}" placeholder="isteğe bağlı"></div>
      <button type="button" class="btn icon danger" data-row-del aria-label="Kaldır">${icon('x')}</button>
    </div>`;
  }

  function sheetDialog({ wallets, miners }, f) {
    const versions = miners.flatMap((m) => m.versions.map((v) => ({
      id: v.id, label: `${m.name} ${v.version} (${[m.supports_nvidia && 'NVIDIA', m.supports_amd && 'AMD'].filter(Boolean).join(' + ')})${v.sha256 ? '' : ' — SHA yok'}`,
      algos: (v.algos || '').split(',').filter(Boolean),
    })));
    // Yeni flight sheet: ilk cüzdanın coin'iyle başla
    const startCoin = f?.coin || wallets[0]?.coin || 'ETC';
    const startAlgo = f?.algo || coinInfo(startCoin)?.[1] || '';
    openDialog({
      title: f ? 'Flight sheet düzenle' : 'Yeni flight sheet',
      wide: true,
      body: html`
        <div class="form-grid">
          <div class="field full"><label>Ad</label><input class="input" name="name" value="${f?.name || ''}" maxlength="60" placeholder="ör. ETC · 2miners · lolMiner" required></div>
          <div class="field"><label>Coin</label><input class="input" name="coin" list="coin-list" value="${startCoin}" maxlength="12" required>
            <datalist id="coin-list">${COINS.map(([c]) => html`<option value="${c}">`)}</datalist></div>
          <div class="field"><label>Algoritma</label><input class="input" name="algo" list="algo-list" value="${startAlgo}" maxlength="30" required>
            <datalist id="algo-list">${COINS.map(([, a]) => html`<option value="${a}">`)}</datalist></div>
          <div class="field full"><label>Cüzdan</label><select name="wallet_id">${wallets.map((w) => html`<option value="${w.id}" ${w.id === f?.wallet_id ? 'selected' : ''}>${w.coin} · ${w.name}</option>`)}</select></div>
          <div class="field full"><label>Havuz adresleri</label>
            <textarea class="mono" name="pools" spellcheck="false" placeholder="${coinInfo(startCoin)?.[2] || 'stratum+tcp://havuz-adresi:port'}">${(f?.pools || (f ? [] : [coinInfo(startCoin)?.[2]].filter(Boolean))).join('\n')}</textarea>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px"><select name="pool_pick" style="flex:1;min-width:220px">${html([poolOptions(startCoin)])}</select>
              <button type="button" class="btn sm" data-pool-backup>${icon('plus')}Yedek olarak ekle</button></div>
            <span class="hint">Her satıra bir adres. İlki ana havuz, diğerleri yedek. Listeden seçince ana havuz değişir.</span></div>
          <div class="field"><label>Worker adı</label><input class="input mono" name="worker_template" value="${f?.worker_template || '%RIG_NAME%'}" maxlength="40">
            <span class="hint">%RIG_NAME% rig adıyla değiştirilir.</span></div>
          <div class="field"><label>Havuz şifresi</label><input class="input mono" name="pool_pass" value="${f?.pool_pass || 'x'}" maxlength="60"></div>
        </div>
        <div>
          <h3 style="margin-bottom:8px">Miner</h3>
          <div data-miners style="display:flex;flex-direction:column;gap:10px">${(f?.miners?.length ? f.miners : [{}]).map((m) => minerRow(versions, m))}</div>
          <button type="button" class="btn sm" style="margin-top:10px" data-row-add>${icon('plus')}İkinci miner ekle</button>
          <div class="hint" style="margin-top:6px">Karışık rig'de (AMD + NVIDIA) ya ikisini de destekleyen tek miner ya da kart türüne göre iki miner seçin. Seçilen algoritmayı desteklemeyen miner'lar listede pasif görünür.</div>
          <div class="callout warn hidden" data-algo-note style="margin-top:8px"></div>
        </div>`,
      onOpen: (dlg) => {
        const box = dlg.querySelector('[data-miners]');
        const sync = () => { dlg.querySelector('[data-row-add]').classList.toggle('hidden', box.children.length >= 2); };
        dlg.querySelector('[data-row-add]').addEventListener('click', () => { box.insertAdjacentHTML('beforeend', String(minerRow(versions))); sync(); });
        box.addEventListener('click', (e) => { if (e.target.closest('[data-row-del]') && box.children.length > 1) { e.target.closest('[data-miner-row]').remove(); sync(); } });
        sync();
        // Cüzdan → coin → algoritma → havuz ve miner listesi birbirine bağlı
        const fm = dlg.querySelector('form') || dlg;
        const coinEl = fm.querySelector('[name=coin]'), algoEl = fm.querySelector('[name=algo]');
        const poolsEl = fm.querySelector('[name=pools]'), walletEl = fm.querySelector('[name=wallet_id]');
        const filterMiners = () => {
          const algo = algoEl.value.trim().toLowerCase();
          box.querySelectorAll('select[name=mv]').forEach((sel) => {
            let firstOk = null;
            [...sel.options].forEach((o) => {
              const v = versions.find((x) => String(x.id) === o.value);
              const ok = !algo || !v.algos.length || v.algos.includes(algo);
              o.disabled = !ok;
              o.textContent = o.dataset.label + (ok ? '' : ' — bu algoritmayı desteklemez');
              if (ok && !firstOk) firstOk = o;
            });
            if (sel.selectedOptions[0]?.disabled && firstOk) sel.value = firstOk.value;
          });
          const note = dlg.querySelector('[data-algo-note]');
          note.textContent = ALGO_NOTES[algo] || '';
          note.classList.toggle('hidden', !ALGO_NOTES[algo]);
        };
        const setCoin = (coin) => {
          const info = coinInfo(coin);
          coinEl.value = String(coin).toUpperCase();
          if (!info) return;
          algoEl.value = info[1];
          poolsEl.placeholder = info[2] || 'stratum+tcp://havuz-adresi:port';
          pickEl.innerHTML = poolOptions(info[0]);
          // Havuz boşsa ya da sadece listeden seçilmiş havuzlar duruyorsa yeni coin'in önerisiyle değiştir
          const lines = poolsEl.value.split(/\s+/).filter(Boolean);
          if (!lines.length || lines.every((l) => KNOWN_POOLS.has(l))) poolsEl.value = info[2] || '';
          filterMiners();
        };
        const pickEl = fm.querySelector('[name=pool_pick]');
        const poolLines = () => poolsEl.value.split(/\s+/).filter(Boolean);
        pickEl.addEventListener('change', () => {
          if (!pickEl.value) return;
          const rest = poolLines().slice(1).filter((l) => l !== pickEl.value);
          poolsEl.value = [pickEl.value, ...rest].join('\n');
        });
        fm.querySelector('[data-pool-backup]').addEventListener('click', () => {
          if (!pickEl.value) return toast('Önce listeden bir havuz seçin.');
          const lines = poolLines();
          if (!lines.includes(pickEl.value)) poolsEl.value = [...lines, pickEl.value].join('\n');
        });
        walletEl.addEventListener('change', () => {
          const w = wallets.find((x) => String(x.id) === walletEl.value);
          if (w) setCoin(w.coin);
        });
        coinEl.addEventListener('change', () => setCoin(coinEl.value));
        algoEl.addEventListener('input', filterMiners);
        dlg.querySelector('[data-row-add]').addEventListener('click', filterMiners);
        if (!f && walletEl.value) walletEl.dispatchEvent(new Event('change'));
        filterMiners();
      },
      onSubmit: async (form) => {
        const d = formData(form);
        const body = {
          name: d.name, coin: d.coin, algo: d.algo, wallet_id: d.wallet_id, worker_template: d.worker_template, pool_pass: d.pool_pass,
          pools: d.pools.split(/\s+/).filter(Boolean),
          miners: [...form.querySelectorAll('[data-miner-row]')].map((r) => ({
            miner_version_id: Number(r.querySelector('[name=mv]').value), gpu_vendor: r.querySelector('[name=vendor]').value, extra_args: r.querySelector('[name=args]').value,
          })),
        };
        await api(f ? `flight-sheets/${f.id}` : 'flight-sheets', { method: f ? 'PUT' : 'POST', body });
        toast('Flight sheet kaydedildi.');
        load();
      },
    });
  }

  function applyDialog({ rigs }, f) {
    openDialog({
      title: `"${f.name}" uygula`,
      submitLabel: 'Uygula',
      body: html`<p class="muted" style="margin:0">Seçilen rig'ler bu flight sheet'e geçer, miner yeni ayarla yeniden başlar.</p>
        <div style="display:flex;flex-direction:column;gap:10px">${rigs.map((r) => html`<label class="check"><input type="checkbox" name="rig" value="${r.id}">
          ${r.name} <span class="small dim">${r.flight_sheet ? `şu an: ${r.flight_sheet}` : 'flight sheet yok'}</span></label>`)}</div>`,
      onSubmit: async (form) => {
        const ids = [...form.querySelectorAll('[name=rig]:checked')].map((c) => c.value);
        if (!ids.length) throw new Error('En az bir rig seçin.');
        const res = await api(`flight-sheets/${f.id}/apply`, { method: 'POST', body: { rig_ids: ids } });
        toast(`${res.applied} rig güncellendi.`);
        load();
      },
    });
  }

  await load();
  return () => { el.onclick = null; };
}
