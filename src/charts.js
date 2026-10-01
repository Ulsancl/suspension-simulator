const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const format = (value, digits = 2) => Number.isFinite(value) ? (Math.abs(value) < .5 * 10 ** -digits ? 0 : value).toFixed(digits) : '—';
const SERIES = {
  bodyY: { label: '차체', unit: 'mm', scale: 1000, color: '#54dfc5' },
  wheelY: { label: '휠', unit: 'mm', scale: 1000, color: '#79baff' },
  rawRoadY: { label: '노면', unit: 'mm', scale: 1000, color: '#f3b277', dashed: true },
  contactForce: { label: '접지력', unit: 'kN', scale: .001, color: '#54dfc5' },
  springForce: { label: '스프링 힘', unit: 'kN', scale: .001, color: '#f3b277' },
  bodyAcceleration: { label: '차체', unit: 'm/s²', scale: 1, color: '#54dfc5' },
  wheelAcceleration: { label: '휠', unit: 'm/s²', scale: 1, color: '#79baff' },
};
const DEFINITIONS = [
  { id: 'motion-chart', key: 'motion', unit: 'mm', keys: ['bodyY', 'wheelY', 'rawRoadY'], minimum: 5, positive: false },
  { id: 'force-chart', key: 'force', unit: 'kN', keys: ['contactForce', 'springForce'], minimum: .5, positive: true },
  { id: 'acceleration-chart', key: 'acceleration', unit: 'm/s²', keys: ['bodyAcceleration', 'wheelAcceleration'], minimum: .5, positive: false },
];

function niceStep(range, ticks) {
  const raw = Math.max(range / ticks, 1e-8), power = 10 ** Math.floor(Math.log10(raw)), fraction = raw / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
}
function nearest(rows, time) {
  if (!rows.length) return null;
  let low = 0, high = rows.length - 1;
  while (low < high) { const mid = (low + high) >> 1; if (rows[mid].time < time) low = mid + 1; else high = mid; }
  return low > 0 && Math.abs(rows[low - 1].time - time) < Math.abs(rows[low].time - time) ? rows[low - 1] : rows[low];
}
function stats(rows, key, scale = 1) {
  if (!rows.length) return { min: 0, max: 0, peak: 0, rms: 0 };
  let min = Infinity, max = -Infinity, sum = 0;
  for (const row of rows) { const value = (row[key] || 0) * scale; min = Math.min(min, value); max = Math.max(max, value); sum += value * value; }
  return { min, max, peak: Math.max(Math.abs(min), Math.abs(max)), rms: Math.sqrt(sum / rows.length) };
}

