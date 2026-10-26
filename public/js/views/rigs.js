import { api, html, icon, splitHash, fmtHash, fmtPower, fmtTemp, tempClass, ago, MINER_STATUS, openDialog, toast, downloadText } from '../lib.js';
import { navigate, setAlertBadge } from '../app.js';

function rigCard(r) {
  const waiting = !r.last_seen_at; // rig.conf ile eklendi, henüz açılmadı
  const [label, cls] = waiting ? ['Bağlantı bekleniyor', 'warn'] : MINER_STATUS[r.miner_status] || MINER_STATUS.unknown;
  const strip = [];
  for (let i = 0; i < r.gpu_count; i++) strip.push(html`<span class="${r.online ? 'ok' : 'off'}"></span>`);
  for (let i = 0; i < r.gpu_lost; i++) strip.push(html`<span class="bad"></span>`);
  return html`
    <a class="card rig-card" href="rigs/${r.id}">
      <div class="top">
        <span class="dot ${r.online ? 'ok' : waiting ? 'warn' : 'bad'}"></span>
        <span class="name">${r.name}</span>
        <span class="badge ${cls}">${label}</span>
      </div>
      <div class="meta">
        ${r.coin ? html`<span class="badge">${r.coin} · ${r.algo}</span>` : html`<span class="badge warn">Flight sheet yok</span>`}
        ${r.nvidia ? html`<span class="badge nvidia">NVIDIA ×${r.nvidia}</span>` : ''}
        ${r.amd ? html`<span class="badge amd">AMD ×${r.amd}</span>` : ''}
        ${r.gpu_lost ? html`<span class="badge bad">${r.gpu_lost} kart kayıp</span>` : ''}
        ${r.open_alerts ? html`<span class="badge bad">${r.open_alerts} uyarı</span>` : ''}
      </div>
      <div class="stats num">
        <div><div class="k">Hashrate</div><div class="v">${r.online ? fmtHash(r.hashrate) : '—'}</div></div>
        <div><div class="k">Güç</div><div class="v">${r.online ? fmtPower(r.power) : '—'}</div></div>
        <div><div class="k">En yüksek</div><div class="v ${tempClass(r.temp_max)}">${r.online ? fmtTemp(r.temp_max) : '—'}</div></div>
      </div>
      <div class="gpu-strip" title="${r.gpu_count} kart">${strip}</div>
      ${r.online ? '' : html`<div class="small dim" style="margin-top:8px">${waiting ? 'rig.conf flash belleğe kopyalanıp rig açılınca görünecek.' : `Son görülme: ${ago(r.last_seen_at)}`}</div>`}
    </a>`;
}

const formatCode = (input) => {
  const c = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
  input.value = c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
};

