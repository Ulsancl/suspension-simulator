import { normalizeConfig, SuspensionSimulation } from './physics.js';
import { MODEL_VERSION, ExperimentValidationError, normalizeExperimentName, validateExperiment } from './experiments.js';

const TAU = 2 * Math.PI;
const MAX_MEASUREMENT_SAMPLES = 100000;
const CHANNEL_UNITS = Object.freeze({ bodyAcceleration: 'm/s²', wheelAcceleration: 'm/s²', travel: 'm', contactForce: 'N' });
const HEADER_UNITS = {
  time: { channel: 'time', unit: 's', scale: 1 }, time_s: { channel: 'time', unit: 's', scale: 1 },
  bodyAcceleration: { channel: 'bodyAcceleration', unit: 'm/s²', scale: 1 },
  bodyAcceleration_m_s2: { channel: 'bodyAcceleration', unit: 'm/s²', scale: 1 },
  bodyAcceleration_mps2: { channel: 'bodyAcceleration', unit: 'm/s²', scale: 1 },
  wheelAcceleration: { channel: 'wheelAcceleration', unit: 'm/s²', scale: 1 },
  wheelAcceleration_m_s2: { channel: 'wheelAcceleration', unit: 'm/s²', scale: 1 },
  wheelAcceleration_mps2: { channel: 'wheelAcceleration', unit: 'm/s²', scale: 1 },
  travel: { channel: 'travel', unit: 'm', scale: 1 }, travel_m: { channel: 'travel', unit: 'm', scale: 1 },
  travel_mm: { channel: 'travel', unit: 'mm', scale: 0.001 },
  contactForce: { channel: 'contactForce', unit: 'N', scale: 1 }, contactForce_N: { channel: 'contactForce', unit: 'N', scale: 1 },
};
const invalid = message => { throw new ExperimentValidationError(message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Static tangent, closed-contact, undamped modes of this reduced model. */
export function linearQuarterCarProperties(input = {}) {
  const config = normalizeConfig(input);
  const snapshot = new SuspensionSimulation(config).snapshot();
  const wheelRate = snapshot.effectiveWheelRate;
  const ms = config.sprungMass, mu = config.unsprungMass, kt = config.tireRate;
  const trace = wheelRate / ms + (wheelRate + kt) / mu;
  const determinant = wheelRate * kt / (ms * mu);
  const discriminant = Math.sqrt(Math.max(0, trace * trace - 4 * determinant));
  const high = (trace + discriminant) / 2;
  const low = determinant / high;
  const naturalFrequenciesHz = [Math.sqrt(low) / TAU, Math.sqrt(high) / TAU];
  const fixedHolderFrequencyHz = Math.sqrt((wheelRate + kt) / mu) / TAU;
  return {
    modelVersion: MODEL_VERSION, holderMode: config.holderMode,
    effectiveMotionRatio: snapshot.effectiveMotionRatio, wheelRate,
    effectiveWheelRate: wheelRate, fixedHolderFrequencyHz, naturalFrequenciesHz,
    activeFrequenciesHz: config.holderMode === 'fixed' ? [fixedHolderFrequencyHz] : [...naturalFrequenciesHz],
    massMatrix: [[ms, 0], [0, mu]],
    stiffnessMatrix: [[wheelRate, -wheelRate], [-wheelRate, wheelRate + kt]],
    eigenvaluesRadSquared: [low, high],
    method: '정적 평형의 실제 모델 접선 휠 레이트를 사용하여 Kφ=ω²Mφ를 풉니다. 고정 홀더에서는 차체 자유도가 없으므로 휠 단일 모드만 적용합니다.',
    limitations: ['무감쇠·소변위·접지 유지·범프 스톱 미작동 조건의 선형화 결과입니다.', '가변 댐퍼, 타이어 이탈, 비선형 스프링과 측정 곡선 외삽에서는 시간 응답을 별도로 확인해야 합니다.', '전체 차량 3D 다물체·조향·횡력·부싱·구조 응력 해석을 포함하지 않습니다.'],
  };
}

/** Reproducible numerical checks, not a vehicle or product certification. */
export function runBenchmarkSuite() {
  const checks = [];
  for (const holderMode of ['fixed', 'sprung']) {
    const simulation = new SuspensionSimulation({ holderMode, road: 'flat', componentProfile: null });
    simulation.advance(1);
    const error = Math.max(Math.abs(simulation.state.bodyY), Math.abs(simulation.state.wheelY), Math.abs(simulation.state.bodyAcceleration), Math.abs(simulation.state.wheelAcceleration));
    checks.push({ id: `equilibrium-${holderMode}`, name: `${holderMode === 'fixed' ? '고정 홀더' : '탄성 차체'} 정적 평형`, passed: error < 1e-9, error, tolerance: 1e-9, unit: 'SI state maximum' });
  }
  const simulation = new SuspensionSimulation({ holderMode: 'fixed', road: 'flat', speed: 0, springType: 'coil', autoMotionRatio: false, motionRatio: 0.8, compressionDamping: 1800, reboundDamping: 1800, tireDamping: 250, componentProfile: null });
  const amplitude = 0.002;
  simulation.state.wheelY = amplitude;
  const mass = simulation.config.unsprungMass;
  const rate = simulation.config.tireRate + simulation.state.effectiveWheelRate;
  const damping = simulation.config.compressionDamping * simulation.state.effectiveMotionRatio ** 2 + simulation.config.tireDamping;
  const alpha = damping / (2 * mass);
  const omega = Math.sqrt(rate / mass - alpha * alpha);
  let maximumError = 0;
  for (let i = 0; i < 100; i++) {
    simulation.advance(0.01);
    const time = simulation.state.time;
    const expected = amplitude * Math.exp(-alpha * time) * (Math.cos(omega * time) + alpha / omega * Math.sin(omega * time));
    maximumError = Math.max(maximumError, Math.abs(simulation.state.wheelY - expected));
  }
  checks.push({ id: 'analytic-fixed-decay', name: '감쇠 자유 응답과 폐형식 해의 비교', passed: maximumError < 5e-7, error: maximumError, tolerance: 5e-7, unit: 'm' });
  return { modelVersion: MODEL_VERSION, passed: checks.every(check => check.passed), checks, method: '정적 평형 및 접지 유지 상태의 선형 고정 홀더 2 mm 자유 응답을 검증합니다. 차량 실측 검증 또는 인증을 의미하지 않습니다.' };
}

function delimiterOf(text) {
  let quoted = false, comma = 0, semicolon = 0;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (character === '\r' || character === '\n') break;
      if (character === ',') comma++;
      if (character === ';') semicolon++;
    }
  }
  if (!comma && !semicolon) invalid('CSV 헤더에는 쉼표 또는 세미콜론 구분자가 필요합니다.');
  if (comma && semicolon) invalid('CSV 헤더에 서로 다른 구분자가 혼합되어 있습니다.');
  return semicolon ? ';' : ',';
}

