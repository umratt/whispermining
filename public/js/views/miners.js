import { api, html, icon, openDialog, confirmDialog, toast, formData, state, dateTime } from '../lib.js';

export async function minersView(el) {
  const admin = state.me.is_admin;

  async function load() {
    const [{ miners }, releases] = await Promise.all([api('miners'), admin ? api('agent-releases') : Promise.resolve(null)]);
    el.innerHTML = String(html`
      <div class="page-head">
        <div class="grow"><h1>Miner kataloğu</h1><div class="sub">Agent sadece buradaki adresten indirir ve SHA256 kontrolü yapar.</div></div>
        ${admin ? html`<button class="btn" data-miner-new>${icon('plus')}Miner ekle</button>` : ''}
      </div>
      ${miners.some((m) => m.versions.some((v) => !v.sha256)) ? html`<div class="callout warn" style="margin-bottom:14px">
        SHA256'sı girilmemiş sürümler var. Agent bu sürümleri güvenlik için indirmez. Hash'i miner'ın resmi sürüm sayfasından kontrol edip girin.</div>` : ''}
      <div class="grid">${miners.map((m) => html`
        <div class="card">
          <div class="card-head">
            <h2>${m.name} ${m.supports_nvidia ? html`<span class="badge nvidia">NVIDIA</span>` : ''} ${m.supports_amd ? html`<span class="badge amd">AMD</span>` : ''}</h2>
            ${admin ? html`<button class="btn sm" data-version-new="${m.id}">${icon('plus')}Sürüm ekle</button>` : ''}
          </div>
          ${m.notes ? html`<div class="card-pad small muted" style="padding-bottom:0">${m.notes}</div>` : ''}
          <div class="table-wrap"><table>
            <thead><tr><th>Sürüm</th><th class="hide-sm">Algoritmalar</th><th>SHA256</th><th class="hide-sm">İndirme</th>${admin ? html`<th></th>` : ''}</tr></thead>
            <tbody>${m.versions.map((v) => html`<tr>
              <td><strong>${v.version}</strong> ${v.is_default ? html`<span class="badge ok">Varsayılan</span>` : ''}</td>
              <td class="hide-sm small" style="white-space:normal">${v.algos.split(',').join(', ')}</td>
              <td>${v.sha256 ? html`<span class="mono" title="${v.sha256}">${v.sha256.slice(0, 12)}…</span>` : html`<span class="badge warn">Girilmedi</span>`}</td>
              <td class="hide-sm mono small" style="max-width:280px;overflow:hidden;text-overflow:ellipsis" title="${v.download_url}">${v.download_url.replace(/^https:\/\//, '')}</td>
              ${admin ? html`<td class="r"><div class="btn-row" style="justify-content:flex-end">
                <button class="btn sm icon" data-version-edit="${v.id}" aria-label="Düzenle">${icon('edit')}</button>
                <button class="btn sm icon danger" data-version-del="${v.id}" aria-label="Sil">${icon('trash')}</button></div></td>` : ''}
            </tr>`)}</tbody></table></div>
        </div>`)}</div>
      ${releases ? html`
        <div class="page-head section" style="margin-top:28px">
          <div class="grow"><h2>Agent sürümleri</h2><div class="sub">Rig'ler kendilerinden yeni bir sürüm görünce otomatik güncellenir.</div></div>
          <button class="btn" data-release-new>${icon('plus')}Sürüm yayınla</button>
        </div>
        <div class="card">${releases.releases.length ? html`<ul class="list-plain">${releases.releases.map((r) => html`<li>
          <strong>${r.version}</strong><span class="badge ${r.channel === 'beta' ? 'warn' : 'ok'}">${r.channel}</span>
          <span class="grow small muted">${r.notes || ''}</span><span class="small dim">${dateTime(r.created_at)}</span>
          <button class="btn sm icon danger" data-release-del="${r.id}" aria-label="Sil">${icon('trash')}</button></li>`)}</ul>`
    : html`<div class="empty small">Henüz agent sürümü yayınlanmadı (Aşama 2).</div>`}</div>` : ''}`);

    const versions = miners.flatMap((m) => m.versions.map((v) => ({ ...v, miner: m.name })));
    el.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const d = b.dataset;
      try {
        if (d.minerNew !== undefined) return minerDialog();
        if (d.versionNew) return versionDialog(Number(d.versionNew), null);
        if (d.versionEdit) return versionDialog(null, versions.find((v) => v.id === Number(d.versionEdit)));
        if (d.versionDel && await confirmDialog('Sürüm silinsin mi?', 'Bu sürüm katalogdan kaldırılacak.', 'Sil')) {
          await api(`miner-versions/${d.versionDel}`, { method: 'DELETE' }); toast('Sürüm silindi.'); load();
        }
        if (d.releaseNew !== undefined) return releaseDialog();
        if (d.releaseDel && await confirmDialog('Agent sürümü silinsin mi?', 'Rig\'ler bu sürüme güncellenmez.', 'Sil')) {
          await api(`agent-releases/${d.releaseDel}`, { method: 'DELETE' }); toast('Silindi.'); load();
        }
      } catch (err) { toast(err.message, 'bad'); }
    };
  }

  function minerDialog() {
    openDialog({
      title: 'Miner ekle',
      body: html`<div class="form-grid">
        <div class="field"><label>Ad</label><input class="input" name="name" placeholder="ör. GMiner" required></div>
        <div class="field"><label>API türü</label><input class="input mono" name="api_type" placeholder="gminer" required><span class="hint">Agent'ın istatistik okuma eklentisi.</span></div>
        <label class="check"><input type="checkbox" name="supports_nvidia">NVIDIA destekler</label>
        <label class="check"><input type="checkbox" name="supports_amd">AMD destekler</label>
        <div class="field full"><label>Not</label><input class="input" name="notes"></div></div>`,
      onSubmit: async (form) => {
        const f = formData(form);
        await api('miners', { method: 'POST', body: { ...f, supports_nvidia: !!f.supports_nvidia, supports_amd: !!f.supports_amd } });
        toast('Miner eklendi.'); load();
      },
    });
  }

  function versionDialog(minerId, v) {
    openDialog({
      title: v ? `${v.miner} ${v.version}` : 'Sürüm ekle',
      body: html`
        ${v ? '' : html`<div class="field"><label>Sürüm</label><input class="input" name="version" placeholder="ör. 1.98" required></div>`}
        <div class="field"><label>İndirme adresi (https)</label><input class="input mono" name="download_url" value="${v?.download_url || ''}" required></div>
        <div class="field"><label>SHA256</label><input class="input mono" name="sha256" value="${v?.sha256 || ''}" maxlength="64" spellcheck="false" placeholder="64 karakter hex">
          <span class="hint">Linux'ta: sha256sum dosya.tar.gz</span></div>
        <div class="field"><label>Algoritmalar</label><input class="input mono" name="algos" value="${v?.algos || ''}" placeholder="etchash,kawpow"></div>
        <label class="check"><input type="checkbox" name="is_default" ${v?.is_default ? 'checked' : ''}>Varsayılan sürüm</label>`,
      onSubmit: async (form) => {
        const f = formData(form);
        const body = { ...f, is_default: !!f.is_default };
        if (v) await api(`miner-versions/${v.id}`, { method: 'PUT', body });
        else await api(`miners/${minerId}/versions`, { method: 'POST', body });
        toast('Sürüm kaydedildi.'); load();
      },
    });
  }

  function releaseDialog() {
    openDialog({
      title: 'Agent sürümü yayınla',
      submitLabel: 'Yayınla',
      body: html`<div class="form-grid">
        <div class="field"><label>Sürüm</label><input class="input mono" name="version" placeholder="1.0.0" required></div>
        <div class="field"><label>Kanal</label><select name="channel"><option value="stable">stable</option><option value="beta">beta</option></select></div>
        <div class="field full"><label>İndirme adresi (https)</label><input class="input mono" name="download_url" required></div>
        <div class="field full"><label>SHA256</label><input class="input mono" name="sha256" maxlength="64" required></div>
        <div class="field full"><label>Notlar</label><textarea name="notes"></textarea></div></div>`,
      onSubmit: async (form) => { await api('agent-releases', { method: 'POST', body: formData(form) }); toast('Yayınlandı.'); load(); },
    });
  }

  await load();
  return () => { el.onclick = null; };
}
