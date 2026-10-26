import { api, html, icon, openDialog, confirmDialog, toast, formData } from '../lib.js';

const FIELD_LABELS = {
  core_offset: ['Core offset', 'MHz'], mem_offset: ['Bellek offset', 'MHz'], power_limit_w: ['Güç limiti', 'W'], fan_pct: ['Fan', '%'],
  core_clock: ['Core saat', 'MHz'], mem_clock: ['Bellek saat', 'MHz'], core_mv: ['Core voltaj', 'mV'], mem_mv: ['Bellek voltaj', 'mV'],
};
const PRESETS = {
  nvidia: [
    { name: 'P106-100 · etchash', params: { core_offset: -200, mem_offset: 600, power_limit_w: 85, fan_pct: 65 } },
    { name: 'RTX 3080 · etchash', params: { core_offset: -400, mem_offset: 1000, power_limit_w: 230, fan_pct: 70 } },
  ],
  amd: [{ name: 'RX 580 · etchash', params: { core_clock: 1150, mem_clock: 2100, core_mv: 870, mem_mv: 900, fan_pct: 65 } }],
};

export async function ocView(el) {
  async function load() {
    const { oc_profiles: list, fields } = await api('oc-profiles');
    const section = (vendor, title) => {
      const items = list.filter((o) => o.vendor === vendor);
      return html`<div class="card section">
        <div class="card-head"><h2><span class="badge ${vendor}">${vendor === 'nvidia' ? 'NVIDIA' : 'AMD'}</span> ${title}</h2>
          <button class="btn sm" data-new="${vendor}">${icon('plus')}Profil ekle</button></div>
        ${items.length ? html`<div class="table-wrap"><table class="num">
          <thead><tr><th>Ad</th>${Object.keys(fields[vendor]).map((k) => html`<th class="r">${FIELD_LABELS[k][0]}</th>`)}<th class="r">Kullanım</th><th></th></tr></thead>
          <tbody>${items.map((o) => html`<tr>
            <td><strong>${o.name}</strong></td>
            ${Object.keys(fields[vendor]).map((k) => html`<td class="r">${o.params[k] ?? html`<span class="dim">—</span>`}${o.params[k] !== undefined ? html` <span class="small dim">${FIELD_LABELS[k][1]}</span>` : ''}</td>`)}
            <td class="r">${o.usage}</td>
            <td class="r"><div class="btn-row" style="justify-content:flex-end">
              <button class="btn sm icon" data-edit="${o.id}" aria-label="Düzenle">${icon('edit')}</button>
              <button class="btn sm icon danger" data-del="${o.id}" aria-label="Sil">${icon('trash')}</button></div></td>
          </tr>`)}</tbody></table></div>` : html`<div class="empty small">Profil yok. Boş alanlar stok değerde kalır.</div>`}
      </div>`;
    };
    el.innerHTML = String(html`
      <div class="page-head"><div class="grow"><h1>Overclock profilleri</h1>
        <div class="sub">Profili rig ayarlarından kart modeline (ör. sadece P106-100'lere) ya da tek bir karta atayın. Değişiklikler rig'e otomatik uygulanır.</div></div></div>
      ${section('nvidia', 'core / bellek offset, güç limiti')}
      ${section('amd', 'core / bellek saat, voltaj')}`);

    el.onclick = async (e) => {
      const b = e.target.closest('[data-new],[data-edit],[data-del]');
      if (!b) return;
      if (b.dataset.new) return profileDialog(fields, b.dataset.new, null);
      const o = list.find((x) => x.id === Number(b.dataset.edit || b.dataset.del));
      if (b.dataset.edit) return profileDialog(fields, o.vendor, o);
      if (!(await confirmDialog('Profil silinsin mi?', `"${o.name}" silinecek. Kullanan kartlar stok ayara döner.`, 'Sil'))) return;
      await api(`oc-profiles/${o.id}`, { method: 'DELETE' });
      toast('Profil silindi.');
      load();
    };
  }

  function profileDialog(fields, vendor, o) {
    openDialog({
      title: o ? 'Profili düzenle' : `Yeni ${vendor === 'nvidia' ? 'NVIDIA' : 'AMD'} profili`,
      body: html`
        ${o ? '' : html`<div class="field"><label>Hazır başlangıç değerleri</label><select data-preset><option value="">Boş</option>
          ${PRESETS[vendor].map((p, i) => html`<option value="${i}">${p.name}</option>`)}</select>
          <span class="hint">Başlangıç noktasıdır; her kart farklıdır, sıcaklık ve hatayı izleyerek ayarlayın.</span></div>`}
        <div class="field"><label>Ad</label><input class="input" name="name" value="${o?.name || ''}" maxlength="40" required></div>
        <div class="form-grid">${Object.entries(fields[vendor]).map(([k, [min, max]]) => html`
          <div class="field"><label>${FIELD_LABELS[k][0]} (${FIELD_LABELS[k][1]})</label>
            <input class="input num" type="number" name="${k}" min="${min}" max="${max}" step="1" value="${o?.params[k] ?? ''}" placeholder="stok">
            <span class="hint">${min} … ${max}</span></div>`)}</div>`,
      onOpen: (dlg) => dlg.querySelector('[data-preset]')?.addEventListener('change', (e) => {
        const p = PRESETS[vendor][e.target.value];
        if (!p) return;
        dlg.querySelector('[name=name]').value ||= p.name;
        for (const [k, v] of Object.entries(p.params)) dlg.querySelector(`[name=${k}]`).value = v;
      }),
      onSubmit: async (form) => {
        const d = formData(form);
        const params = {};
        for (const k of Object.keys(fields[vendor])) if (d[k] !== '') params[k] = Number(d[k]);
        await api(o ? `oc-profiles/${o.id}` : 'oc-profiles', { method: o ? 'PUT' : 'POST', body: { name: d.name, vendor, params } });
        toast('Profil kaydedildi.');
        load();
      },
    });
  }

  await load();
  return () => { el.onclick = null; };
}