function csvRows(text, delimiter) {
  const rows = [];
  let row = [], cell = '', quoted = false, closedQuote = false;
  const finishCell = () => { row.push(cell.trim()); cell = ''; closedQuote = false; };
  const finishRow = () => {
    finishCell();
    if (row.some(value => value !== '')) rows.push(row);
    row = [];
    if (rows.length > MAX_MEASUREMENT_SAMPLES + 1) invalid('실측 데이터는 최대 100,000개 샘플까지 지원합니다.');
  };
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closedQuote = true; }
      } else cell += character;
    } else if (character === delimiter) finishCell();
    else if (character === '\r' || character === '\n') {
      finishRow();
      if (character === '\r' && text[i + 1] === '\n') i++;
    } else if (character === '"') {
      if (cell.trim() || closedQuote) invalid('CSV 따옴표 형식이 올바르지 않습니다.');
      cell = ''; quoted = true;
    } else {
      if (closedQuote && character.trim()) invalid('CSV 따옴표 뒤에는 구분자만 허용됩니다.');
      cell += character;
    }
  }
  if (quoted) invalid('CSV 따옴표가 닫히지 않았습니다.');
  if (cell || row.length || closedQuote) finishRow();
  return rows;
}

function numericCell(text, row, label) {
  // A strict decimal/exponent grammar excludes blanks, formulas, hex and Infinity.
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) invalid(`CSV ${row}행 ${label} 값이 유한한 숫자가 아닙니다. 소수점은 . 을 사용하십시오.`);
  const value = Number(text);
  if (!Number.isFinite(value) || Math.abs(value) > 1e9) invalid(`CSV ${row}행 ${label} 수치가 허용 범위를 초과합니다.`);
  return value;
}

