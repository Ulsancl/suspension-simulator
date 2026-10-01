import { DEFAULT_CONFIG, normalizeConfig, SuspensionSimulation } from './physics.js';

export const EXPERIMENT_SCHEMA_VERSION = 1;
export const MODEL_VERSION = 'quarter-car-1.3';
export const MAX_SAVED_EXPERIMENTS = 12;
export const MAX_EXPERIMENT_DURATION = 30;
const MAX_SAMPLES = 3601;
const MAX_JSON_CHARACTERS = 32 * 1024 * 1024;
const CHUNK_SECONDS = 0.1;
const CONTACT_LOSS_GUARD = 1;
const STORAGE_KEY = 'suspension-lab:experiments:v1';
const DATABASE_NAME = 'suspension-lab-experiments';
const STORE_NAME = 'libraries';
const LEGACY_MODELS = new Set(['quarter-car-1.0', 'quarter-car-1.1', 'quarter-car-1.2']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clone = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const defaultScheduler = () => new Promise(resolve => setTimeout(resolve, 0));

export class ExperimentValidationError extends Error {
  constructor(message, reason = 'corrupt-storage') { super(message); this.name = 'ExperimentValidationError'; this.reason = reason; }
}

function invalid(message) { throw new ExperimentValidationError(message); }

function validateVersion(data, label) {
  if (!isObject(data)) invalid(`${label} 형식이 올바르지 않습니다.`);
  if (data.schemaVersion !== EXPERIMENT_SCHEMA_VERSION) throw new ExperimentValidationError(`${label}의 스키마 ${String(data.schemaVersion)}는 이 앱에서 열 수 없습니다. 원문을 보관하고 해당 형식을 지원하는 버전을 사용하세요.`, 'unsupported-schema');
  if (data.modelVersion !== MODEL_VERSION && !LEGACY_MODELS.has(data.modelVersion)) {
    const reason = /^quarter-car-\d+\.\d+$/.test(String(data.modelVersion)) ? 'unsupported-model' : 'unknown-model';
    throw new ExperimentValidationError(`${label}의 모델 ${String(data.modelVersion)}은 이 앱에서 열 수 없습니다. 원문은 현행 계산으로 변환하지 않습니다.`, reason);
  }
  return data.modelVersion !== MODEL_VERSION;
}

export const isLegacyExperiment = record => LEGACY_MODELS.has(record?.modelVersion);

/** Names are plain text, never HTML. Render all returned text with textContent. */
export function normalizeExperimentName(input, fallback = '서스펜션 실험') {
  if (input != null && typeof input !== 'string') invalid('실험 이름은 문자열이어야 합니다.');
  const value = (input ?? '').replace(/<[^>]*>/g, '').replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return value || fallback;
}

export function validateDuration(duration = 8) {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 1 || duration > MAX_EXPERIMENT_DURATION) {
    invalid('실험 시간은 1~30초 사이의 유한한 숫자여야 합니다.');
  }
  return duration;
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeDate(value) {
  if (typeof value !== 'string' || value.length > 40) invalid('기록 날짜 형식이 올바르지 않습니다.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2200) invalid('기록 날짜 형식이 올바르지 않습니다.');
  return date.toISOString();
}

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  const error = new Error('실험을 취소했습니다.');
  error.name = 'AbortError';
  throw error;
}

function startExperiment(input, options) {
  if (!isObject(input)) invalid('실험 설정은 객체여야 합니다.');
  if (!isObject(options)) invalid('실험 옵션은 객체여야 합니다.');
  const duration = validateDuration(has(options, 'duration') ? options.duration : 8);
  const config = normalizeConfig(input);
  const id = options.id ?? createId();
  if (typeof id !== 'string' || !UUID.test(id)) invalid('기록 ID 형식이 올바르지 않습니다.');
  return {
    simulation: new SuspensionSimulation(config), config, duration, id,
    createdAt: safeDate(options.createdAt ?? new Date().toISOString()),
    name: normalizeExperimentName(options.name),
  };
}

function settledEstimate(config, duration, history) {
  const thresholds = { travel: 0.002, bodyVelocity: 0.01, wheelVelocity: 0.02, minimumWindow: 0.5 };
  const method = '노면 자극 종료 후 트래블 ±2 mm, 차체 속도 ±10 mm/s, 휠 속도 ±20 mm/s가 기록 끝까지 최소 0.5초 유지되는 첫 구간. 120 Hz 기록을 사용한 추정값.';
  const base = { estimatedSeconds: null, status: 'not-applicable', eventEndTime: null, thresholds, method };
  if (!config.singleEvent || config.road === 'flat' || config.roadHeight === 0 || config.speed === 0) return base;
  const endDistance = config.road === 'washboard'
    ? config.roadSpacing * 0.35 + 3 * config.roadWidth + config.tireRadius
    : config.roadSpacing * 0.55 + config.roadWidth / 2 + config.tireRadius;
  const eventEndTime = endDistance / (config.speed / 3.6);
  const output = { ...base, status: 'not-observed', eventEndTime };
  if (duration < eventEndTime + thresholds.minimumWindow) return output;
  let first = history.findIndex(sample => sample.time >= eventEndTime);
  if (first < 0) return output;
  for (let i = first; i < history.length; i++) {
    const sample = history[i];
    if (Math.abs(sample.travel) > thresholds.travel || Math.abs(sample.bodyVelocity) > thresholds.bodyVelocity || Math.abs(sample.wheelVelocity) > thresholds.wheelVelocity) first = i + 1;
  }
  const candidate = history[first];
  if (!candidate || duration - candidate.time < thresholds.minimumWindow) return output;
  return { ...output, status: 'settled', estimatedSeconds: Math.max(0, candidate.time - eventEndTime) };
}

function calculateKPIs(config, duration, history, metrics) {
  let minContactForce = Infinity, maxContactForce = 0, maxCompression = 0, maxRebound = 0, bottomed = 0, toppedOut = 0;
  for (const sample of history) {
    minContactForce = Math.min(minContactForce, sample.contactForce);
    maxContactForce = Math.max(maxContactForce, sample.contactForce);
    maxCompression = Math.max(maxCompression, sample.travel);
    maxRebound = Math.max(maxRebound, -sample.travel);
    bottomed += Number(sample.bottomed); toppedOut += Number(sample.toppedOut);
  }
  const settling = settledEstimate(config, duration, history);
  return {
    peakTravel: metrics.peakTravel,
    bodyRMS: metrics.rmsBodyAcceleration, wheelRMS: metrics.rmsWheelAcceleration,
    peakBodyAcceleration: metrics.peakBodyAcceleration, peakWheelAcceleration: metrics.peakWheelAcceleration,
    contactLossPct: metrics.contactLossPct, minContactForce, maxContactForce,
    curveExtrapolationPct: metrics.curveExtrapolationPct ?? 0,
    maxCompression, maxRebound,
    bottomedPct: bottomed / history.length * 100, toppedOutPct: toppedOut / history.length * 100,
    strokeUsedPct: Math.max(maxCompression / config.travelBump, maxRebound / config.travelRebound) * 100,
    settlingTime: settling.estimatedSeconds, settling,
  };
}

function finishExperiment(experiment) {
  const { simulation, config, duration, id, createdAt, name } = experiment;
  const history = simulation.history.map(sample => ({ springCurveOutOfRange: false, damperCurveOutOfRange: false, ...sample }));
  const finalState = { springCurveOutOfRange: false, damperCurveOutOfRange: false, ...simulation.snapshot() };
  if (!history.length || Math.abs(history.at(-1).time - finalState.time) > 1e-7) history.push(finalState);
  const metrics = { curveExtrapolationPct: 0, ...simulation.metrics() };
  return {
    type: 'suspension-lab-experiment', schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    modelVersion: MODEL_VERSION, id, createdAt, name, title: name, config, duration,
    history, metrics, kpis: calculateKPIs(config, duration, history, metrics),
    effectiveMotionRatio: finalState.effectiveMotionRatio,
    effectiveWheelRate: finalState.effectiveWheelRate,
  };
}

/** Numeric output is deterministic; UUID/date are separate record metadata. */
export function runExperiment(config = {}, options = {}) {
  const experiment = startExperiment(config, options);
  while (experiment.duration - experiment.simulation.state.time > 1e-9) {
    experiment.simulation.step(Math.min(CHUNK_SECONDS, experiment.duration - experiment.simulation.state.time));
  }
  return finishExperiment(experiment);
}

/** Yield after each 0.1 simulated second so a trial never monopolizes the UI. */
export async function runExperimentAsync(config = {}, options = {}) {
  abortIfNeeded(options.signal);
  const experiment = startExperiment(config, options);
  const scheduler = options.scheduler ?? defaultScheduler;
  if (typeof scheduler !== 'function') invalid('실험 스케줄러는 함수여야 합니다.');
  await scheduler();
  while (experiment.duration - experiment.simulation.state.time > 1e-9) {
    abortIfNeeded(options.signal);
    experiment.simulation.step(Math.min(CHUNK_SECONDS, experiment.duration - experiment.simulation.state.time));
    options.onProgress?.({ progress: Math.min(1, experiment.simulation.state.time / experiment.duration), time: experiment.simulation.state.time, duration: experiment.duration });
    await scheduler();
  }
  abortIfNeeded(options.signal);
  return finishExperiment(experiment);
}

/** Same road/masses/spring conditions, one actual damper coefficient varied. */
export async function runDampingSweep(config = {}, options = {}) {
  if (!isObject(config)) invalid('실험 설정은 객체여야 합니다.');
  const coefficient = { compression: 'compressionDamping', rebound: 'reboundDamping' }[options.coefficient] ?? options.coefficient ?? 'compressionDamping';
  if (!['compressionDamping', 'reboundDamping'].includes(coefficient)) invalid('스윕 대상은 압축 또는 리바운드 댐핑이어야 합니다.');
  const candidates = options.candidates;
  const maximum = coefficient === 'compressionDamping' ? 16000 : 20000;
  if (!Array.isArray(candidates) || candidates.length < 3 || candidates.length > 7 || candidates.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) || new Set(candidates).size !== candidates.length) {
    invalid(`댐핑 후보는 서로 다른 3~7개의 숫자(0~${maximum} N·s/m)여야 합니다.`);
  }
  const duration = validateDuration(has(options, 'duration') ? options.duration : 8);
  const baseConfig = normalizeConfig(config);
  if (baseConfig.componentProfile?.damper) invalid('측정 댐퍼 곡선이 적용된 상태에서는 계수 스윕이 실제 힘을 바꾸지 않습니다. 댐퍼 곡선을 해제한 뒤 비교하십시오.');
  const name = normalizeExperimentName(options.name, '댐핑 비교');
  const trials = [];
  try {
    for (let index = 0; index < candidates.length; index++) {
      abortIfNeeded(options.signal);
      const value = candidates[index];
      const trial = await runExperimentAsync({ ...baseConfig, [coefficient]: value }, {
        duration, name: `${name} · ${value} N·s/m`, signal: options.signal, scheduler: options.scheduler,
        onProgress: progress => options.onProgress?.({ ...progress, trialIndex: index, trialCount: candidates.length, candidate: value, overallProgress: (index + progress.progress) / candidates.length }),
      });
      trials.push(trial);
      options.onTrial?.(clone(trial), index);
    }
  } catch (error) {
    if (error.name === 'AbortError') error.completedTrials = trials.map(clone);
    throw error;
  }
  const scoreMetric = baseConfig.holderMode === 'fixed' ? 'wheelRMS' : 'bodyRMS';
  const ranking = trials.map(trial => ({
    trialId: trial.id, candidate: trial.config[coefficient], score: trial.kpis[scoreMetric],
    contactLossPct: trial.kpis.contactLossPct, passesGuard: trial.kpis.contactLossPct <= CONTACT_LOSS_GUARD,
    scoreMetric,
  })).sort((a, b) => Number(b.passesGuard) - Number(a.passesGuard) || (!a.passesGuard ? a.contactLossPct - b.contactLossPct : 0) || a.score - b.score || a.candidate - b.candidate).map((row, index) => ({ ...row, rank: index + 1 }));
  const best = ranking.find(row => row.passesGuard);
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION, modelVersion: MODEL_VERSION, name,
    coefficient, candidates: [...candidates], duration, config: baseConfig, trials, ranking,
    recommendation: best ? { ...best } : null,
    method: {
      scoreMetric, unit: 'm/s²', contactLossGuardPct: CONTACT_LOSS_GUARD,
      description: `${baseConfig.holderMode === 'fixed' ? '고정 홀더에서는 휠 가속도 RMS' : '탄성 차체에서는 차체 가속도 RMS'}가 작은 후보를 비교합니다. 접지 이탈 1% 이하는 이 도구의 비교용 가드이며 차량 안전 기준이 아닙니다. 가드를 통과한 후보가 없으면 자동 추천하지 않습니다. 모든 후보는 동일 노면과 정적 평형에서 시작합니다.`,
    },
  };
}