export class AnalysisCharts {
  constructor() {
    this.windowSeconds = 8; this.follow = true; this.end = 8; this.cursorTime = null;
    this.visibleSeries = new Set(Object.keys(SERIES)); this.history = []; this.state = { time: 0 }; this.config = {};
    this.activeChart = 'motion'; this.lastPaint = 0; this.drag = null; this.frames = new Map();
    this.definitions = DEFINITIONS.filter(item => document.getElementById(item.id));
    this.resizeObserver = new ResizeObserver(() => this.paint());
    for (const definition of this.definitions) {
      const svg = document.getElementById(definition.id);
      svg.style.touchAction = 'pan-y'; svg.style.cursor = 'crosshair';
      this.resizeObserver.observe(svg);
      svg.addEventListener('pointermove', event => this.pointerMove(event, definition));
      svg.addEventListener('pointerleave', () => { if (!this.drag) { this.cursorTime = null; this.paint(); } });
      svg.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        this.drag = { x: event.clientX, end: this.view().end, definition, moved: false };
        svg.setPointerCapture(event.pointerId);
      });
      const release = () => { this.drag = null; };
      svg.addEventListener('pointerup', release); svg.addEventListener('pointercancel', release);
      svg.addEventListener('wheel', event => this.zoom(event, definition), { passive: false });
      svg.addEventListener('dblclick', () => { this.windowSeconds = 8; this.resetView(); });
    }
    document.getElementById('chart-window')?.addEventListener('change', event => {
      const span = Number(event.target.value); if (!Number.isFinite(span) || span <= 0) return;
      this.windowSeconds = span; this.end = this.clampEnd(this.end); this.cursorTime = null; this.paint();
    });
    document.getElementById('chart-follow')?.addEventListener('change', event => {
      this.follow = event.target.checked; if (this.follow) this.end = Math.max(this.state.time, this.windowSeconds); this.paint();
    });
    document.getElementById('chart-reset-view')?.addEventListener('click', () => this.resetView());
    for (const button of document.querySelectorAll('button[data-series]')) button.addEventListener('click', () => {
      const key = button.dataset.series;
      if (this.visibleSeries.has(key)) this.visibleSeries.delete(key); else this.visibleSeries.add(key);
      button.setAttribute('aria-pressed', String(this.visibleSeries.has(key)));
      button.classList.toggle('series-hidden', !this.visibleSeries.has(key)); this.paint();
    });
  }

  clampEnd(end) {
    const newest = Math.max(this.state.time || 0, this.windowSeconds), oldest = this.history[0]?.time || 0;
    return clamp(end, Math.min(newest, oldest + this.windowSeconds), newest);
  }
  view() {
    const end = this.follow ? Math.max(this.state.time || 0, this.windowSeconds) : this.clampEnd(this.end);
    return { start: end - this.windowSeconds, end };
  }
  getState() { return { windowSeconds: this.windowSeconds, follow: this.follow, ...this.view(), cursorTime: this.cursorTime, visibleSeries: [...this.visibleSeries], activeChart: this.activeChart }; }
  resetView() { this.follow = true; this.end = Math.max(this.state.time, this.windowSeconds); this.cursorTime = null; this.paint(); }
  update(history, state, config) {
    const reset = state.time < (this.state.time || 0) || history !== this.history;
    this.history = history; this.state = state; this.config = config;
    if (reset) { this.follow = true; this.end = Math.max(state.time, this.windowSeconds); this.cursorTime = null; }
    const now = performance.now();
    if (reset || (state.time !== this.paintedTime && now - this.lastPaint > 90)) { this.lastPaint = now; this.paint(); }
  }
  pointerMove(event, definition) {
    const svg = document.getElementById(definition.id), bounds = svg.getBoundingClientRect(), frame = this.frames.get(definition.key);
    if (!frame) return;
    if (this.drag) {
      const delta = event.clientX - this.drag.x;
      if (Math.abs(delta) > 3 || this.drag.moved) {
        this.drag.moved = true; this.follow = false;
        this.end = this.clampEnd(this.drag.end - delta / frame.plotWidth * this.windowSeconds);
      }
    }
    const { start, end } = this.view(), fraction = clamp((event.clientX - bounds.left - frame.left) / frame.plotWidth, 0, 1);
    const sample = nearest(this.history, start + fraction * (end - start));
    this.cursorTime = sample?.time ?? null; this.activeChart = definition.key; this.paint();
  }
  zoom(event, definition) {
    event.preventDefault();
    const svg = document.getElementById(definition.id), rect = svg.getBoundingClientRect(), frame = this.frames.get(definition.key); if (!frame) return;
    const ratio = clamp((event.clientX - rect.left - frame.left) / frame.plotWidth, 0, 1), old = this.view();
    const anchor = old.start + ratio * this.windowSeconds;
    this.windowSeconds = clamp(this.windowSeconds * Math.exp(event.deltaY * .0015), 1, 30);
    this.follow = false; this.end = this.clampEnd(anchor + (1 - ratio) * this.windowSeconds); this.cursorTime = null; this.paint();
  }
  syncControls() {
    const follow = document.getElementById('chart-follow'); if (follow) follow.checked = this.follow;
    const select = document.getElementById('chart-window');
    if (select) {
      const match = [...select.options].find(option => Math.abs(Number(option.value) - this.windowSeconds) < .001);
      if (match) { select.value = match.value; select.querySelector('[data-custom]')?.remove(); }
      else {
        let option = select.querySelector('[data-custom]');
        if (!option) { option = document.createElement('option'); option.dataset.custom = 'true'; select.add(option); }
        option.value = 'custom'; option.textContent = `${format(this.windowSeconds, 1)}초 · 확대`; select.value = 'custom';
      }
    }
  }
  paint() {
    if (!this.definitions.length) return;
    this.syncControls();
    const view = this.view(), rows = this.history.filter(row => row.time >= view.start && row.time <= view.end);
    for (const definition of this.definitions) this.paintChart(definition, rows, view);
    this.paintSummaries(rows);
    this.paintReadout();
    this.paintedTime = this.state.time;
  }
  paintChart(definition, rows, view) {
    const svg = document.getElementById(definition.id);
    const W = Math.max(300, Math.round(svg.clientWidth || 900)), H = Math.max(240, Math.round(svg.clientHeight || 320));
    const L = W < 500 ? 56 : 70, R = W < 500 ? 14 : 25, T = 25, B = 42, pw = W - L - R, ph = H - T - B;
    this.frames.set(definition.key, { left: L, plotWidth: pw }); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const active = definition.keys.filter(key => this.visibleSeries.has(key));
    let low = 0, high = definition.minimum;
    for (const key of active) { const s = stats(rows, key, SERIES[key].scale); low = Math.min(low, s.min); high = Math.max(high, s.max); }
    const gap = Math.max(high - low, definition.minimum);
    if (!definition.positive) low -= gap * .10;
    high += gap * .12;
    const step = niceStep(high - low, 5), ymin = definition.positive ? 0 : Math.floor(low / step) * step, ymax = Math.ceil(high / step) * step;
    const x = time => L + (time - view.start) / this.windowSeconds * pw;
    const y = value => T + ph - (value - ymin) / (ymax - ymin) * ph;
    const clip = `clip-${definition.key}`;
    let html = `<defs><clipPath id="${clip}"><rect x="${L}" y="${T}" width="${pw}" height="${ph}"/></clipPath></defs>`;
    html += `<rect x="${L}" y="${T}" width="${pw}" height="${ph}" rx="4" fill="#101923" fill-opacity=".65"/>`;
    // Subtle bands associate the physical response with obstacle passage.
    let bandStart = null;
    for (let i = 0; i <= rows.length; i++) {
      const hit = i < rows.length && Math.abs(rows[i].rawRoadY || 0) > .0005;
      if (hit && bandStart === null) bandStart = rows[i].time;
      if (!hit && bandStart !== null) { const finish = rows[Math.max(i - 1, 0)].time; html += `<rect x="${x(bandStart).toFixed(2)}" y="${T}" width="${Math.max(1, x(finish) - x(bandStart)).toFixed(2)}" height="${ph}" fill="#f3b277" fill-opacity=".055" clip-path="url(#${clip})"/>`; bandStart = null; }
    }
    let decimals = 0;
    while (decimals < 4 && Math.abs(step * 10 ** decimals - Math.round(step * 10 ** decimals)) > 1e-7) decimals++;
    for (let value = ymin, i = 0; value <= ymax + step * .01 && i < 20; value += step, i++) {
      const yy = y(value); html += `<line x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}" stroke="${Math.abs(value) < 1e-8 ? '#667a90' : '#334456'}" stroke-opacity="${Math.abs(value) < 1e-8 ? '.75' : '.55'}" ${Math.abs(value) < 1e-8 ? '' : 'stroke-dasharray="3 5"'}/><text class="axis-tick" x="${L - 12}" y="${yy + 4}" text-anchor="end" fill="#a1b0c1" font-size="12">${format(value, decimals)}</text>`;
    }
    const ticks = W < 500 ? 4 : W < 800 ? 6 : 8;
    for (let i = 0; i <= ticks; i++) {
      const time = view.start + this.windowSeconds * i / ticks, xx = x(time);
      html += `<line x1="${xx}" y1="${T}" x2="${xx}" y2="${T + ph}" stroke="#334456" stroke-opacity=".35" stroke-dasharray="3 5"/><text class="axis-tick" x="${xx}" y="${H - 17}" text-anchor="middle" fill="#a1b0c1" font-size="12">${format(time, this.windowSeconds < 4 ? 2 : 1)}</text>`;
    }
    html += `<text class="axis-unit" x="${L}" y="15" fill="#acbbcb" font-size="12">${definition.unit}</text><text class="axis-unit" x="${W - R}" y="${H - 3}" text-anchor="end" fill="#8da0b4" font-size="12">시뮬레이션 시간 (s)</text>`;
    const decimation = Math.max(1, Math.floor(rows.length / Math.max(200, pw * 2)));
    for (const key of active) {
      const series = SERIES[key];
      // At most about two samples per horizontal pixel; peaks are retained in each bucket.
      const selected = [];
      if (decimation === 1) selected.push(...rows);
      else for (let i = 0; i < rows.length; i += decimation) {
        const bucket = rows.slice(i, i + decimation), extrema = [bucket[0], bucket.reduce((a, b) => a[key] < b[key] ? a : b), bucket.reduce((a, b) => a[key] > b[key] ? a : b), bucket.at(-1)];
        selected.push(...[...new Set(extrema)].sort((a, b) => a.time - b.time));
      }
      const path = selected.map((row, i) => `${i ? 'L' : 'M'}${x(row.time).toFixed(2)},${y((row[key] || 0) * series.scale).toFixed(2)}`).join('');
      html += `<path data-series="${key}" d="${path}" fill="none" stroke="${series.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" ${series.dashed ? 'stroke-dasharray="7 5"' : ''} clip-path="url(#${clip})"/>`;
    }
    if (this.cursorTime !== null && this.cursorTime >= view.start && this.cursorTime <= view.end) {
      const sample = nearest(this.history, this.cursorTime), xx = x(sample.time);
      html += `<g data-chart-layer="cursor"><line x1="${xx}" y1="${T}" x2="${xx}" y2="${T + ph}" stroke="#edf4ff" stroke-opacity=".8" stroke-width="1" stroke-dasharray="4 3"/>`;
      for (const key of active) html += `<circle cx="${xx}" cy="${y(sample[key] * SERIES[key].scale)}" r="4" fill="${SERIES[key].color}" stroke="#101923" stroke-width="2"/>`;
      html += '</g>';
    }
    if (!rows.length || this.state.time < .02) html += `<text x="${L + pw / 2}" y="${T + ph / 2}" fill="#70869d" text-anchor="middle" font-size="13">시험을 시작하면 응답이 기록됩니다.</text>`;
    if (!active.length) html += `<text x="${L + pw / 2}" y="${T + ph / 2}" fill="#a1b0c1" text-anchor="middle" font-size="13">범례를 눌러 표시할 데이터를 선택하세요.</text>`;
    svg.innerHTML = html;
    const label = document.getElementById(`${definition.key}-range-label`); if (label) label.textContent = `${format(view.start, 1)} – ${format(view.end, 1)} s · ${this.follow ? '실시간 추적' : '구간 탐색'}`;
  }
  paintReadout() {
    const output = document.getElementById('chart-cursor-readout'); if (!output) return;
    if (this.cursorTime === null) {
      output.textContent = '포인터: 시점별 수치 · 휠: 확대/축소 · 드래그: 시간 구간 이동'; delete output.dataset.value; return;
    }
    const sample = nearest(this.history, this.cursorTime); if (!sample) return;
    const definition = this.definitions.find(item => item.key === this.activeChart);
    const keys = definition.keys.filter(key => this.visibleSeries.has(key));
    output.textContent = `t ${format(sample.time, 3)} s  ·  ${keys.map(key => `${SERIES[key].label} ${format(sample[key] * SERIES[key].scale, 2)} ${SERIES[key].unit}`).join('  ·  ')}`;
    output.dataset.value = JSON.stringify(sample);
  }
  paintSummaries(rows) {
    const wheel = stats(rows, 'wheelY', 1000), body = stats(rows, 'bodyY', 1000), travel = stats(rows, 'travel', 1000), force = stats(rows, 'contactForce', .001), spring = stats(rows, 'springForce', .001), ba = stats(rows, 'bodyAcceleration'), wa = stats(rows, 'wheelAcceleration');
    const loss = rows.length ? rows.filter(row => !row.contact).length / rows.length * 100 : 0;
    const card = (key, label, value, unit, digits = 2) => `<div class="analysis-metric" data-metric="${key}" data-value="${value}"><span>${label}</span><strong>${format(value, digits)} <small>${unit}</small></strong></div>`;
    const motion = document.getElementById('motion-analysis'); if (motion) motion.innerHTML = card('wheelPeak', '휠 최대 |변위|', wheel.peak, 'mm') + card('compressionPeak', '최대 압축 스트로크', Math.max(0, travel.max), 'mm') + card('reboundPeak', '최대 신장 스트로크', Math.max(0, -travel.min), 'mm') + card('bodyDisplacementRMS', '차체 변위 RMS', body.rms, 'mm');
    const forces = document.getElementById('force-analysis'); if (forces) forces.innerHTML = card('contactMin', '최소 접지력', force.min, 'kN') + card('contactMax', '최대 접지력', force.max, 'kN') + card('springPeak', '최대 스프링 힘', spring.peak, 'kN') + card('contactLoss', '구간 접지 이탈', loss, '%', 1);
    const accel = document.getElementById('acceleration-analysis'); if (accel) accel.innerHTML = card('bodyAccelerationRMS', this.config.holderMode === 'fixed' ? '차체 RMS · 홀더 고정' : '차체 가속도 RMS', ba.rms, 'm/s²') + card('bodyAccelerationPeak', '차체 최대 |가속도|', ba.peak, 'm/s²') + card('wheelAccelerationRMS', '휠 가속도 RMS', wa.rms, 'm/s²') + card('wheelAccelerationPeak', '휠 최대 |가속도|', wa.peak, 'm/s²');
  }
}