/**
 * Canonical headers mean SI units. Unit conversion occurs only for an explicit
 * supported alias such as travel_mm; there is no magnitude-based unit guessing.
 */
export function parseMeasurementCSV(input, options = {}) {
  if (typeof input !== 'string' || input.length > 16 * 1024 * 1024) invalid('CSV는 최대 16 MiB 문자열이어야 합니다.');
  const channel = options.channel ?? 'bodyAcceleration';
  if (!CHANNEL_UNITS[channel]) invalid('지원하지 않는 실측 비교 채널입니다.');
  const text = input.replace(/^\uFEFF/, '');
  const delimiter = delimiterOf(text);
  const rows = csvRows(text, delimiter);
  if (rows.length < 3) invalid('실측 CSV에는 헤더와 최소 2개 샘플이 필요합니다.');
  const headers = rows[0];
  if (headers.length > 40 || headers.some(header => !header || header.length > 80 || /[<>\u0000-\u001f]|^[=@]/.test(header)) || new Set(headers).size !== headers.length) invalid('CSV 헤더가 비어 있거나 중복되거나 허용하지 않는 문자를 포함합니다.');
  const requestedTime = options.timeColumn ?? 'time';
  let timeIndex = headers.indexOf(requestedTime);
  if (timeIndex < 0 && requestedTime === 'time') timeIndex = headers.indexOf('time_s');
  if (timeIndex < 0 || HEADER_UNITS[headers[timeIndex]]?.channel !== 'time') invalid('시간 헤더는 time 또는 time_s(초)로 명시하십시오.');
  const valueIndexes = headers.map((header, index) => HEADER_UNITS[header]?.channel === channel ? index : -1).filter(index => index >= 0);
  if (valueIndexes.length !== 1) invalid(`${channel} 채널과 단위를 명시한 열이 정확히 하나 필요합니다.`);
  const valueIndex = valueIndexes[0];
  const timeSpec = HEADER_UNITS[headers[timeIndex]], valueSpec = HEADER_UNITS[headers[valueIndex]];
  let previous = -Infinity;
  const samples = rows.slice(1).map((row, index) => {
    if (row.length !== headers.length) invalid(`CSV ${index + 2}행의 열 개수가 헤더와 다릅니다.`);
    const time = numericCell(row[timeIndex], index + 2, '시간') * timeSpec.scale;
    const value = numericCell(row[valueIndex], index + 2, channel) * valueSpec.scale;
    if (time <= previous) invalid('실측 시간은 중복 없이 엄격하게 증가해야 합니다.');
    previous = time;
    return { time, value };
  });
  const duration = samples.at(-1).time - samples[0].time;
  if (duration <= 0 || duration > 300) invalid('실측 기록의 시간 범위는 0초 초과 300초 이하여야 합니다.');
  return {
    type: 'suspension-lab-measurement', schemaVersion: 1, channel,
    samples, duration, sampleCount: samples.length, unit: CHANNEL_UNITS[channel],
    units: { time: 's', value: CHANNEL_UNITS[channel] },
    sourceUnits: { time: timeSpec.unit, value: valueSpec.unit },
    sourceHeaders: { time: headers[timeIndex], value: headers[valueIndex] },
    sourceName: normalizeExperimentName(options.sourceName, '실측 CSV'),
    delimiter, importedAt: new Date().toISOString(),
    method: '명시된 헤더 단위만 SI로 변환하며, 시간 정렬·단위 추정·오프셋 자동 피팅을 수행하지 않습니다.',
  };
}

