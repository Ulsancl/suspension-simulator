import './detail-panel.css';
import { suspensionDetail } from './detail-model.js';

const sourceNames = { coil: '선형 코일', progressive: '점진형 코일', air: '압력·용적 모델', curve: '입력한 특성표', coefficient: '설정한 감쇠 계수' };
const branches = { loaded: '압축 접촉', clamped: '인장 차단 · 접촉력 0', detached: '기하 접촉 이탈' };
const at = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const fact = (key, label, unit, scale = 1, digits = 1) => `<div class="detail-row"><span>${label}</span><output class="detail-fact" data-detail-key="${key}" data-unit="${({mm:'m',bar:'Pa',L:'m3'})[unit] ?? unit}" data-display-unit="${unit}" data-scale="${scale}" data-digits="${digits}">—</output></div>`;
const force = (key, label) => `<div class="detail-force" data-force-key="${key}">${fact(key, label, 'N', 1, 1)}<span class="detail-force-track" aria-hidden="true"><i></i></span></div>`;
const card = (title, body, id = '') => `<article class="detail-card"${id ? ` id="${id}"` : ''}><h3>${title}</h3>${body}</article>`;

export function initDetailPanel() {
  const panel = document.querySelector('#detail-panel');
  panel.innerHTML = `<details id="detail-disclosure"><summary><span><strong>힘의 흐름 · 부품 상세</strong><small>현재 재생 시점의 수직 힘과 운동 변환</small></span><span class="detail-summary-value" id="detail-summary-value"></span></summary>
    <div class="detail-content"><div class="detail-intro"><p id="detail-reference"></p><span>수직 힘: 위쪽 + · 압축 이동: +</span></div>
    <div class="detail-inspection-actions"><span>구조 확대</span><button type="button" class="button button-small button-outline" id="inspect-spring" aria-pressed="false">스프링 · 받침</button><button type="button" class="button button-small button-outline" id="inspect-damper" aria-pressed="false">댐퍼 내부</button><button type="button" class="button button-small button-quiet" id="exit-inspection" hidden>원래 시점으로</button></div>
    <p class="detail-caption" id="mechanical-detail-note">구조 확대는 대표 형상을 관찰하는 기능입니다. 계산 모델의 모션 비율은 정적 자세에서 고정됩니다.</p>
    <div class="detail-grid">
      ${card('차체에 작용하는 힘', force('forces.body.suspensionN', '서스펜션 전달력') + force('forces.body.gravityN', '차체 중력') + force('forces.body.constraintN', '홀더 외부 구속력') + fact('forces.body.netN', '합력 ΣF', 'N') + fact('forces.body.inertialN', '질량 × 가속도', 'N') + '<p class="detail-caption">고정 홀더의 구속력은 중력과 서스펜션 전달력의 합을 상쇄합니다.</p>')}
      ${card('휠에 작용하는 힘', force('forces.wheel.contactN', '타이어 접촉력') + force('forces.wheel.suspensionN', '서스펜션 반력') + force('forces.wheel.gravityN', '휠 중력') + fact('forces.wheel.netN', '합력 ΣF', 'N') + fact('forces.wheel.inertialN', '질량 × 가속도', 'N') + '<p class="detail-caption">차체와 휠의 서스펜션 힘은 크기가 같고 방향이 반대입니다.</p>')}
      ${card('서스펜션 전달력의 구성', fact('forces.springN', '스프링', 'N') + fact('forces.damperN', '댐퍼', 'N') + fact('forces.stopN', '범프 · 리바운드 스토퍼', 'N') + fact('forces.suspensionN', '전달력 합계', 'N') + '<p class="detail-caption" id="detail-source-note"></p>')}
      ${card('휠 ↔ 부품 축 방향', fact('motion.motionRatio', '고정 모션 비율 r', '', 1, 4) + fact('motion.wheelTravelM', '휠 상대 이동 q', 'mm', 1000, 2) + fact('motion.axialTravelM', '계산상 축 이동 r·q', 'mm', 1000, 2) + fact('motion.axialVelocityMps', '계산상 축 속도', 'm/s', 1, 3) + fact('motion.springAxialForceN', '축 방향 스프링 힘', 'N') + fact('motion.damperAxialForceN', '축 방향 댐퍼 힘', 'N') + '<p class="detail-caption">축 힘 = 휠 기준 힘 ÷ r. 이 변환값은 화면 속 대표 부품의 길이 변화와 구분됩니다.</p>')}
      ${card('순간 소산률 · 스트로크 한계', fact('power.damperLossW', '댐퍼 소산률', 'W') + fact('power.stopLossW', '스토퍼 감쇠 소산률', 'W') + fact('stop.bumpPenetrationM', '압축 한계 초과량', 'mm', 1000, 2) + fact('stop.reboundPenetrationM', '신장 한계 초과량', 'mm', 1000, 2) + fact('power.kineticRateW', '질량계 운동에너지 변화율', 'W') + '<p class="detail-caption">소산률은 댐퍼·스토퍼 감쇠 항의 힘 × 상대 속도입니다. 운동에너지 변화율은 모든 힘의 일을 포함합니다. 스토퍼는 유연한 힘 모델입니다.</p>')}
      ${card('타이어의 단방향 접촉', '<p class="detail-state" id="detail-tire-state"></p>' + fact('tire.compressionM', '타이어 압축량', 'mm', 1000, 2) + fact('tire.elasticTrialN', '탄성 시험항', 'N') + fact('tire.dampingTrialN', '감쇠 시험항', 'N') + fact('tire.rawForceN', '제약 전 시험력', 'N') + fact('tire.actualForceN', '실제 접촉력', 'N') + '<p class="detail-caption">압축량 ≤ 0이면 힘은 0입니다. 압축량이 양수여도 시험력이 음수이면 인장력을 차단합니다.</p>')}
      ${card('에어 스프링의 현재 상태', fact('air.absolutePressurePa', '절대 압력', 'bar', .00001, 3) + fact('air.gaugePressurePa', '게이지 압력', 'bar', .00001, 3) + fact('air.volumeM3', '현재 계산 용적', 'L', 1000, 3) + fact('air.minimumVolumeM3', '계산 용적 하한', 'L', 1000, 3) + '<p class="detail-caption" id="detail-air-note"></p>', 'detail-air-card')}
    </div><p class="detail-footer">이 패널은 현재 실시간 시험만 표시합니다. 저장된 실험·차트 커서·누적 통계는 각 분석 화면에서 확인하세요.</p></div></details>`;
  const fields = [...panel.querySelectorAll('.detail-fact')];
  const forceRows = [...panel.querySelectorAll('[data-force-key]')];
  const text = (id, value) => { const node = document.getElementById(id); if (node.textContent !== value) node.textContent = value; };
  let lastConfig, lastSnapshotKey, detail;
  function update(config, snapshot, diagnostics = {}) {
    const snapshotKey = JSON.stringify(snapshot);
    if (lastConfig !== config || snapshotKey !== lastSnapshotKey) {
      detail = suspensionDetail(config, snapshot); lastConfig = config; lastSnapshotKey = snapshotKey;
      for (const node of fields) {
        const value = at(detail, node.dataset.detailKey);
        if (value == null) { node.textContent = '—'; delete node.dataset.value; continue; }
        node.dataset.value = String(value);
        const scaled = value * Number(node.dataset.scale), digits = Number(node.dataset.digits);
        const normalized = Math.abs(scaled) < .5 * 10 ** -digits ? 0 : scaled;
        const display = normalized.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
        node.textContent = `${display}${node.dataset.displayUnit ? ' ' + node.dataset.displayUnit : ''}`;
      }
      const forceMax = Math.max(1, ...forceRows.map(row => Math.abs(at(detail, row.dataset.forceKey))));
      for (const row of forceRows) {
        const value = at(detail, row.dataset.forceKey), bar = row.querySelector('i');
        bar.style.width = `${Math.abs(value) / forceMax * 50}%`;
        bar.style.left = value >= 0 ? '50%' : `${50 - Math.abs(value) / forceMax * 50}%`;
        row.dataset.direction = value < 0 ? 'down' : 'up';
      }
      text('detail-reference', `현재 시험 ${detail.timeS.toFixed(3)} s · ${config.holderMode === 'fixed' ? '고정 홀더' : '차체 응답'} · 원시 값은 SI 단위`);
      text('detail-summary-value', `댐퍼 소산 ${detail.power.damperLossW.toFixed(1)} W`);
      text('detail-source-note', `스프링: ${sourceNames[detail.spring.source]}${detail.spring.curveOutOfRange ? ' · 입력 범위 밖' : ''}. 댐퍼: ${sourceNames[detail.damper.source]} · ${detail.damper.branch === 'compression' ? '압축' : '리바운드'}${detail.damper.curveOutOfRange ? ' · 입력 범위 밖' : ''}.`);
      text('detail-tire-state', detail.tire.branch === 'loaded' && !detail.tire.reportedContact ? '미소 접촉력 · 0.001 N 표시 문턱 이하' : branches[detail.tire.branch]);
      document.querySelector('#detail-air-card').hidden = !detail.air;
      if (detail.air) text('detail-air-note', `${detail.air.volumeLimited ? '용적 하한이 적용 중입니다. ' : ''}초기 정적 하중을 기준으로 압력 변화의 힘을 더합니다. 게이지 압력 × 면적은 현재 스프링 힘과 직접 같지 않습니다.`);
    }
    const inspection = diagnostics.inspection;
    for (const id of ['spring', 'damper']) document.querySelector(`#inspect-${id}`).setAttribute('aria-pressed', String(inspection?.id === id));
    document.querySelector('#exit-inspection').hidden = !inspection;
    const banner = document.querySelector('#inspection-banner');
    banner.hidden = !inspection;
    text('inspection-title', inspection?.id === 'damper' ? '댐퍼 내부 · 대표 단면' : '스프링 · 받침 확대');
    const mechanical = diagnostics.mechanical;
    if (mechanical?.displayEnvelopeValid === false) text('detail-summary-value', '대표 코일 표시 범위 초과');
    if (mechanical) text('mechanical-detail-note', `${mechanical.displayEnvelopeValid === false ? '현재 자세는 대표 코일의 표시 범위를 벗어납니다. ' : ''}${config.springType === 'air' ? '에어 벨로즈와 연결 부품의 대표 단면입니다.' : `대표 코일 ${mechanical.turns}턴 · 선경 ${(mechanical.wireRadiusM * 2000).toFixed(1)} mm. 코일 수와 선경은 계산 강성을 정하지 않습니다.`} 댐퍼 몸체 길이는 표시 자세에 맞춰 변하며, 내부 유압 회로는 계산하지 않습니다.`);
    return detail;
  }
  return { update };
}