export function openPairDialog() {
  let mode = 'conf';
  let created = null; // { rig_id, conf } — anahtar sadece bu diyalog açıkken tekrar indirilebilir
  openDialog({
    title: 'Yeni rig ekle',
    submitLabel: 'Oluştur ve rig.conf indir',
    body: html`
      <div class="seg" data-mode-seg style="align-self:flex-start">
        <button type="button" data-mode="conf" class="on">rig.conf ile (önerilen)</button>
        <button type="button" data-mode="code">Eşleştirme kodu</button>
      </div>
      <div data-panel="conf" style="display:flex;flex-direction:column;gap:14px">
        <p class="muted" style="margin:0">Rig önceden oluşturulur. İnen <strong>rig.conf</strong> dosyasını flash belleğin FAT bölümüne kopyalayın;
          rig açılınca kendiliğinden bağlanır. Ekran ya da kod gerekmez.</p>
        <div class="field"><label for="conf-name">Rig adı</label>
          <input class="input" id="conf-name" name="conf_name" maxlength="40" placeholder="ör. Salon-1"></div>
      </div>
      <div data-panel="code" class="hidden" style="flex-direction:column;gap:14px">
        <p class="muted" style="margin:0">Monitör bağlı rig'ler için: rig'i flash bellekten açın, ekranda görünen kodu girin.</p>
        <div class="field"><label for="pair-code">Eşleştirme kodu</label>
          <input class="input code-input" id="pair-code" name="code" placeholder="K7F2-9QX" maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>
        <div class="field"><label for="pair-name">Rig adı</label>
          <input class="input" id="pair-name" name="name" maxlength="40" placeholder="ör. Salon-1"><span class="hint">Boş bırakılırsa rig'in kendi adı kullanılır.</span></div>
      </div>
      <div data-panel="done" class="hidden" style="flex-direction:column;gap:12px">
        <div class="callout" style="background:var(--accent-soft);color:var(--ok)"><strong>rig.conf indirildi.</strong> Bu dosyadaki anahtar bir daha gösterilmez.</div>
        <ol class="muted" style="margin:0;padding-left:20px;line-height:1.7">
          <li>Flash belleği bilgisayara takın, <strong>WMINING</strong> adlı bölümü açın.</li>
          <li><strong>rig.conf</strong> dosyasını oraya kopyalayın (varsa üzerine yazın).</li>
          <li>Flash'ı rig'e takıp açın. Birkaç dakika içinde panelde çevrimiçi görünür.</li>
        </ol>
        <a href="setup" data-setup-link class="small">İmaj indirme ve ayrıntılı kurulum rehberi →</a>
        <div class="btn-row"><button type="button" class="btn" data-redownload>Tekrar indir</button>
          <button type="button" class="btn primary" data-goto>Rig sayfasına git</button></div>
      </div>`,
    onOpen: (dlg) => {
      const submit = dlg.querySelector('[data-submit]');
      const show = (name) => dlg.querySelectorAll('[data-panel]').forEach((p) => {
        p.classList.toggle('hidden', p.dataset.panel !== name);
        if (p.dataset.panel === name) p.style.display = 'flex';
      });
      dlg.querySelector('[data-mode-seg]').addEventListener('click', (e) => {
        const b = e.target.closest('[data-mode]');
        if (!b || created) return;
        mode = b.dataset.mode;
        dlg.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
        show(mode);
        submit.textContent = mode === 'conf' ? 'Oluştur ve rig.conf indir' : 'Eşleştir';
        dlg.querySelector(mode === 'conf' ? '#conf-name' : '#pair-code').focus();
      });
      const code = dlg.querySelector('#pair-code');
      code.addEventListener('input', () => formatCode(code));
      dlg.querySelector('[data-redownload]').addEventListener('click', () => downloadText('rig.conf', created.conf));
      dlg.querySelector('[data-goto]').addEventListener('click', () => { dlg.close(); navigate(`rigs/${created.rig_id}`); });
      dlg.addEventListener('close', () => { created = null; });
      dlg.querySelector('[data-setup-link]').addEventListener('click', () => dlg.close());
      dlg._showDone = () => {
        show('done');
        dlg.querySelector('[data-mode-seg]').classList.add('hidden');
        submit.classList.add('hidden');
      };
      dlg.querySelector('#conf-name').focus();
    },
    onSubmit: async (form, dlg) => {
      if (mode === 'code') {
        const res = await api('rigs/pair', { method: 'POST', body: { code: form.code.value, name: form.name.value } });
        toast('Rig hesabınıza eklendi.');
        navigate(`rigs/${res.rig_id}`);
        return true;
      }
      created = await api('rigs', { method: 'POST', body: { name: form.conf_name.value } });
      downloadText('rig.conf', created.conf);
      dlg._showDone();
      return false; // diyalog açık kalsın: kurulum adımları gösterilir
    },
  });
}

export async function rigsView(el) {
  let timer = null;
  async function load() {
    const { rigs } = await api('rigs');
    const online = rigs.filter((r) => r.online);
    const totalHash = online.reduce((s, r) => s + (r.hashrate || 0), 0);
    const totalPower = online.reduce((s, r) => s + (r.power || 0), 0);
    const maxTemp = online.reduce((m, r) => (r.temp_max !== null && r.temp_max > (m ?? -1) ? r.temp_max : m), null);
    const gpus = rigs.reduce((s, r) => s + r.gpu_count, 0);
    setAlertBadge(rigs.reduce((s, r) => s + r.open_alerts, 0));

    // Farklı algoritmalardaki hashrate'leri toplamak anlamsız: tek algo ise toplam göster
    const algos = new Set(online.map((r) => r.algo).filter(Boolean));
    el.innerHTML = String(html`
      <div class="page-head">
        <div class="grow"><h1>Rig'ler</h1><div class="sub">${rigs.length} rig · ${gpus} kart</div></div>
        <button class="btn primary" data-pair>${icon('plus')}Rig ekle</button>
      </div>
      ${rigs.length ? html`
        <div class="tiles">
          <div class="card tile"><div class="label">Çevrimiçi</div><div class="value num">${online.length}<small>/ ${rigs.length}</small></div></div>
          <div class="card tile"><div class="label">Toplam hashrate${algos.size === 1 ? ` · ${[...algos][0]}` : ''}</div>
            <div class="value num">${algos.size > 1 ? html`<span class="small muted">Karışık algoritma</span>` : splitHash(totalHash)}</div></div>
          <div class="card tile"><div class="label">Toplam güç</div><div class="value num">${fmtPower(totalPower)}</div></div>
          <div class="card tile"><div class="label">En yüksek sıcaklık</div><div class="value num ${tempClass(maxTemp)}">${fmtTemp(maxTemp)}</div></div>
        </div>
        <div class="rig-list">${rigs.map(rigCard)}</div>` : html`
        <div class="card empty">
          <h2>Henüz rig yok</h2>
          <p>Rig ekle'ye tıklayın, inen rig.conf dosyasını flash belleğe kopyalayın ve rig'i açın.</p>
          <button class="btn primary" data-pair>${icon('plus')}İlk rig'i ekle</button>
        </div>`}`);
    el.querySelectorAll('[data-pair]').forEach((b) => b.addEventListener('click', openPairDialog));
  }
  await load();
  timer = setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]')) load().catch(() => {}); }, 10_000);
  return () => clearInterval(timer);
}
