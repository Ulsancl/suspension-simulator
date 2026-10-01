# 계산 모델과 적용 범위

모델 버전은 `quarter-car-1.3`입니다. 수직 단일 휠의 힘과 응답을 비교하는 축소 모델이며, 링크의 공간 다물체 운동이나 차량 전체 거동을 풀지 않습니다. 실제 차량의 하드포인트·부품 시험·노면·검증 신호가 아직 제공되지 않았으므로, 기본값과 형상은 시험대 예시입니다.

## 좌표와 정적 평형

내부 계산은 SI 단위입니다. UI의 km/h·bar·L·mm는 명시적으로 변환합니다. Y는 위, X는 차량 진행 및 노면 좌표, Z는 휠 축 방향이며 홀더는 음의 Z에 있습니다. `bodyY`와 `wheelY`는 정적 평형 대비 변위입니다.

`q = wheelY − bodyY`를 압축 트래블, `v = wheelVelocity − bodyVelocity`를 압축 속도로 정의합니다. `ms`는 차체 질량, `mu`는 비현가 질량, `g = 9.80665 m/s²`입니다. 초기 휠 지지력은 `(ms + mu)g`, 스프링의 휠 측 초기 힘은 `ms g`입니다. 고정 홀더 모드도 이 초기 하중을 사용하지만 차체 위치·속도·가속도는 0으로 고정합니다.

스프링·댐퍼·스토퍼를 합한 지지력을 `Fsusp`, 타이어 접지력을 `Ft`라 하면 탄성 차체 모드의 식은 다음과 같습니다.

```text
ms · bodyAcceleration  = Fsusp − ms g
mu · wheelAcceleration = Ft − Fsusp − mu g
```