function parseInput(input, maximum = MAX_JSON_CHARACTERS) {
  if (typeof input !== 'string') return input;
  if (input.length > maximum) invalid('가져올 파일이 허용 크기를 초과합니다.');
  try { return JSON.parse(input); } catch { invalid('JSON 형식이 올바르지 않습니다.'); }
}

function validateStoredConfig(input, historical = false) {
  if (!isObject(input)) invalid('저장된 설정 형식이 올바르지 않습니다.');
  const normalized = normalizeConfig(input);
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (key === 'componentProfile') {
      if (input[key] == null) {
        if (normalized[key] !== null) invalid('저장된 부품 프로파일이 올바르지 않습니다.');
      } else if (!isObject(input[key]) || JSON.stringify(input[key]) !== JSON.stringify(normalized[key])) invalid('저장된 부품 프로파일이 올바르지 않습니다.');
      continue;
    }
    if (!has(input, key) || typeof input[key] !== typeof value || (typeof value === 'number' && !Number.isFinite(input[key])) || input[key] !== normalized[key]) invalid(`저장된 설정 ${key}의 값 또는 범위가 올바르지 않습니다.`);
  }
  if (normalized.componentProfile && !historical) new SuspensionSimulation(normalized);
  // Older schemas did not write the optional componentProfile property.
  // Keep their stored configuration instead of adding current model defaults.
  return historical ? Object.fromEntries(Object.keys(DEFAULT_CONFIG).filter(key => has(input, key)).map(key => [key, clone(input[key])])) : normalized;
}

