import { api, html, icon, state, openDialog, confirmDialog, toast, formData, dateTime } from '../lib.js';
import { openPairDialog } from './rigs.js';

const step = (n, title, body) => html`
  <div class="card step">
    <div class="step-num">${n}</div>
    <div class="step-body"><h2>${title}</h2>${body}</div>
  </div>`;

export async function setupView(el) {
  const admin = state.me.is_admin;

  async function load() {
    const { images } = await api('os-images');
    const latest = images[0] || null;
    const file = latest ? latest.download_url.split('/').pop() : 'whispermining-1.0.0.img.xz';

    el.innerHTML = String(html`
      <div class="page-head">
        <div class="grow"><h1>Flash kurulumu</h1>
          <div class="sub">Rig'i flash bellekten açmak için gereken her şey. Ortalama 15 dakika sürer.</div></div>
      </div>

      <div class="steps">
        ${step(1, 'Gerekenler', html`
          <ul class="checklist">
            <li><strong>USB flash bellek</strong>: en az 16 GB, USB 3.0 önerilir (ya da küçük bir SSD). İçindekiler silinir.</li>
            <li><strong>Windows / Mac bilgisayar</strong>: imajı flash belleğe yazmak için.</li>
            <li><strong>Ethernet kablosu</strong>: rig'in internete kabloyla bağlanması önerilir.</li>
            <li>Panelde bu rig için indirilmiş <strong>rig.conf</strong> dosyası (4. adım).</li>
          </ul>`)}

        ${step(2, 'WhisperMining imajını indirin', latest ? html`
          <div class="download-box">
            <div class="grow">
              <div><strong>WhisperMining OS ${latest.version}</strong> ${latest.size_mb ? html`<span class="dim small">· ${(latest.size_mb / 1024).toFixed(1)} GB</span>` : ''}
                <span class="dim small">· ${dateTime(latest.created_at)}</span></div>
              ${latest.notes ? html`<div class="small muted">${latest.notes}</div>` : ''}
              <div class="small dim mono" style="word-break:break-all;margin-top:4px">SHA256: ${latest.sha256}</div>
            </div>
            <a class="btn primary" href="${latest.download_url}" rel="noopener">${icon('download')}İmajı indir</a>
          </div>
          <details class="small muted" style="margin-top:10px"><summary>İndirilen dosya bozuk mu? (isteğe bağlı kontrol)</summary>
            <p>Windows'ta PowerShell açıp dosyanın olduğu klasörde çalıştırın; çıkan değer yukarıdaki SHA256 ile aynı olmalı:</p>
            <pre class="code">Get-FileHash .\\${file} -Algorithm SHA256</pre>
          </details>`
    : html`<div class="callout warn">İmaj henüz yayınlanmadı. Rig'e kurulacak Ubuntu imajı ve agent hazırlanıyor (Aşama 2).
            Yayınlandığında indirme bağlantısı burada görünecek.</div>`)}

        ${step(3, 'İmajı flash belleğe yazın', html`
          <p class="muted">Ücretsiz <strong>balenaEtcher</strong> programını kullanın. Sıkıştırılmış dosyayı (.img.xz) açmanıza gerek yok.</p>
          <div class="btn-row" style="margin-bottom:12px">
            <a class="btn" href="https://etcher.balena.io/" target="_blank" rel="noopener">${icon('download')}balenaEtcher (Windows / Mac / Linux)</a>
            <a class="btn" href="https://rufus.ie/" target="_blank" rel="noopener">${icon('download')}Rufus (Windows, alternatif)</a>
          </div>
          <ol class="numbered">
            <li>balenaEtcher'ı açın, <em>Flash from file</em> ile indirdiğiniz imajı seçin.</li>
            <li><em>Select target</em> ile flash belleği seçin. <strong>Doğru diski seçtiğinizden emin olun</strong>, seçilen diskteki her şey silinir.</li>
            <li><em>Flash!</em> düğmesine basın, yazma ve doğrulama bitene kadar bekleyin (5–10 dk).</li>
          </ol>
          <div class="hint">Rufus kullanıyorsanız sorulduğunda <strong>"DD imajı modunda yaz"</strong> seçeneğini seçin.</div>`)}

        ${step(4, 'rig.conf dosyasını flash belleğe kopyalayın', html`
          <ol class="numbered">
            <li>Yazma bitince flash belleği çıkarıp yeniden takın. <strong>WMINING</strong> adlı küçük bir bölüm açılır
              (Windows "diski biçimlendir" diye sorarsa <strong>Hayır / İptal</strong> deyin; diğer bölüm Linux içindir).</li>
            <li>Panelde <strong>Rig ekle → rig.conf ile</strong> deyip rig'e bir ad verin, <strong>rig.conf</strong> iner.</li>
            <li>Dosyayı WMINING bölümünün içine kopyalayın. Adı tam olarak <span class="mono">rig.conf</span> olmalı.</li>
          </ol>
          <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-add-rig>${icon('plus')}Rig ekle / rig.conf indir</button></div>
          <div class="callout" style="margin-top:12px">Her rig için <strong>ayrı</strong> rig.conf indirin. Aynı dosyayı iki rig'e kopyalarsanız
            ikisi tek rig gibi görünür ve panelde "Donanım değişti" uyarısı çıkar.</div>`)}

        ${step(5, 'Rig BIOS ayarları', html`
          <p class="muted">Rig'i açarken <span class="mono">Del</span> ya da <span class="mono">F2</span> ile BIOS'a girin. Menü adları anakarta göre değişir.</p>
          <table class="kv-table">
            <tbody>
              <tr><td><strong>Above 4G Decoding</strong></td><td>Açık (Enabled). Çok kartlı rig'lerde şart; kapalıysa kartlar eksik görünür.</td></tr>
              <tr><td><strong>PCIe hızı</strong></td><td>Gen1 ya da Gen2. Riser kullanılıyorsa kart düşmelerini önler.</td></tr>
              <tr><td><strong>Açılış sırası</strong></td><td>USB flash bellek ilk sırada.</td></tr>
              <tr><td><strong>Elektrik gelince aç</strong></td><td><em>Restore on AC Power Loss → Power On</em>. Elektrik kesilip gelince rig kendiliğinden açılır.</td></tr>
              <tr><td><strong>Ekran</strong></td><td>P106-100'lerin görüntü çıkışı yoktur. Monitör gerekirse anakartın kendi çıkışını (iGPU) kullanın; rig.conf yönteminde monitör gerekmez.</td></tr>
            </tbody>
          </table>`)}

        ${step(6, 'Rig\'i açın', html`
          <ol class="numbered">
            <li>Flash belleği rig'e takın, Ethernet kablosunu bağlayın, rig'i açın.</li>
            <li>İlk açılış 2–5 dakika sürer (sürücüler hazırlanır, kartlar taranır).</li>
            <li>Rig <a href="rigs">Rig'ler</a> sayfasında <strong>çevrimiçi</strong> görünür ve kartları listelenir.</li>
            <li>Rig'e bir <a href="flight-sheets">flight sheet</a> atayın; miner indirilir ve kendiliğinden başlar.</li>
          </ol>`)}
      </div>

      <div class="card section">
        <div class="card-head"><h2>Sorun giderme</h2></div>
        <div class="faq">
          <details><summary>Rig panelde hiç görünmüyor</summary>
            <ul><li>Ethernet kablosunu ve modemi kontrol edin; rig internete çıkabilmeli.</li>
              <li>Dosya adı <span class="mono">rig.conf.txt</span> olmuş olabilir. Windows'ta <em>Görünüm → Dosya adı uzantıları</em>'nı açıp kontrol edin.</li>
              <li>rig.conf'u panelden yeniden oluşturduysanız eski dosya geçersizdir; yenisini kopyalayın.</li>
              <li>Monitör bağlıysa ekrandaki hata mesajına bakın.</li></ul></details>
          <details><summary>Bazı kartlar listede yok</summary>
            <ul><li>BIOS'ta <strong>Above 4G Decoding</strong> açık olmalı.</li>
              <li>Riser'ın USB kablosunu, riser'a giden güç kablosunu ve kartın PCIe güç kablolarını kontrol edin.</li>
              <li>PCIe hızını Gen1'e düşürmeyi deneyin.</li></ul></details>
          <details><summary>Kart sık sık kayboluyor ya da hashrate düşüyor</summary>
            <ul><li>Genelde OC fazla gelmiştir: <a href="overclock">OC profilinde</a> bellek offset'ini 100–200 MHz düşürün.</li>
              <li>Güç kaynağı yetersiz olabilir; toplam güç, PSU kapasitesinin %80'ini geçmemeli.</li></ul></details>
          <details><summary>RX 580 (AMD) kartlar hakkında</summary>
            <ul><li>İmaj, Polaris kartlar için uygun OpenCL sürücüsüyle gelir; ayrıca sürücü kurmanız gerekmez.</li>
              <li>AMD kartlar için TeamRedMiner ya da lolMiner seçin (T-Rex sadece NVIDIA'da çalışır).</li></ul></details>
          <details><summary>Flash belleği başka rig'de kullanmak istiyorum</summary>
            <ul><li>Eski rig'i panelden kaldırın ya da yeni rig için ayrı rig.conf indirip WMINING bölümündeki dosyanın üzerine yazın.</li></ul></details>
        </div>
      </div>

      ${admin ? html`
        <div class="page-head section" style="margin-top:28px">
          <div class="grow"><h2>İmaj sürümleri</h2><div class="sub">Sadece yönetici görür. En son eklenen sürüm 2. adımda gösterilir.</div></div>
          <button class="btn" data-image-new>${icon('plus')}İmaj yayınla</button>
        </div>
        <div class="card">${images.length ? html`<ul class="list-plain">${images.map((i) => html`<li>
          <strong>${i.version}</strong><span class="grow small mono dim">${i.download_url}</span><span class="small dim">${dateTime(i.created_at)}</span>
          <button class="btn sm icon danger" data-image-del="${i.id}" aria-label="Sil">${icon('trash')}</button></li>`)}</ul>`
    : html`<div class="empty small">Henüz imaj yayınlanmadı.</div>`}</div>` : ''}`);

    el.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-add-rig')) return openPairDialog();
      if (b.hasAttribute('data-image-new')) return imageDialog();
      if (b.dataset.imageDel && await confirmDialog('İmaj silinsin mi?', 'Bu sürüm kurulum sayfasından kaldırılacak.', 'Sil')) {
        await api(`os-images/${b.dataset.imageDel}`, { method: 'DELETE' });
        toast('Silindi.');
        load();
      }
    };
  }

  function imageDialog() {
    openDialog({
      title: 'İmaj yayınla',
      submitLabel: 'Yayınla',
      body: html`<div class="form-grid">
        <div class="field"><label>Sürüm</label><input class="input mono" name="version" placeholder="1.0.0" required></div>
        <div class="field"><label>Boyut (MB)</label><input class="input" type="number" name="size_mb" placeholder="2400"></div>
        <div class="field full"><label>İndirme adresi (https)</label><input class="input mono" name="download_url" required></div>
        <div class="field full"><label>SHA256</label><input class="input mono" name="sha256" maxlength="64" required></div>
        <div class="field full"><label>Notlar</label><textarea name="notes" placeholder="ör. NVIDIA 535, AMD Polaris OpenCL"></textarea></div></div>`,
      onSubmit: async (form) => { await api('os-images', { method: 'POST', body: formData(form) }); toast('İmaj yayınlandı.'); load(); },
    });
  }

  await load();
  return () => { el.onclick = null; };
}