두 질량과 수직 스프링·댐퍼를 사용하는 기본 구성은 [MathWorks quarter-car 예제](https://www.mathworks.com/help/mpc/ug/admm-based-mpc-control-for-quarter-car-suspension.html)와 같은 계열입니다. 본 구현에는 접촉 상실, 비선형 부품 곡선과 스토퍼를 추가합니다.

## 기하와 모션비

더블 위시본은 정면 평면에서 암 길이와 상·하 볼 조인트 간격을 보존하는 원 교차로 기하를 계산합니다. 맥퍼슨은 하부 암과 상부 스트럿 고정점을 사용합니다. 멀티링크는 대표 연결 배치를 근사하며 개별 공간 링크의 동시 구속을 풀지 않습니다. 표시되는 캠버는 이 기하에서 얻으며 토는 0으로 둡니다. 하드포인트는 현재 사용자가 입력할 수 없습니다.

자동 모션비는 정적 위치에서 스프링 길이 `L`을 ±1 mm 이동시켜 계산합니다.

```text
mr = [L(−0.001) − L(+0.001)] / 0.002
```

자동값은 0.2–1.3으로 제한하고 기하가 유효하지 않으면 수동값을 사용합니다. 자동 모션비를 끄면 수동 설정을 사용합니다. 계산된 비율은 한 시험 내내 일정합니다. 구조별 임의의 성능 배수는 사용하지 않습니다. 축방향 변위·속도는 `mr q`, `mr v`, 휠 힘은 축방향 힘의 `mr`배이므로 선형 휠 강성과 감쇠는 각각 축방향 값의 `mr²`배입니다. 전체 스트로크에서 변하는 모션비의 효과는 포함하지 않습니다.

## 기본 스프링·댐퍼·스토퍼

코일은 `Fs = max(0, ms g + k mr² q)`입니다. 점진형은 증가분 `k mr² q [1 + 1.6(q/0.1)²]`를 사용합니다. 후자는 제품 시험 곡선이 아닌 시연용 법칙입니다. 댐퍼는 `v ≥ 0`에서 압축 계수, `v < 0`에서 리바운드 계수를 사용하여 `Fd = c mr² v`를 계산합니다. 기본 선형 관계는 [병진 스프링](https://www.mathworks.com/help/simscape/ref/translationalspring.html)과 [병진 댐퍼](https://www.mathworks.com/help/sdl/ref/translationaldamper.html) 자료를 참고합니다.

에어는 일정 유효 면적 A와 폴리트로픽 가스 법칙 `Pabs Vⁿ = constant`를 사용합니다. `P0 = gaugePressure × 100000 + 101325`, `V0 = airVolume × 0.001`, `V = max(0.15 V0, V0 − A mr q)`이며 스프링 힘은 다음과 같습니다.

```text
Fs = max(0, ms g + mr A P0 [(V0/V)ⁿ − 1])
```

초기 하중을 별도로 맞추므로 압력 변경은 정적 차고보다 증가 강성을 바꿉니다. `0.15 V0`는 수치 보호용 하한입니다. 실제 벨로즈의 높이별 면적·마찰·열 전달·배관 유량·레벨 제어는 포함하지 않습니다. 가스 법칙은 [가스 충전 축압기](https://www.mathworks.com/help/hydro/ref/gaschargedaccumulatoril.html), 실제 제품의 높이·압력별 특성 필요성은 [에어 스프링](https://www.mathworks.com/help/sdl/ref/airspring.html) 자료를 참고합니다.

트래블 한계는 강체 위치 고정이 아닌 탄성 스토퍼입니다. `b = max(0, q − travelBump)`, `r = max(0, −q − travelRebound)`에 대해 `350000(b−r) + 15000000(b³−r³)` N을 적용합니다. 스토퍼를 더 압축하는 방향에서만 `2200 v` N의 감쇠를 더합니다. 한계 초과가 가능하며 이를 별도 상태로 표시합니다.

## 부품 특성 곡선

선택적인 `componentProfile`은 다음 형식입니다. 아래 값은 형식 설명용 선형 예제입니다.

```json
{
  "format": "suspension-components/v1",
  "units": "SI",
  "name": "형식 예제 · 실측 아님",
  "source": "선형 수식 생성",
  "spring": [[0, 0], [0.1, 3200], [0.2, 6400], [0.4, 12800]],
  "damper": [[-3, -8400], [-1, -2800], [0, 0], [1, 1800], [3, 5400]]
}
```

스프링 또는 댐퍼 중 하나 이상이 필요합니다. 입력한 종류의 곡선은 해당 기본 식보다 우선하며 누락한 종류는 기본 모델을 사용합니다. 힘을 변위·속도 표로 정의하는 방식은 [비선형 스프링](https://www.mathworks.com/help/sdl/ref/nonlineartranslationalspring.html)과 [비선형 댐퍼](https://www.mathworks.com/help/sdl/ref/nonlineartranslationaldamper.html) 자료를 참고합니다.

스프링 점은 **절대 축방향 압축량 m, 힘 N**입니다. 2–1000개 점, 압축량 0–1 m, 힘 0–2 MN이며 압축량과 힘 모두 엄격하게 증가해야 합니다. 구간 기울기는 최대 10 MN/m입니다. 정적 축하중 `ms g / mr`가 힘 범위 안에 있어야 하며, 구간별 직선의 역함수로 정적 압축량 `c0`를 찾습니다.

```text
f(c0) = ms g / mr
Fs = mr · max(0, f(c0 + mr q))
effectiveWheelRate = f′(c0) · mr²
```

정적 하중을 이미 곡선에 포함했으므로 `ms g`를 다시 더하지 않습니다. 절점의 정적 접선은 압축 방향 기울기를 사용합니다.

댐퍼 점은 **부호 있는 축방향 속도 m/s, 힘 N**입니다. 압축은 양수, 리바운드는 음수이며 `[0,0]`과 양·음 속도 구간이 필요합니다. 2–1000개 점, 속도 ±10 m/s, 힘 ±2 MN, 절대 구간 기울기 최대 200 kN·s/m입니다. 각 점에서 `속도 × 힘 ≥ 0`을 요구하며 휠 힘은 `Fd = mr · fd(mr v)`입니다. 전체 힘 크기의 단조 증가는 요구하지 않습니다. 이 부호에서 댐퍼가 계에 공급하는 기계적 동력은 `−Fd v ≤ 0`입니다.

점 사이에는 직선 보간, 범위 밖에는 끝 구간 기울기 외삽을 사용합니다. 스프링 인장력은 0으로, 댐퍼의 에너지 공급 방향 힘은 0으로 제한합니다. `springCurveOutOfRange`와 `damperCurveOutOfRange`를 표시하고, 어느 한 곡선이라도 벗어난 시간 비율을 `curveExtrapolationPct`로 집계합니다. 외삽을 허용한다는 사실이 해당 영역의 실제 성능을 보증하지는 않습니다. 실측 댐퍼 입력 시 압축·리바운드 계수 탐색은 거부합니다. 히스테리시스·온도·주파수·캐비테이션·마찰의 독립 모델은 없습니다.

## 노면과 타이어 접촉

노면 좌표는 `x = speed/3.6 × time`입니다. 범프는 코사인, 턱은 직사각형 상승 구간, 홀은 직사각형 하강 구간입니다. 첫 단일 장애물 중심은 `0.55 × roadSpacing`이고 앞에 평탄 구간을 둡니다. 1회 연속 요철은 3개 파장, 1회 혼합은 첫 범프를 사용합니다. 반복 모드에서는 입력을 계속합니다. 표준 실험은 1회 입력 설정에서도 지정한 기록 시간까지 계산합니다.

타이어 반경 R의 원형 하부 형상으로 지지 노면을 평가합니다. 반경 안의 25개 후보와 턱·홀의 정확한 경계 양쪽 후보에서 `h(x+s) + sqrt(R²−s²) − R`의 최댓값을 취합니다. 이를 `roadY`로 사용하므로 휠이 좁은 홀을 걸쳐 지나가거나 턱에 미리 접촉할 수 있습니다. 연속 곡선의 최댓값을 해석적으로 푸는 방법은 아닙니다.

정적 타이어 압축은 `δ0 = (ms+mu)g/kt`, 동적 압축은 `δ = δ0 + roadY − wheelY`입니다. `δ > 0`일 때 `Ft = max(0, kt δ + ct(roadVelocity − wheelVelocity))`, 그 외에는 0입니다. 노면 속도는 ±1 mm 공간 차분으로 계산합니다. 타이어는 지면을 당기지 않습니다. 접촉 패치·유한 요소 타이어·횡력·슬립·휠 회전 관성은 포함하지 않으며 회전은 화면 표시용입니다.

## 적분과 기록

RK4를 사용하며 설정에 따라 내부 시간 간격을 다음 상한보다 작게 나눕니다.

```text
dt ≤ min(0.001, mu/(4 Cbound), 0.25 sqrt(mu/Kbound))
Cbound = max(압축계수, 리바운드계수, 곡선 최대 감쇠 기울기) mr² + ct + 2200
Kbound = kt + max(정적 휠 강성, 곡선 최대 스프링 기울기 mr²)
```

부품 곡선의 최대 기울기가 포함되어 높은 강성·감쇠에서 더 작은 간격을 사용합니다. 이는 설정에 따른 시간 분할이며 국부 오차 추정에 의한 적응형 정확도 제어는 아닙니다. 접촉 전환·스토퍼·외삽 영역에서는 별도의 수렴 검토가 필요합니다.

상태는 120 Hz로 기록하고 최대 3600개를 보관합니다. 실시간 그래프는 최근 약 30초입니다. 전체 시험 카드의 RMS·피크·접지 이탈·곡선 외삽 비율은 시험 전체의 적분 통계이며 그래프 창을 바꿔도 바뀌지 않습니다. 응답 분석의 그래프 아래 통계는 현재 표시한 시간 창의 기록 표본만 대상으로 계산하므로 전체 시험 카드와 다를 수 있습니다. 실험 기록의 최소·최대 접지력과 압축·리바운드 피크는 기록 표본에서 구합니다. 표준 시험의 길이는 1–30초입니다.

정착 시간은 1회 입력에만 추정합니다. 반경을 고려한 장애물 통과 이후 `|q| ≤ 2 mm`, `|bodyVelocity| ≤ 10 mm/s`, `|wheelVelocity| ≤ 20 mm/s`가 기록 끝까지 최소 0.5초 유지되는 첫 구간을 찾습니다. 표시값은 자극 종료부터 그 구간 시작까지의 경과 시간입니다. 반복 입력이나 불충분한 관찰 시간에는 값을 제공하지 않습니다. 이는 제품 시험 규격의 정착 시간 정의가 아닙니다.

## 선형 모드와 실측 잔차

모드 계산은 정적 `effectiveWheelRate = kw`를 사용합니다. 실측 스프링이 있으면 정적 접선, 없으면 코일·점진형의 초기 강성 또는 에어의 초기 접선을 사용합니다.

```text
M = diag(ms, mu)
K = [[kw, −kw], [−kw, kw+kt]]
K φ = ω² M φ,   frequencyHz = ω/(2π)
고정 홀더: frequencyHz = sqrt((kw+kt)/mu)/(2π)
```

감쇠 없는 소신호, 접촉 유지, 스토퍼 비작동의 고유진동수입니다. 비선형 시험의 실제 공진 피크나 전체 차량 모드가 아닙니다.

실측 비교는 `simulationTime = measuredTime + timeOffset` 규칙으로 시간축을 옮기고, 겹치는 구간에서 시뮬레이션 신호를 선형 보간합니다. 잔차는 `시뮬레이션 − 실측`입니다. RMSE, MAE, 최대 절대 오차와 `R² = 1 − Σ잔차²/Σ(실측−평균)²`를 계산합니다. 상수 신호의 R²는 null이며 R²가 음수가 될 수 있습니다. 자동 오프셋 탐색·단위 추정·중력 제거·필터링·겹침 밖 외삽은 하지 않습니다.

평탄 정적 평형과 선형 감쇠 응답의 폐형식 비교는 수치 구현을 확인하는 기준 시험입니다. 센서 교정, 독립 솔버 비교와 실차의 적용 영역 검증은 별도입니다. 필요한 근거는 [엔지니어링 출시 조건](engineering-release.md)을 확인합니다.

## 현재 상태의 상세 관찰

`src/detail-model.js`의 `suspensionDetail(config, snapshot)`은 적용된 `sim.config`와 현재 `sim.snapshot()`에서 도출하는 읽기 전용 관찰 API입니다. 이미 정리된 설정과 유한한 스냅샷을 요구하며 잘못된 값을 자동 보정하지 않습니다. 적분, 모형 버전 `quarter-car-1.3`, 기록 표본, 전체 시험 통계와 저장 형식을 바꾸지 않습니다. 반환값은 독립 객체이고 모든 물리량은 SI 단위입니다. 표시 배율 `timeScale`은 물리 속도·가속도·동력에 곱하지 않습니다.

### 힘의 작용 대상과 고정 지지대

상세값의 힘 부호는 Y 위쪽을 양수로 둡니다. `forces.suspensionN`은 원래 스냅샷의 `springForce + damperForce + bumpStopForce`이며, 차체에는 이 힘이 위쪽으로, 휠에는 반대 방향으로 작용합니다.

```text
차체: Fsusp − ms g + Rfixed = ms · bodyAcceleration
휠:   Ft − Fsusp − mu g     = mu · wheelAcceleration
고정 차체: Rfixed = ms g − Fsusp
탄성 차체: Rfixed = 0
```

`forces.body`는 `{suspensionN,gravityN,constraintN,netN,inertialN,residualN}`, `forces.wheel`은 `{contactN,suspensionN,gravityN,netN,inertialN,residualN}`입니다. `inertialN`은 질량×가속도이며 `residualN`은 힘의 합에서 그 값을 뺀 수치 잔차입니다.

기존 `holderReaction`의 의미와 기록은 그대로 유지합니다. 이 값은 서스펜션 전달하중 Fsusp이고, 상세값에서는 `forces.transmittedHolderN`으로 복사합니다. 고정 차체의 별도 외부 구속력 `forces.body.constraintN`과 같은 값이 아닙니다. 예를 들어 기본 질량의 평탄 정적 상태에서는 전달하중이 3138.128 N이고 외부 구속력은 0 N입니다. 고정 차체는 움직이지 않으므로 구속력이 생겨도 구속력의 기계적 동력은 0입니다.

### 축약 모형의 모션비와 실제 표시 기하

`motion`은 `{wheelTravelM,relativeVelocityMps,motionRatio,axialTravelM,axialVelocityMps,springAxialForceN,damperAxialForceN,staticWheelRateNpm}`입니다. 휠 상대 트래블 q와 속도 v는 압축 방향이 양수이고, `relativeVelocityMps = wheelVelocity − bodyVelocity`입니다.

```text
축약 축방향 변위 = mr q
축약 축방향 속도 = mr v
축방향 스프링 힘 = Fs / mr
축방향 댐퍼 힘 = Fd / mr
(Fwheel / mr) · (mr v) = Fwheel v
```

이는 정적 위치에서 정한 일정 모션비를 쓰는 축약 모형의 관계입니다. 화면 링크가 현재 위치에서 만드는 실제 길이 변화와 동일하다고 표시하지 않습니다. 예를 들어 기본 더블 위시본에서 휠 압축 80 mm의 `mr q`는 약 45.254 mm이고, 표시 기하의 스프링 양끝 길이 차이는 약 46.621 mm입니다. `staticWheelRateNpm`은 기존 `effectiveWheelRate`의 정적 접선이며, 비선형 스프링의 현재 접선 강성이 아닙니다. 스토퍼 힘은 휠 상대좌표에 직접 정의되어 있으므로 별도 축방향 부품력으로 환산하지 않습니다.

### 순간 동력과 소산률

`power.damperLossW = Fd v`는 기본 계수와 허용된 특성표 모두에서 0 이상입니다. 범프 또는 리바운드 스토퍼를 더 누르는 분기에서만 `power.stopLossW = 2200 v²`가 생기고, 복귀하거나 정지하면 0입니다. `stop`은 `{bumpPenetrationM,reboundPenetrationM,elasticN,dampingN,loading}`이며 실제 스토퍼 힘을 탄성 항과 한 방향 감쇠 항으로 나누어 표시합니다. 복귀 중 탄성 스토퍼가 에너지를 돌려주는 동력과 감쇠 소산률을 혼동하지 않습니다.

`power`는 다음 순간 기계적 관계를 제공합니다.

```text
bodyKineticRateW  = ms · bodyVelocity · bodyAcceleration
wheelKineticRateW = mu · wheelVelocity · wheelAcceleration
kineticRateW      = bodyKineticRateW + wheelKineticRateW
gravityW         = −ms g bodyVelocity − mu g wheelVelocity
tireOnWheelW     = Ft · wheelVelocity
springOnMassesW  = −Fs v
damperOnMassesW  = −Fd v
stopOnMassesW    = −Fstop v
constraintW     = Rfixed · bodyVelocity
residualW        = gravityW + tireOnWheelW + springOnMassesW
                 + damperOnMassesW + stopOnMassesW + constraintW − kineticRateW
```

양수 동력은 두 질량의 운동에너지를 늘리는 방향입니다. 이 합은 현재 힘과 속도의 관계이며, 전체 계의 누적 에너지 보존 검증이나 새 에너지 원장이 아닙니다. 스프링에 저장된 절대 에너지, 타이어 발열, 부품 온도·열전달·파손 시간을 추가로 계산하지 않습니다.

### 타이어의 제한 전후 힘

`tire`는 `{compressionM,compressionVelocityMps,elasticTrialN,dampingTrialN,rawForceN,actualForceN,branch,reportedContact}`입니다. 압축 속도는 `roadVelocity − wheelVelocity`이며 시험 항은 `elasticTrialN = kt δ`, `dampingTrialN = ct δdot`, `rawForceN = elasticTrialN + dampingTrialN`입니다. 시험 항은 기하학적 접촉이 없을 때도 부호 그대로 계산하여 실제 적용력과 구분합니다.

- `detached`: δ≤0이므로 시험 항의 합이 양수여도 실제 접지력은 0입니다.
- `clamped`: δ>0이지만 시험 항의 합이 0 이하이므로 인장 방지 제한으로 실제 접지력이 0입니다.
- `loaded`: δ>0이고 시험 항의 합이 양수여서 실제 접지력으로 적용됩니다.

`actualForceN`은 새로 만든 힘이 아닌 기존 `contactForce`의 복사본입니다. 기존 `contact` 표시 문턱은 0.001 N이므로, 매우 작은 양의 힘에서는 `branch:'loaded'`여도 `reportedContact:false`일 수 있습니다. 원래 접지 이탈 통계는 이 표시 규칙을 그대로 사용합니다. 제한이 활성화된 상태에서 `ct δdot²`를 실제 타이어 감쇠 손실로 단정하지 않습니다. 예를 들어 양의 압축이 남아도 인장 제한으로 Ft=0이면 `tireOnWheelW`는 0입니다.

### 특성표 우선순위와 에어 체적 하한

`spring.source`는 `curve`, `coil`, `progressive`, `air` 중 실제 적용된 법칙을, `damper.source`는 `curve` 또는 `coefficient`를 나타냅니다. 양쪽의 `curveOutOfRange`는 기존 스냅샷의 해당 외삽 표시를 그대로 복사합니다. `damper.branch`는 휠 상대속도 0 이상에서 `compression`, 음수에서 `rebound`입니다. 특성표는 입력한 종류에만 우선하며, 예를 들어 댐퍼 표만 있으면 기본 에어 스프링은 계속 적용됩니다.

`air`는 기본 에어 법칙이 실제 적용될 때만 객체이며, 다른 스프링 또는 스프링 특성표 사용 시 `null`입니다. 필드는 `{initialVolumeM3,rawVolumeM3,volumeM3,minimumVolumeM3,volumeLimited,initialAbsolutePressurePa,absolutePressurePa,gaugePressurePa}`입니다. `rawVolumeM3 = V0 − A mr q`, `minimumVolumeM3 = 0.15 V0`, `volumeM3`는 하한을 적용한 기존 계산 체적입니다. 하한 이하에서는 `volumeLimited:true`이며 압력은 이 보호 체적의 폴리트로픽 법칙으로 계산합니다. 절대압력과 대기압 101325 Pa를 뺀 게이지압력을 구분합니다.

에어 초기 하중은 별도로 정적 평형에 맞추므로 축방향 스프링 힘이 단순히 `A × gaugePressurePa`와 같다고 표시하지 않습니다. 체적 하한도 벨로즈의 실제 최소 높이나 충돌을 새로 푼 것이 아닙니다. 하한 이후의 압축을 근거로 가스 유량·열역학 에너지·온도를 만들지 않습니다.

### 상세 관찰 검증

12개 추가 검사는 2개 홀더 모드×3개 스프링×3개 구조의 정적·동적 힘수지, 독립 운동에너지 중앙차분, 모션비의 가상일, 양쪽 스토퍼의 접근·복귀·경계, 타이어의 세 분기와 표시 문턱, 에어의 압력·체적 보호, 특성표 우선순위와 외삽 소산, 원본 설정·표본·전체 통계의 불변성을 확인합니다.

```sh
node --test tests/physics.test.mjs tests/component-curves.test.mjs tests/engineering.test.mjs tests/detail-model.test.mjs
```