const STATE_NUMBERS = ['time', 'distance', 'bodyY', 'wheelY', 'bodyVelocity', 'wheelVelocity', 'travel', 'roadY', 'rawRoadY', 'roadVelocity', 'tireCompression', 'contactForce', 'springForce', 'damperForce', 'bumpStopForce', 'holderReaction', 'bodyAcceleration', 'wheelAcceleration', 'wheelRotation', 'effectiveMotionRatio', 'effectiveWheelRate'];
const STATE_BOOLEANS = ['contact', 'bottomed', 'toppedOut'];
const OPTIONAL_STATE_BOOLEANS = ['springCurveOutOfRange', 'damperCurveOutOfRange'];
const METRIC_NUMBERS = ['duration', 'rmsBodyAcceleration', 'peakBodyAcceleration', 'rmsWheelAcceleration', 'peakWheelAcceleration', 'peakTravel', 'contactLossPct', 'peakContactForce', 'peakHolderReaction', 'bodyRMS', 'bodyPeak', 'travelPeak'];

function boundedNumber(value, label, min = -1e8, max = 1e8) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(`${label}에 유효하지 않은 수치가 있습니다.`);
  return value;
}

/** Strict shape/range validation, followed by a whitelist copy. No HTML is loaded. */
export function validateExperiment(input) {
  const data = parseInput(input, 4 * 1024 * 1024);
  const historical = validateVersion(data, '실험 기록');
  if (data.type !== 'suspension-lab-experiment') invalid('지원하지 않는 실험 기록 형식입니다.');
  if (typeof data.id !== 'string' || !UUID.test(data.id)) invalid('기록 ID 형식이 올바르지 않습니다.');
  const duration = validateDuration(data.duration);
  const config = validateStoredConfig(data.config, historical);
  if (!Array.isArray(data.history) || data.history.length < 2 || data.history.length > MAX_SAMPLES || data.history.length > Math.ceil(duration * 120) + 2) invalid('기록 샘플 개수가 올바르지 않습니다.');
  let previous = -1;
  const history = data.history.map(sample => {
    if (!isObject(sample)) invalid('기록 샘플 형식이 올바르지 않습니다.');
    const output = {};
    for (const key of STATE_NUMBERS) output[key] = boundedNumber(sample[key], key);
    for (const key of STATE_BOOLEANS) {
      if (typeof sample[key] !== 'boolean') invalid(`기록 샘플 ${key} 형식이 올바르지 않습니다.`);
      output[key] = sample[key];
    }
    for (const key of OPTIONAL_STATE_BOOLEANS) {
      if (sample[key] !== undefined && typeof sample[key] !== 'boolean') invalid(`기록 샘플 ${key} 형식이 올바르지 않습니다.`);
      if (!historical || has(sample, key)) output[key] = sample[key] ?? false;
    }
    if (output.time < 0 || output.time > duration + 1e-6 || output.time <= previous || output.distance < 0 || output.contactForce < 0 || output.effectiveMotionRatio < 0.2 || output.effectiveMotionRatio > 1.3 || output.effectiveWheelRate <= 0) invalid('기록 샘플 시간 또는 물리량 범위가 올바르지 않습니다.');
    previous = output.time;
    return output;
  });
  if (Math.abs(history.at(-1).time - duration) > 0.02) invalid('기록의 종료 시간이 실험 시간과 일치하지 않습니다.');
  if (!isObject(data.metrics)) invalid('실험 지표 형식이 올바르지 않습니다.');
  const metrics = {};
  for (const key of METRIC_NUMBERS) metrics[key] = boundedNumber(data.metrics[key], key, 0);
  if (!historical || has(data.metrics, 'curveExtrapolationPct')) metrics.curveExtrapolationPct = boundedNumber(data.metrics.curveExtrapolationPct ?? 0, '부품 곡선 외삽 비율', 0, 100);
  if (metrics.contactLossPct > 100 || Math.abs(metrics.duration - duration) > 1e-6) invalid('실험 지표의 시간 또는 접지 이탈 비율이 올바르지 않습니다.');
  const name = normalizeExperimentName(data.name ?? data.title);
  return {
    type: 'suspension-lab-experiment', schemaVersion: EXPERIMENT_SCHEMA_VERSION, modelVersion: data.modelVersion,
    id: data.id.toLowerCase(), createdAt: safeDate(data.createdAt), name, title: name, config, duration,
    history, metrics, kpis: historical && data.kpis ? validateHistoricalKPIs(data.kpis) : calculateKPIs(config, duration, history, metrics),
    effectiveMotionRatio: boundedNumber(data.effectiveMotionRatio, '유효 모션비', 0.2, 1.3),
    effectiveWheelRate: boundedNumber(data.effectiveWheelRate, '유효 휠 레이트', 1e-6),
  };
}

