// Chart.js üzerinde ince bir katman: tek serili zaman grafikleri, tema renkleriyle
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const timeLabel = (ts) => new Date(ts * 1000).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

function withAlpha(hex, a) {
  const m = hex.replace('#', '').match(/.{2}/g);
  if (!m) return hex;
  const [r, g, b] = m.map((x) => parseInt(x, 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// opts: { points: [[ts, value]], colorVar, label, format(v), ref: { value, label } , min }
export function timeChart(canvas, opts) {
  const Chart = window.Chart;
  if (!Chart) return null;
  const color = css(opts.colorVar);
  const text2 = css('--text-2');
  const text3 = css('--text-3');
  const grid = css('--chart-grid');
  const data = opts.points.map(([x, y]) => ({ x, y }));
  const datasets = [{
    label: opts.label,
    data,
    borderColor: color,
    backgroundColor: withAlpha(color, 0.12),
    borderWidth: 2,
    fill: opts.fill !== false ? 'origin' : false,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointHoverBorderWidth: 2,
    pointHoverBorderColor: css('--surface'),
    pointHoverBackgroundColor: color,
    tension: 0.25,
    spanGaps: 600, // 10 dakikadan uzun boşlukları birleştirme
  }];
  if (opts.ref && data.length) {
    datasets.push({
      label: opts.ref.label,
      data: [{ x: data[0].x, y: opts.ref.value }, { x: data[data.length - 1].x, y: opts.ref.value }],
      borderColor: text3,
      borderWidth: 1,
      borderDash: [4, 4],
      pointRadius: 0,
      pointHoverRadius: 0,
      fill: false,
    });
  }
  return new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', axis: 'x', intersect: false },
      parsing: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (item) => item.datasetIndex === 0,
          displayColors: false,
          backgroundColor: css('--text'),
          titleColor: css('--bg'),
          bodyColor: css('--bg'),
          padding: 8,
          callbacks: {
            title: (items) => (items[0] ? new Date(items[0].parsed.x * 1000).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''),
            label: (item) => `${opts.label}: ${opts.format(item.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: data.length ? data[0].x : undefined,
          max: data.length ? data[data.length - 1].x : undefined,
          grid: { display: false },
          border: { color: grid },
          // Yerel saate hizalı, düzenli aralıklı etiketler (24 saatte 4 saatte bir)
          afterBuildTicks: (axis) => {
            const span = axis.max - axis.min;
            const step = span > 12 * 3600 ? 4 * 3600 : span > 3 * 3600 ? 3600 : 900;
            const offset = new Date().getTimezoneOffset() * 60;
            const first = Math.ceil((axis.min - offset) / step) * step + offset;
            axis.ticks = [];
            for (let v = first; v <= axis.max; v += step) axis.ticks.push({ value: v });
          },
          ticks: { color: text3, callback: (v) => timeLabel(v), font: { size: 11 } },
        },
        y: {
          min: opts.min ?? 0,
          suggestedMax: opts.suggestedMax,
          grid: { color: grid },
          border: { display: false },
          ticks: { color: text2, maxTicksLimit: 5, callback: (v) => opts.format(v), font: { size: 11 } },
        },
      },
    },
  });
}

export function emptyNote(canvas, msg = 'Henüz veri yok') {
  const box = canvas.parentElement;
  box.innerHTML = '';
  const p = document.createElement('div');
  p.className = 'empty small';
  p.style.padding = '70px 0';
  p.textContent = msg;
  box.append(p);
}