function validateMeasurement(data) {
  if (!isObject(data) || data.type !== 'suspension-lab-measurement' || data.schemaVersion !== 1 || !CHANNEL_UNITS[data.channel] || data.unit !== CHANNEL_UNITS[data.channel] || !Array.isArray(data.samples) || data.samples.length < 2 || data.samples.length > MAX_MEASUREMENT_SAMPLES) invalid('실측 데이터 형식 또는 채널 단위가 올바르지 않습니다.');
  let previous = -Infinity;
  for (const sample of data.samples) {
    if (!isObject(sample) || typeof sample.time !== 'number' || typeof sample.value !== 'number' || !Number.isFinite(sample.time) || !Number.isFinite(sample.value) || Math.abs(sample.time) > 1e9 || Math.abs(sample.value) > 1e9 || sample.time <= previous) invalid('실측 데이터에 유효하지 않은 시간 또는 수치가 있습니다.');
    previous = sample.time;
  }
  if (data.samples.at(-1).time - data.samples[0].time > 300) invalid('실측 기록은 최대 300초까지 지원합니다.');
  return data;
}

/** Offset convention: simulationTime = measuredTime + timeOffset (seconds). */
export function compareMeasurement(input, measurementInput, options = {}) {
  const run = validateExperiment(input);
  const measurement = validateMeasurement(measurementInput);
  const channel = options.channel ?? measurement.channel;
  if (channel !== measurement.channel || !CHANNEL_UNITS[channel]) invalid('선택한 비교 채널과 실측 CSV 채널이 일치해야 합니다.');
  const timeOffset = options.timeOffset === undefined ? 0 : options.timeOffset;
  if (typeof timeOffset !== 'number' || !Number.isFinite(timeOffset) || Math.abs(timeOffset) > 1e9) invalid('시간 오프셋은 유한한 초 단위 숫자여야 합니다.');
  const history = run.history;
  const first = history[0].time, last = history.at(-1).time;
  let cursor = 0, squared = 0, absolute = 0, peakError = 0, measuredSum = 0;
  const residuals = [];
  for (const sample of measurement.samples) {
    const time = sample.time + timeOffset;
    if (time < first || time > last) continue;
    while (cursor < history.length - 2 && history[cursor + 1].time < time) cursor++;
    const a = history[cursor], b = history[cursor + 1];
    const fraction = (time - a.time) / (b.time - a.time);
    const simulated = a[channel] + fraction * (b[channel] - a[channel]);
    const residual = simulated - sample.value;
    residuals.push({ time, measuredTime: sample.time, measured: sample.value, simulated, residual });
    squared += residual * residual; absolute += Math.abs(residual);
    peakError = Math.max(peakError, Math.abs(residual)); measuredSum += sample.value;
  }
  if (residuals.length < 2) invalid('오프셋을 적용한 실측 데이터와 실험 기록에 겹치는 샘플이 2개 이상 필요합니다.');
  const mean = measuredSum / residuals.length;
  const variation = residuals.reduce((sum, sample) => sum + (sample.measured - mean) ** 2, 0);
  const start = residuals[0].time, end = residuals.at(-1).time;
  return {
    modelVersion: MODEL_VERSION, experimentId: run.id, channel, unit: CHANNEL_UNITS[channel],
    timeOffset, rmse: Math.sqrt(squared / residuals.length), mae: absolute / residuals.length,
    peakError, r2: variation <= 1e-20 ? null : 1 - squared / variation,
    sampleCount: residuals.length, measurementSampleCount: measurement.samples.length,
    window: { start, end, duration: end - start }, residuals,
    sourceName: measurement.sourceName, sourceUnits: { ...measurement.sourceUnits },
    method: '실측 시간에 사용자가 지정한 오프셋을 더한 뒤 겹치는 구간에서 시뮬레이션을 선형 보간합니다. 잔차=시뮬레이션−실측. 오프셋·진폭·단위를 자동 피팅하지 않습니다. R²는 실측이 상수이면 정의하지 않습니다.',
    limitations: '이 결과는 지정 채널의 수치 비교이며, 노면 입력·장비 교정·부품·센서 조건의 일치 또는 차량 모델의 유효성을 인증하지 않습니다.',
  };
}