function validateHistoricalKPIs(input) {
  if (!isObject(input)) invalid('이전 실험 지표 형식이 올바르지 않습니다.');
  const result = {};
  for (const key of ['peakTravel', 'bodyRMS', 'wheelRMS', 'peakBodyAcceleration', 'peakWheelAcceleration', 'contactLossPct', 'minContactForce', 'maxContactForce', 'maxCompression', 'maxRebound', 'bottomedPct', 'toppedOutPct', 'strokeUsedPct']) result[key] = boundedNumber(input[key], key, 0);
  if (has(input, 'curveExtrapolationPct')) result.curveExtrapolationPct = boundedNumber(input.curveExtrapolationPct, 'curveExtrapolationPct', 0, 100);
  result.settlingTime = input.settlingTime === null ? null : boundedNumber(input.settlingTime, 'settlingTime', 0, 300);
  const settling = input.settling;
  if (!isObject(settling) || !['not-applicable', 'not-observed', 'settled'].includes(settling.status) || !isObject(settling.thresholds) || typeof settling.method !== 'string' || settling.method.length > 2000) invalid('이전 실험 정착 지표 형식이 올바르지 않습니다.');
  const thresholds = {};
  for (const key of ['travel', 'bodyVelocity', 'wheelVelocity', 'minimumWindow']) thresholds[key] = boundedNumber(settling.thresholds[key], key, 0);
  result.settling = { estimatedSeconds: settling.estimatedSeconds === null ? null : boundedNumber(settling.estimatedSeconds, 'estimatedSeconds', 0, 300), status: settling.status,
    eventEndTime: settling.eventEndTime === null ? null : boundedNumber(settling.eventEndTime, 'eventEndTime', 0), thresholds, method: settling.method };
  return result;
}

