import { api, html, icon, openDialog, confirmDialog, toast, formData } from '../lib.js';

const COINS = [
  ['ETC', 'etchash'], ['RVN', 'kawpow'], ['ERG', 'autolykos2'], ['CFX', 'octopus'], ['FIRO', 'firopow'],
  ['KAS', 'kaspa'], ['ALPH', 'alephium'], ['BEAM', 'beamhash'],
];
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
        await api(w ? `wallets/${w.id}` : 'wallets', { method: w ? 'PUT' : 'POST', body: formData(form) });
        toast('Cüzdan kaydedildi.');
        load();
      },
    });
  }

  function minerRow(versions, m = {}) {
    return html`<div class="miner-row" data-miner-row>
      <div class="field wide"><label>Miner</label><select name="mv">${versions.map((v) => html`<option value="${v.id}" ${v.id === m.miner_version_id ? 'selected' : ''}>${v.label}</option>`)}</select></div>
      <div class="field"><label>Kartlar</label><select name="vendor">${Object.entries(VENDOR_LABEL).map(([k, l]) => html`<option value="${k}" ${k === (m.gpu_vendor || 'all') ? 'selected' : ''}>${l}</option>`)}</select></div>
      <div class="field"><label>Ek parametreler</label><input class="input mono" name="args" value="${m.extra_args || ''}" placeholder="isteğe bağlı"></div>
      <button type="button" class="btn icon danger" data-row-del aria-label="Kaldır">${icon('x')}</button>
    </div>`;
  }

  function sheetDialog({ wallets, miners }, f) {
    const versions = miners.flatMap((m) => m.versions.map((v) => ({
      id: v.id, label: `${m.name} ${v.version} (${[m.supports_nvidia && 'NVIDIA', m.supports_amd && 'AMD'].filter(Boolean).join(' + ')})${v.sha256 ? '' : ' — SHA yok'}`,
    })));
    openDialog({
      title: f ? 'Flight sheet düzenle' : 'Yeni flight sheet',
      wide: true,
      body: html`
        <div class="form-grid">
          <div class="field full"><label>Ad</label><input class="input" name="name" value="${f?.name || ''}" maxlength="60" placeholder="ör. ETC · 2miners · lolMiner" required></div>
          <div class="field"><label>Coin</label><input class="input" name="coin" list="coin-list" value="${f?.coin || 'ETC'}" maxlength="12" required>
            <datalist id="coin-list">${COINS.map(([c]) => html`<option value="${c}">`)}</datalist></div>
          <div class="field"><label>Algoritma</label><input class="input" name="algo" list="algo-list" value="${f?.algo || 'etchash'}" maxlength="30" required>
            <datalist id="algo-list">${COINS.map(([, a]) => html`<option value="${a}">`)}</datalist></div>
          <div class="field full"><label>Cüzdan</label><select name="wallet_id">${wallets.map((w) => html`<option value="${w.id}" ${w.id === f?.wallet_id ? 'selected' : ''}>${w.coin} · ${w.name}</option>`)}</select></div>
          <div class="field full"><label>Havuz adresleri</label>
            <textarea class="mono" name="pools" spellcheck="false" placeholder="stratum+tcp://etc.2miners.com:1010">${(f?.pools || []).join('\n')}</textarea>
            <span class="hint">Her satıra bir adres. İlki ana havuz, diğerleri yedek.</span></div>
          <div class="field"><label>Worker adı</label><input class="input mono" name="worker_template" value="${f?.worker_template || '%RIG_NAME%'}" maxlength="40">
            <span class="hint">%RIG_NAME% rig adıyla değiştirilir.</span></div>
          <div class="field"><label>Havuz şifresi</label><input class="input mono" name="pool_pass" value="${f?.pool_pass || 'x'}" maxlength="60"></div>
        </div>
        <div>
          <h3 style="margin-bottom:8px">Miner</h3>
          <div data-miners style="display:flex;flex-direction:column;gap:10px">${(f?.miners?.length ? f.miners : [{}]).map((m) => minerRow(versions, m))}</div>
          <button type="button" class="btn sm" style="margin-top:10px" data-row-add>${icon('plus')}İkinci miner ekle</button>
          <div class="hint" style="margin-top:6px">Karışık rig'de (AMD + NVIDIA) ya ikisini de destekleyen tek miner (lolMiner) ya da kart türüne göre iki miner seçin.</div>
        </div>`,
      onOpen: (dlg) => {
        const box = dlg.querySelector('[data-miners]');
        const sync = () => { dlg.querySelector('[data-row-add]').classList.toggle('hidden', box.children.length >= 2); };
        dlg.querySelector('[data-row-add]').addEventListener('click', () => { box.insertAdjacentHTML('beforeend', String(minerRow(versions))); sync(); });
        box.addEventListener('click', (e) => { if (e.target.closest('[data-row-del]') && box.children.length > 1) { e.target.closest('[data-miner-row]').remove(); sync(); } });
        sync();
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
