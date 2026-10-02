import { normalizeConfig } from './physics.js';

const GRAVITY = 9.80665;
const ATMOSPHERE_PA = 101325;
const STOP_DAMPING_NS_PER_M = 2200;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const zero = value => Object.is(value, -0) ? 0 : value;
const numericFields = ['time', 'bodyY', 'wheelY', 'bodyVelocity', 'wheelVelocity', 'travel',
  'roadVelocity', 'tireCompression', 'contactForce', 'springForce', 'damperForce', 'bumpStopForce',
  'holderReaction', 'bodyAcceleration', 'wheelAcceleration', 'effectiveMotionRatio', 'effectiveWheelRate'];

function sameData(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => sameData(actual[index], value));
  if (!record(expected)) return actual === expected;
  return record(actual) && Object.keys(actual).length === Object.keys(expected).length
    && Object.keys(expected).every(key => Object.hasOwn(actual, key) && sameData(actual[key], expected[key]));
}

function checkedInputs(config, snapshot) {
  if (!record(config) || !sameData(config, normalizeConfig(config))) throw new TypeError('Details require the applied, normalized simulation config');
  if (!record(snapshot) || numericFields.some(key => typeof snapshot[key] !== 'number' || !Number.isFinite(snapshot[key]))) throw new TypeError('Details require a finite simulation snapshot');
  if (['contact', 'springCurveOutOfRange', 'damperCurveOutOfRange'].some(key => typeof snapshot[key] !== 'boolean')) throw new TypeError('Snapshot branch flags must be boolean');
  if (snapshot.time < 0 || snapshot.effectiveMotionRatio <= 0 || snapshot.effectiveWheelRate < 0
      || snapshot.contactForce < 0 || snapshot.springForce < 0) throw new RangeError('Snapshot quantities are outside the model domain');
  if (snapshot.travel !== snapshot.wheelY - snapshot.bodyY) throw new RangeError('Snapshot travel must equal wheelY minus bodyY');
  if (config.holderMode === 'fixed' && [snapshot.bodyY, snapshot.bodyVelocity, snapshot.bodyAcceleration].some(value => value !== 0)) throw new RangeError('A fixed-holder snapshot must have a stationary body');
}

function finiteResult(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError('Derived detail exceeds finite numeric range');
  if (value && typeof value === 'object') Object.values(value).forEach(finiteResult);
  return value;
}

/** Read-only SI observations of one current quarter-car-1.3 snapshot.
 * Positive Y is up; wheel-minus-body velocity is positive compression.
 * This function neither advances nor reconfigures the simulation. It creates
 * no cumulative energy, temperature, flow, or additional mechanical state.
 */