function validateProject(input, maxRuns) {
  const data = parseInput(input);
  const historical = validateVersion(data, '프로젝트');
  if (data.type !== 'suspension-lab-project') invalid('지원하지 않는 프로젝트 파일입니다.');
  if (!Array.isArray(data.runs) || data.runs.length > maxRuns) invalid(`프로젝트 기록은 최대 ${maxRuns}개까지 가져올 수 있습니다.`);
  const runs = data.runs.map(validateExperiment);
  if (new Set(runs.map(run => run.id)).size !== runs.length) invalid('프로젝트에 중복 기록 ID가 있습니다.');
  return { type: data.type, schemaVersion: EXPERIMENT_SCHEMA_VERSION, modelVersion: data.modelVersion, name: normalizeExperimentName(data.name, '서스펜션 프로젝트'), exportedAt: safeDate(data.exportedAt), config: validateStoredConfig(data.config, historical), runs };
}

function validateLibrary(input, maxRuns) {
  const data = parseInput(input); validateVersion(data, '저장 라이브러리');
  if (!Array.isArray(data.runs) || data.runs.length > maxRuns) invalid('저장된 기록 개수가 올바르지 않습니다.');
  const runs = data.runs.map(validateExperiment);
  if (new Set(runs.map(run => run.id)).size !== runs.length) invalid('저장된 기록 ID가 중복되었습니다.');
  return { modelVersion: data.modelVersion, runs };
}

function browserLocalStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function openDatabase(indexedDB, name) {
  return new Promise((resolve, reject) => {
    let failed = false;
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => { if (failed) request.result.close(); else resolve(request.result); };
    request.onerror = () => { failed = true; reject(request.error ?? new Error('IndexedDB unavailable')); };
    request.onblocked = () => { failed = true; reject(new Error('IndexedDB blocked')); };
  });
}

function readDatabase(database, key) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function writeDatabase(database, key, value) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function persistenceReason(error) {
  return error?.name === 'QuotaExceededError' || error?.code === 22 || /quota/i.test(error?.message ?? '') ? 'quota' : 'storage-unavailable';
}

