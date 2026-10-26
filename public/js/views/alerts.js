import { api, html, ago, dateTime, ALERT_LABELS } from '../lib.js';
import { setAlertBadge } from '../app.js';

export async function alertsView(el) {
  let status = 'open';
  let timer = null;

  async function load() {
    const { alerts } = await api(`alerts?status=${status === 'open' ? 'open' : 'resolved'}`);
    if (status === 'open') setAlertBadge(alerts.length);
    el.innerHTML = String(html`
      <div class="page-head">
        <div class="grow"><h1>Uyarılar</h1><div class="sub">Eşikleri <a href="settings">Ayarlar</a> sayfasından değiştirebilirsiniz.</div></div>
        <div class="seg"><button data-s="open" class="${status === 'open' ? 'on' : ''}">Aktif</button><button data-s="resolved" class="${status === 'resolved' ? 'on' : ''}">Geçmiş</button></div>
      </div>
      <div class="card">
        ${alerts.length ? html`<ul class="list-plain">${alerts.map((a) => html`<li>
          <span class="badge ${a.resolved_at ? '' : a.severity === 'critical' ? 'bad' : 'warn'}">${a.severity === 'critical' ? 'Kritik' : 'Uyarı'}</span>
          <span class="grow"><strong>${ALERT_LABELS[a.type] || a.type}</strong> · <a href="rigs/${a.rig_id}">${a.rig_name}</a>
            <div class="small muted">${a.message}</div></span>
          <span class="small dim" style="text-align:right">${a.resolved_at ? html`${dateTime(a.started_at)}<br>düzeldi ${ago(a.resolved_at)}` : `${ago(a.started_at)} başladı`}</span>
        </li>`)}</ul>` : html`<div class="empty">${status === 'open' ? 'Aktif uyarı yok. Her şey yolunda.' : 'Geçmiş uyarı yok.'}</div>`}
      </div>`);
    el.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => { status = b.dataset.s; load(); }));
  }
  await load();
  timer = setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 15_000);
  return () => clearInterval(timer);
}