export function suspensionDetail(config, snapshot) {
  checkedInputs(config, snapshot);
  const s = snapshot, mr = s.effectiveMotionRatio;
  const velocity = s.wheelVelocity - s.bodyVelocity;
  const suspensionN = s.springForce + s.damperForce + s.bumpStopForce;
  const bodyGravityN = -config.sprungMass * GRAVITY, wheelGravityN = -config.unsprungMass * GRAVITY;
  const constraintN = config.holderMode === 'fixed' ? -bodyGravityN - suspensionN : 0;
  const bodyNetN = suspensionN + bodyGravityN + constraintN;
  const wheelNetN = s.contactForce - suspensionN + wheelGravityN;
  const bodyInertialN = config.sprungMass * s.bodyAcceleration;
  const wheelInertialN = config.unsprungMass * s.wheelAcceleration;
  const bump = Math.max(0, s.travel - config.travelBump), rebound = Math.max(0, -s.travel - config.travelRebound);
  const loading = (bump > 0 && velocity > 0) || (rebound > 0 && velocity < 0);
  const stopDampingN = loading ? STOP_DAMPING_NS_PER_M * velocity : 0;
  const tireVelocity = s.roadVelocity - s.wheelVelocity;
  // These are unconstrained trial terms, including when geometric contact is
  // absent. The actual force always comes from the solved unilateral model.
  const tireElasticN = config.tireRate * s.tireCompression;
  const tireDampingN = config.tireDamping * tireVelocity;
  const tireRawN = tireElasticN + tireDampingN;
  const bodyKineticRateW = config.sprungMass * s.bodyVelocity * s.bodyAcceleration;
  const wheelKineticRateW = config.unsprungMass * s.wheelVelocity * s.wheelAcceleration;
  const kineticRateW = bodyKineticRateW + wheelKineticRateW;
  const gravityW = bodyGravityN * s.bodyVelocity + wheelGravityN * s.wheelVelocity;
  const tireOnWheelW = s.contactForce * s.wheelVelocity;
  const springOnMassesW = -s.springForce * velocity;
  const damperOnMassesW = -s.damperForce * velocity;
  const stopOnMassesW = -s.bumpStopForce * velocity;
  const constraintW = constraintN * s.bodyVelocity;
  const springSource = config.componentProfile?.spring ? 'curve' : config.springType;
  let air = null;
  if (springSource === 'air') {
    const initialVolumeM3 = config.airVolume * .001;
    const rawVolumeM3 = initialVolumeM3 - config.airArea * mr * s.travel;
    const minimumVolumeM3 = initialVolumeM3 * .15;
    const volumeM3 = Math.max(minimumVolumeM3, rawVolumeM3);
    const initialAbsolutePressurePa = config.airPressure * 100000 + ATMOSPHERE_PA;
    const absolutePressurePa = initialAbsolutePressurePa * (initialVolumeM3 / volumeM3) ** config.airExponent;
    air = { initialVolumeM3, rawVolumeM3, volumeM3, minimumVolumeM3,
      volumeLimited: rawVolumeM3 <= minimumVolumeM3,
      initialAbsolutePressurePa, absolutePressurePa, gaugePressurePa: absolutePressurePa - ATMOSPHERE_PA };
  }
  return finiteResult({
    timeS: s.time,
    motion: { wheelTravelM: s.travel, relativeVelocityMps: zero(velocity), motionRatio: mr,
      axialTravelM: zero(mr * s.travel), axialVelocityMps: zero(mr * velocity),
      springAxialForceN: s.springForce / mr, damperAxialForceN: zero(s.damperForce / mr), staticWheelRateNpm: s.effectiveWheelRate },
    forces: { springN: s.springForce, damperN: s.damperForce, stopN: s.bumpStopForce, suspensionN,
      // Retain the existing transmitted-load meaning. The external fixed-body
      // constraint force below is a different quantity and may have either sign.
      transmittedHolderN: s.holderReaction,
      body: { suspensionN, gravityN: bodyGravityN, constraintN: zero(constraintN), netN: zero(bodyNetN),
        inertialN: zero(bodyInertialN), residualN: zero(bodyNetN - bodyInertialN) },
      wheel: { contactN: s.contactForce, suspensionN: -suspensionN, gravityN: wheelGravityN, netN: zero(wheelNetN),
        inertialN: zero(wheelInertialN), residualN: zero(wheelNetN - wheelInertialN) } },
    power: { damperLossW: zero(s.damperForce * velocity), stopLossW: zero(stopDampingN * velocity),
      kineticRateW: zero(kineticRateW), bodyKineticRateW: zero(bodyKineticRateW), wheelKineticRateW: zero(wheelKineticRateW),
      gravityW: zero(gravityW), tireOnWheelW: zero(tireOnWheelW), springOnMassesW: zero(springOnMassesW),
      damperOnMassesW: zero(damperOnMassesW), stopOnMassesW: zero(stopOnMassesW), constraintW: zero(constraintW),
      residualW: zero(gravityW + tireOnWheelW + springOnMassesW + damperOnMassesW + stopOnMassesW + constraintW - kineticRateW) },
    stop: { bumpPenetrationM: bump, reboundPenetrationM: rebound, elasticN: zero(s.bumpStopForce - stopDampingN),
      dampingN: zero(stopDampingN), loading },
    tire: { compressionM: s.tireCompression, compressionVelocityMps: zero(tireVelocity),
      elasticTrialN: zero(tireElasticN), dampingTrialN: zero(tireDampingN), rawForceN: zero(tireRawN), actualForceN: s.contactForce,
      branch: s.tireCompression <= 0 ? 'detached' : tireRawN <= 0 ? 'clamped' : 'loaded', reportedContact: s.contact },
    spring: { source: springSource, curveOutOfRange: s.springCurveOutOfRange },
    damper: { source: config.componentProfile?.damper ? 'curve' : 'coefficient',
      branch: velocity >= 0 ? 'compression' : 'rebound', curveOutOfRange: s.damperCurveOutOfRange },
    air,
  });
}