const recoveryText = raw => typeof raw === 'string' ? raw : JSON.stringify(raw);
function sameRaw(first, second) {
  if (Object.is(first, second)) return true;
  if (typeof first !== typeof second || !first || !second || typeof first !== 'object' || Array.isArray(first) !== Array.isArray(second)) return false;
  const keys = Object.keys(first), otherKeys = Object.keys(second);
  return keys.length === otherKeys.length && keys.every((key, index) => key === otherKeys[index] && sameRaw(first[key], second[key]));
}
async function rawHash(raw) {
  if (!globalThis.crypto?.subtle) return null;
  const bytes = new TextEncoder().encode(recoveryText(raw));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Synchronous reads use a memory cache. Await ready() once, and await mutations.
 * Browser default is IndexedDB; injected storage is a localStorage-style test
 * adapter. Persistence failures never discard accepted in-memory work.
 */
export class ExperimentLibrary {
  constructor(options = {}) {
    this.maxRuns = options.maxRuns ?? MAX_SAVED_EXPERIMENTS;
    if (!Number.isInteger(this.maxRuns) || this.maxRuns < 1 || this.maxRuns > MAX_SAVED_EXPERIMENTS) invalid('저장 가능한 기록 개수는 1~12개여야 합니다.');
    this.key = typeof options.key === 'string' && options.key.length < 120 ? options.key : STORAGE_KEY;
    this._runs = []; this._queue = Promise.resolve(); this._database = null;
    this._branchKey = `${this.key}:model:${MODEL_VERSION}:schema:${EXPERIMENT_SCHEMA_VERSION}`;
    this._activeKey = this.key; this._recoveryIndexKey = `${this.key}:recovery-index:v1`;
    this._recoveries = []; this._writeBlocked = false;
    this._storage = has(options, 'storage') ? options.storage : browserLocalStorage();
    this.persistence = 'memory';
    this.status = { ok: true, persisted: false, reason: 'memory-only', persistence: this.persistence };
    this._ready = this._initialize(options);
  }

  async _initialize(options) {
    let payload = null;
    let fallbackReason = null;
    try {
      const indexedDB = has(options, 'storage') ? null : (options.indexedDB ?? globalThis.indexedDB);
      if (indexedDB) {
        try {
          this._database = await openDatabase(indexedDB, options.databaseName ?? DATABASE_NAME);
          this.persistence = 'indexeddb';
          payload = await readDatabase(this._database, this.key);
        } catch (error) {
          this._database?.close(); this._database = null;
          fallbackReason = persistenceReason(error);
        }
      }
      if (!this._database && this._storage) {
        this.persistence = 'localStorage';
        payload = await this._storage.getItem(this.key);
      }
      await this._loadRecoveries();
      const branch = await this._read(this._branchKey);
      let problem = null, historical = false;
      if (payload != null) {
        try {
          const library = validateLibrary(payload, this.maxRuns);
          historical = library.modelVersion !== MODEL_VERSION || library.runs.some(isLegacyExperiment);
          this._runs = library.runs;
          if (historical) await this._captureRecovery(payload, 'legacy-model', this.key);
        } catch (error) {
          problem = error.reason ?? persistenceReason(error);
          await this._captureRecovery(payload, problem, this.key);
        }
      }
      if (historical || problem || branch != null) this._activeKey = this._branchKey;
      if (branch != null) {
        try { this._runs = validateLibrary(branch, this.maxRuns).runs; problem = null; }
        catch (error) {
          problem = error.reason ?? persistenceReason(error);
          await this._captureRecovery(branch, problem, this._branchKey);
          this._writeBlocked = true;
          this._runs = [];
        }
      }
      this.status = { ok: !problem, persisted: !problem && this.persistence !== 'memory', reason: problem ?? (historical ? 'legacy-model' : this.persistence === 'memory' ? (fallbackReason ?? 'memory-only') : null), persistence: this.persistence, recoveryCount: this._recoveries.length, fallbackReason };
    } catch (error) {
      // A failed read must never turn an unknown library into an empty overwrite.
      this._writeBlocked = true;
      if (payload != null) await this._captureRecovery(payload, error.reason ?? persistenceReason(error), this.key);
      this.status = { ok: false, persisted: false, reason: error.reason ?? persistenceReason(error), persistence: this.persistence, recoveryCount: this._recoveries.length };
    }
    return { ...this.status };
  }

  async ready() { await this._ready; return { ...this.status }; }
  list() { return this._runs.map(clone); }
  get(id) { const run = this._runs.find(item => item.id === id); return run ? clone(run) : null; }

  async _read(key) {
    if (this._database) return readDatabase(this._database, key);
    return this._storage ? await this._storage.getItem(key) : null;
  }

  async _write(key, value) {
    if (this._database) return writeDatabase(this._database, key, value);
    if (this._storage) return this._storage.setItem(key, JSON.stringify(value));
    throw new Error('Storage unavailable');
  }

  async _loadRecoveries() {
    const stored = await this._read(this._recoveryIndexKey);
    if (stored == null) return;
    const index = parseInput(stored);
    if (!isObject(index) || index.format !== 'suspension-lab-recovery-index/v1' || !Array.isArray(index.keys) || index.keys.length > 1000 || index.keys.some(key => typeof key !== 'string' || !key.startsWith(`${this.key}:recovery:`)) || new Set(index.keys).size !== index.keys.length) invalid('원문 복구 목록을 읽지 못했습니다. 저장 공간을 덮어쓰지 않고 새 작업은 메모리에 보관합니다.');
    for (const key of index.keys) {
      const entry = parseInput(await this._read(key), MAX_JSON_CHARACTERS * 4);
      if (!isObject(entry) || entry.format !== 'suspension-lab-recovery/v1' || typeof entry.id !== 'string' || key !== `${this.key}:recovery:${entry.id}` || !has(entry, 'raw') || typeof entry.reason !== 'string') invalid('원문 복구 사본을 읽지 못했습니다.');
      this._recoveries.push({ ...entry, persisted: true });
    }
  }

  async _captureRecovery(raw, reason, sourceKey) {
    const existing = this._recoveries.find(entry => entry.sourceKey === sourceKey && sameRaw(entry.raw, raw));
    if (existing) return existing;
    let data; try { data = parseInput(raw); } catch { data = null; }
    const hash = await rawHash(raw);
    const entry = { format: 'suspension-lab-recovery/v1', id: hash ?? createId(), createdAt: new Date().toISOString(), reason, sourceKey, sourceStorage: this.persistence, modelVersion: data?.modelVersion ?? null, schemaVersion: data?.schemaVersion ?? null, sha256: hash, raw: clone(raw), persisted: false };
    // Different sources can contain identical bytes without requiring a second copy.
    const same = this._recoveries.find(item => item.id === entry.id);
    if (same) return same;
    this._recoveries.push(entry);
    return entry;
  }

  getRecoveries() {
    return this._recoveries.map(({ raw, ...entry }) => {
      let restorable = false;
      try { const data = parseInput(raw); if (data?.type === 'suspension-lab-project') validateProject(data, this.maxRuns); else validateLibrary(data, this.maxRuns); restorable = true; } catch {}
      return { ...clone(entry), restorable };
    });
  }

  /** String sources are returned byte-for-byte, without parsing or reformatting. */
  exportRecovery(id) {
    const entry = this._recoveries.find(item => item.id === id);
    if (!entry) invalid('원문 복구 사본을 찾지 못했습니다.');
    return recoveryText(entry.raw);
  }

  async _ensureRecoveries() {
    if (!this._recoveries.length) return;
    const existingIndex = await this._read(this._recoveryIndexKey);
    const index = existingIndex == null ? null : parseInput(existingIndex);
    if (index && (!isObject(index) || index.format !== 'suspension-lab-recovery-index/v1' || !Array.isArray(index.keys) || index.keys.length > 1000 || index.keys.some(key => typeof key !== 'string' || !key.startsWith(`${this.key}:recovery:`)))) throw new Error('Recovery index is invalid');
    const indexKeys = [...new Set(index?.keys ?? [])];
    for (const entry of this._recoveries) {
      const key = `${this.key}:recovery:${entry.id}`;
      const existing = await this._read(key);
      if (existing == null) {
        const { persisted, ...copy } = entry;
        await this._write(key, copy);
      } else if (!sameRaw(parseInput(existing, MAX_JSON_CHARACTERS * 4)?.raw, entry.raw)) throw new Error('Recovery copy conflict');
      const verified = parseInput(await this._read(key), MAX_JSON_CHARACTERS * 4);
      if (!sameRaw(verified?.raw, entry.raw) || verified?.id !== entry.id || verified?.format !== entry.format) throw new Error('Recovery verification failed');
      if (!indexKeys.includes(key)) indexKeys.push(key);
    }
    if (indexKeys.length > 1000) throw new Error('Recovery index capacity reached');
    await this._write(this._recoveryIndexKey, { format: 'suspension-lab-recovery-index/v1', keys: indexKeys });
    const verifiedIndex = parseInput(await this._read(this._recoveryIndexKey));
    if (JSON.stringify(verifiedIndex?.keys) !== JSON.stringify(indexKeys)) throw new Error('Recovery index verification failed');
    for (const entry of this._recoveries) entry.persisted = true;
  }

  _mutate(operation) {
    const job = this._queue.then(async () => { await this.ready(); return operation(); });
    this._queue = job.catch(() => {});
    return job;
  }

  async _persist(extra = {}) {
    const payload = { schemaVersion: EXPERIMENT_SCHEMA_VERSION, modelVersion: MODEL_VERSION, runs: this._runs };
    try {
      if (!this._database && !this._storage) {
        this.status = { ok: true, persisted: false, reason: 'memory-only', persistence: this.persistence };
        return { ...this.status, ...extra };
      }
      if (this._writeBlocked) {
        this.status = { ok: true, persisted: false, reason: 'recovery-required', persistence: this.persistence, recoveryCount: this._recoveries.length };
        return { ...this.status, ...extra };
      }
      try { await this._ensureRecoveries(); }
      catch (error) {
        this.status = { ok: true, persisted: false, reason: 'backup-failed', persistence: this.persistence, backupFailure: persistenceReason(error), recoveryCount: this._recoveries.length };
        return { ...this.status, ...extra };
      }
      await this._write(this._activeKey, payload);
      this.status = { ok: true, persisted: true, reason: null, persistence: this.persistence, recoveryCount: this._recoveries.length };
    } catch (error) {
      this.status = { ok: true, persisted: false, reason: persistenceReason(error), persistence: this.persistence };
    }
    return { ...this.status, ...extra };
  }

  save(input) {
    return this._mutate(async () => {
      const run = validateExperiment(input);
      if (isLegacyExperiment(run)) return { ok: false, persisted: false, reason: 'read-only', persistence: this.persistence };
      const existing = this._runs.findIndex(item => item.id === run.id);
      if (existing >= 0 && isLegacyExperiment(this._runs[existing])) return { ok: false, persisted: false, reason: 'read-only', persistence: this.persistence };
      if (existing < 0 && this._runs.length >= this.maxRuns) return { ok: false, persisted: false, reason: 'capacity', persistence: this.persistence, limit: this.maxRuns };
      if (existing < 0) this._runs.unshift(run);
      else this._runs[existing] = run;
      return this._persist({ run: clone(run) });
    });
  }

  saveBatch(inputs) {
    return this._mutate(async () => {
      if (!Array.isArray(inputs) || !inputs.length || inputs.length > this.maxRuns) invalid('묶음 기록 개수를 확인하세요.');
      const runs = inputs.map(validateExperiment);
      if (runs.some(isLegacyExperiment)) return { ok: false, persisted: false, reason: 'read-only', persistence: this.persistence };
      if (new Set(runs.map(run => run.id)).size !== runs.length) invalid('묶음 기록 ID가 중복됩니다.');
      const ids = new Set(runs.map(run => run.id));
      if (this._runs.some(run => isLegacyExperiment(run) && ids.has(run.id))) return { ok: false, persisted: false, reason: 'read-only', persistence: this.persistence };
      const merged = [...runs, ...this._runs.filter(run => !ids.has(run.id))];
      if (merged.length > this.maxRuns) return { ok: false, persisted: false, reason: 'capacity', persistence: this.persistence, limit: this.maxRuns };
      this._runs = merged;
      return this._persist({ count: runs.length });
    });
  }

  remove(id) {
    return this._mutate(async () => {
      const index = this._runs.findIndex(run => run.id === id);
      if (index < 0) return { ok: false, persisted: false, reason: 'not-found', persistence: this.persistence };
      if (isLegacyExperiment(this._runs[index])) return { ok: false, persisted: false, reason: 'read-only', persistence: this.persistence };
      this._runs.splice(index, 1);
      return this._persist({ removedId: id });
    });
  }

  rename(id, name) {
    return this._mutate(async () => {
      const run = this._runs.find(item => item.id === id);
      if (!run) return { ok: false, persisted: false, reason: 'not-found', persistence: this.persistence };
      if (isLegacyExperiment(run)) return { ok: false, persisted: false, reason: 'read-only', persistence: this.persistence };
      run.name = normalizeExperimentName(name); run.title = run.name;
      return this._persist({ run: clone(run) });
    });
  }

  clear() { return this._mutate(async () => { this._runs = []; return this._persist(); }); }

  exportProject(config = DEFAULT_CONFIG, options = {}) {
    if (!isObject(config)) invalid('프로젝트 설정은 객체여야 합니다.');
    return {
      type: 'suspension-lab-project', schemaVersion: EXPERIMENT_SCHEMA_VERSION, modelVersion: MODEL_VERSION,
      name: normalizeExperimentName(options.name, '서스펜션 프로젝트'), exportedAt: new Date().toISOString(),
      config: normalizeConfig(config), runs: this.list(),
    };
  }

  /** Import replaces the current library atomically after all data validates. */
  importProject(input) {
    return this._mutate(async () => {
      let project;
      try { project = validateProject(input, this.maxRuns); }
      catch (error) {
        await this._captureRecovery(input, error.reason ?? 'corrupt-storage', 'project-import');
        if (!this._writeBlocked && (this._database || this._storage)) { try { await this._ensureRecoveries(); } catch {} }
        throw error;
      }
      if (project.modelVersion !== MODEL_VERSION || project.runs.some(isLegacyExperiment)) {
        await this._captureRecovery(input, 'legacy-model', 'project-import');
        this._activeKey = this._branchKey;
      }
      this._runs = project.runs;
      return this._persist({ config: clone(project.config), name: project.name, count: project.runs.length });
    });
  }

  restoreRecovery(id) {
    return this._mutate(async () => {
      const entry = this._recoveries.find(item => item.id === id);
      if (!entry) invalid('원문 복구 사본을 찾지 못했습니다.');
      const data = parseInput(entry.raw);
      const project = data?.type === 'suspension-lab-project' ? validateProject(data, this.maxRuns) : null;
      const runs = project ? project.runs : validateLibrary(data, this.maxRuns).runs;
      this._activeKey = this._branchKey;
      this._runs = runs;
      return this._persist({ count: runs.length, restoredId: id, ...(project ? { config: clone(project.config), name: project.name } : {}) });
    });
  }

  close() { this._database?.close(); this._database = null; }
}

export function experimentCSV(input) {
  const run = validateExperiment(input);
  const keys = ['time', 'distance', 'bodyY', 'wheelY', 'travel', 'roadY', 'bodyAcceleration', 'wheelAcceleration', 'contactForce', 'springForce', 'damperForce', 'holderReaction', 'effectiveMotionRatio', 'effectiveWheelRate', 'contact', 'bottomed', 'toppedOut'];
  return keys.join(',') + '\n' + run.history.map(row => keys.map(key => typeof row[key] === 'boolean' ? Number(row[key]) : row[key].toFixed(7)).join(',')).join('\n') + '\n';
}

/** Plain report data for textContent/print UIs, with no generated HTML. */
export function getReportData(input) {
  const run = validateExperiment(input);
  return {
    title: run.name, createdAt: run.createdAt, modelVersion: run.modelVersion,
    conditions: { holderMode: run.config.holderMode, structure: run.config.structure, springType: run.config.springType, road: run.config.road, singleEvent: run.config.singleEvent, duration: run.duration },
    kpiRows: [
      { label: '최대 트래블', value: run.kpis.peakTravel * 1000, unit: 'mm' },
      { label: '차체 가속도 RMS', value: run.kpis.bodyRMS, unit: 'm/s²' },
      { label: '휠 가속도 RMS', value: run.kpis.wheelRMS, unit: 'm/s²' },
      { label: '접지 이탈', value: run.kpis.contactLossPct, unit: '%' },
      { label: '최소 접지력', value: run.kpis.minContactForce, unit: 'N' },
      { label: '최대 접지력', value: run.kpis.maxContactForce, unit: 'N' },
      { label: '추정 정착 시간', value: run.kpis.settlingTime, unit: 's' },
      { label: '유효 모션비', value: run.effectiveMotionRatio, unit: '' },
    ],
    notes: ['수직 단일 휠 축소 모델의 비교 실험이며, 다물체 차량 설계 검증을 대신하지 않습니다.', '기하에서 얻은 정적 모션비를 실험 중 일정하게 사용합니다.', run.kpis.settling.method, '노면·질량·타이어·스프링 조건을 동일하게 맞춰 기록을 비교하십시오.'],
  };
}
