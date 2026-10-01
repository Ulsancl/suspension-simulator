import { DEFAULT_CONFIG, normalizeConfig } from './physics.js';
import { runExperimentAsync, MODEL_VERSION } from './experiments.js';

const copy = value => structuredClone(value);
const format = (value, digits = 2) => value.toFixed(digits);

/** Detached example conditions. Only rebound damping changes between A and B. */
export function getConsumerGuide() {
  return {
    id: 'rebound-single-bump-v1', title: '감쇠가 클수록 항상 좋을까요?',
    duration: 8, parameter: 'reboundDamping', candidates: [900, 4200],
    config: normalizeConfig({ ...DEFAULT_CONFIG, structure: 'wishbone', springType: 'coil', holderMode: 'sprung',
      road: 'bump', singleEvent: true, speed: 30, roadHeight: 0.06, roadWidth: 1, roadSpacing: 6,
      springRate: 32000, compressionDamping: 1800, reboundDamping: 900,
      sprungMass: 320, unsprungMass: 45, tireRate: 220000, tireDamping: 250,
      travelBump: 0.11, travelRebound: 0.10, autoMotionRatio: true,
      tireRadius: 0.34, componentProfile: null }),
  };
}

/** Recover the same example from persisted records without running it again. */
export function findConsumerGuideTrials(records) {
  const guide = getConsumerGuide();
  const names = ['A · 작은 리바운드 감쇠', 'B · 큰 리바운드 감쇠'];
  const trials = guide.candidates.map((candidate, index) => records.find(run => run.modelVersion === MODEL_VERSION && run.duration === guide.duration && run.name === names[index] && Object.keys(guide.config).every(key => run.config[key] === (key === guide.parameter ? candidate : guide.config[key]))));
  return trials.every(Boolean) ? trials.map(copy) : null;
}

function aborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('A/B 체험을 중단했습니다. 기존 기록은 그대로 유지합니다.');
  error.name = 'AbortError'; throw error;
}

/** Describe calculated values. A missing settling estimate never becomes zero. */
export function describeGuideResults(trials) {
  if (!Array.isArray(trials) || trials.length !== 2) throw new Error('A/B 결과 두 개가 필요합니다.');
  const rows = trials.map((run, index) => {
    if (run.modelVersion !== MODEL_VERSION || !Number.isFinite(run.metrics?.rmsBodyAcceleration) || run.metrics.rmsBodyAcceleration < 0 || !Number.isFinite(run.metrics?.contactLossPct) || run.metrics.contactLossPct < 0 || run.metrics.contactLossPct > 100) throw new Error('A/B 결과의 모델 또는 지표를 확인하세요.');
    const estimate = run.kpis?.settling?.status === 'settled' && Number.isFinite(run.kpis.settlingTime) && run.kpis.settlingTime >= 0 ? run.kpis.settlingTime : null;
    return { label: index === 0 ? 'A · 작은 감쇠' : 'B · 큰 감쇠', id: run.id,
      damping: run.config.reboundDamping, bodyRMS: run.metrics.rmsBodyAcceleration,
      contactLossPct: run.metrics.contactLossPct, settlingSeconds: estimate,
      settlingLabel: estimate === null ? `${format(run.duration, 0)}초 기록에서 정착을 확인하지 못함` : `요철 통과 뒤 약 ${format(estimate)}초`,
    };
  });
  const [a, b] = rows;
  const direction = (first, second) => Math.abs(second - first) < 1e-8 ? '같습니다' : second < first ? '작아졌습니다' : '커졌습니다';
  const sentences = [
    a.settlingSeconds !== null && b.settlingSeconds !== null
      ? `잔흔들림이 줄어드는 데 걸린 추정 시간은 A ${format(a.settlingSeconds)}초, B ${format(b.settlingSeconds)}초입니다.`
      : '정착 시간을 확인하지 못한 기록이 있습니다. 기록 시간 안에 잔흔들림이 충분히 줄었는지 그래프로 살펴보세요.',
    `시험 전체의 차체 가속도 크기(RMS)는 ${format(a.bodyRMS)} → ${format(b.bodyRMS)} m/s²로 ${direction(a.bodyRMS, b.bodyRMS)}.`,
    `타이어가 노면 접촉을 잃은 시간 비율은 ${format(a.contactLossPct)} → ${format(b.contactLossPct)}%입니다.`,
  ];
  return { rows, sentences, note: '같은 범프에서도 잔흔들림, 차체 가속도와 노면 접촉은 함께 살펴봐야 합니다. 이 예시의 결과이며 차량의 최적 설정이나 안전 판정이 아닙니다.' };
}

/** Compute both examples independently, then retain them as one atomic batch. */
export async function runConsumerGuide(library, options = {}) {
  await library.ready(); aborted(options.signal);
  if (library.list().length + 2 > library.maxRuns) return { ok: false, persisted: false, reason: 'capacity', limit: library.maxRuns, required: 2 };
  const guide = getConsumerGuide(), trials = [];
  for (let index = 0; index < guide.candidates.length; index++) {
    aborted(options.signal);
    const run = await runExperimentAsync({ ...guide.config, [guide.parameter]: guide.candidates[index] }, {
      duration: guide.duration, name: index === 0 ? 'A · 작은 리바운드 감쇠' : 'B · 큰 리바운드 감쇠',
      signal: options.signal, scheduler: options.scheduler,
      onProgress: progress => options.onProgress?.({ ...progress, phase: 'computing', trialIndex: index, trialCount: 2, overallProgress: (index + progress.progress) / 2 }),
    });
    trials.push(run); options.onTrial?.(copy(run), index);
  }
  aborted(options.signal);
  options.onProgress?.({ phase: 'saving', overallProgress: 1, trialIndex: 1, trialCount: 2 });
  const status = await library.saveBatch(trials);
  if (!status.ok) return status;
  return { ...status, guide, trials: trials.map(copy), comparison: describeGuideResults(trials) };
}
