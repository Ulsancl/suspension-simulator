/**
 * Single-wheel suspension test rig, SI units except the explicitly labelled
 * km/h, bar and litre controls. Positive Y is upward; travel is compression.
 * The dynamic model is a vertical quarter car. Linkage geometry is evaluated
 * separately. Its static spring-length derivative can supply the reduced
 * model's small-signal motion ratio; the manual override is explicit.
 */
import { validateComponentProfile, createCurveModel } from './component-curves.js';

export const DEFAULT_CONFIG = Object.freeze({
  structure: 'wishbone', springType: 'coil', holderMode: 'fixed', road: 'bump',
  speed: 30, roadHeight: 0.06, roadWidth: 1, roadSpacing: 6,
  springRate: 32000, compressionDamping: 1800, reboundDamping: 2800,
  sprungMass: 320, unsprungMass: 45, tireRate: 220000, tireDamping: 250,
  travelBump: 0.11, travelRebound: 0.10, motionRatio: 0.85,
  airPressure: 5, airVolume: 3, airArea: 0.008, airExponent: 1.3,
  tireRadius: 0.34, timeScale: 0.5, singleEvent: false, autoMotionRatio: true, componentProfile: null,
});

const G = 9.80665;
const ATM = 101325;
const TAU = Math.PI * 2;
const RECORD_INTERVAL = 1 / 120;
const MAX_HISTORY = 3600;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const finite = (x, fallback) => Number.isFinite(Number(x)) ? Number(x) : fallback;
const mod = (x, n) => ((x % n) + n) % n;

const RANGES = {
  speed: [0, 160], roadHeight: [0, 0.25], roadWidth: [0.08, 6], roadSpacing: [1, 40],
  springRate: [4000, 160000], compressionDamping: [0, 16000], reboundDamping: [0, 20000],
  sprungMass: [80, 1200], unsprungMass: [15, 180], tireRate: [50000, 800000],
  tireDamping: [0, 2000], travelBump: [0.02, 0.25], travelRebound: [0.02, 0.25],
  motionRatio: [0.35, 1.3], airPressure: [0.5, 16], airVolume: [0.5, 15],
  airArea: [0.002, 0.015], airExponent: [1, 1.4], tireRadius: [0.2, 0.55],
  timeScale: [0.05, 3],
};

export function normalizeConfig(input = {}) {
  const config = { ...DEFAULT_CONFIG };
  for (const [key, range] of Object.entries(RANGES)) {
    config[key] = clamp(finite(input[key], DEFAULT_CONFIG[key]), ...range);
  }
  for (const [key, choices] of Object.entries({
    structure: ['wishbone', 'multilink', 'macpherson'],
    springType: ['coil', 'progressive', 'air'], holderMode: ['fixed', 'sprung'],
    road: ['bump', 'step', 'pothole', 'washboard', 'flat', 'mixed'],
  })) {
    config[key] = choices.includes(input[key]) ? input[key] : DEFAULT_CONFIG[key];
  }
  // A quiet interval separates each obstacle, including the tyre's footprint.
  config.roadSpacing = Math.max(config.roadSpacing, config.roadWidth + 2 * config.tireRadius + 0.1);
  config.singleEvent = input.singleEvent === true;
  config.autoMotionRatio = input.autoMotionRatio !== false;
  config.componentProfile = validateComponentProfile(input.componentProfile);
  return config;
}

function profileType(index, config) {
  return config.road === 'mixed' ? ['bump', 'step', 'pothole', 'bump'][mod(index, 4)] : config.road;
}

/** Raw road surface. The first obstacle is centred at 0.55 * roadSpacing. */
export function roadHeight(x, input = DEFAULT_CONFIG) {
  const config = input;
  const type = config.road ?? DEFAULT_CONFIG.road;
  if (type === 'flat' || !Number.isFinite(x)) return 0;
  const height = config.roadHeight ?? DEFAULT_CONFIG.roadHeight;
  const width = Math.max(0.08, config.roadWidth ?? DEFAULT_CONFIG.roadWidth);
  const spacing = Math.max(width + 0.1, config.roadSpacing ?? DEFAULT_CONFIG.roadSpacing);
  if (type === 'washboard') {
    const start = spacing * 0.35;
    if (x < start || (config.singleEvent && x > start + 3 * width)) return 0;
    return height * 0.5 * (1 - Math.cos(TAU * (x - start) / width));
  }
  const index = Math.floor((x - 0.55 * spacing) / spacing + 0.5);
  if (config.singleEvent && index !== 0) return 0;
  const center = (index + 0.55) * spacing;
  const delta = x - center;
  if (Math.abs(delta) > width / 2) return 0;
  const shape = profileType(index, config);
  if (shape === 'step') return height;
  if (shape === 'pothole') return -height;
  return height * 0.5 * (1 + Math.cos(TAU * delta / width));
}

/**
 * Support envelope of a circular rigid tyre over the supplied road. Tyre
 * compliance is applied after this geometric operation. Exact edge candidates
 * preserve step/pit bridging even when an obstacle is narrower than a sample.
 */
function roadEnvelope(x, config) {
  if (config.road === 'flat' || config.roadHeight === 0) return 0;
  const r = config.tireRadius;
  let highest = roadHeight(x, config);
  const evaluate = (offset) => {
    if (Math.abs(offset) > r) return;
    const value = roadHeight(x + offset, config) + Math.sqrt(Math.max(0, r * r - offset * offset)) - r;
    highest = Math.max(highest, value);
  };
  const samples = 24;
  for (let i = 0; i <= samples; i++) evaluate(-r + 2 * r * i / samples);
  if (config.road === 'step' || config.road === 'pothole' || config.road === 'mixed') {
    const spacing = config.roadSpacing;
    const base = Math.floor(x / spacing);
    for (let i = base - 1; i <= base + 1; i++) {
      const center = (i + 0.55) * spacing;
      for (const edge of [center - config.roadWidth / 2, center + config.roadWidth / 2]) {
        evaluate(edge - x - 1e-7);
        evaluate(edge - x + 1e-7);
      }
    }
  }
  return highest;
}

function suspensionForces(travel, velocity, config, curveModel = null) {
  const mr = config.motionRatio;
  const preload = config.sprungMass * G;
  const wheelRate = config.springRate * mr * mr;
  let incremental;
  if (config.springType === 'air') {
    const volume = config.airVolume * 0.001;
    const effectiveVolume = Math.max(volume * 0.15, volume - config.airArea * mr * travel);
    const absolutePressure = config.airPressure * 100000 + ATM;
    incremental = mr * config.airArea * absolutePressure * (Math.pow(volume / effectiveVolume, config.airExponent) - 1);
  } else if (config.springType === 'progressive') {
    // Defined demonstrator law: tangent rate grows quadratically with travel.
    incremental = wheelRate * travel * (1 + 1.6 * Math.pow(travel / 0.1, 2));
  } else {
    incremental = wheelRate * travel;
  }
  const measuredSpring = curveModel?.profile.spring ? curveModel.evaluateSpring(travel) : null;
  const springForce = measuredSpring ? measuredSpring.force : Math.max(0, preload + incremental);
  const coefficient = velocity >= 0 ? config.compressionDamping : config.reboundDamping;
  const measuredDamper = curveModel?.profile.damper ? curveModel.evaluateDamper(velocity) : null;
  const damperForce = measuredDamper ? measuredDamper.force : coefficient * mr * mr * velocity;
  // Compliant stops engage over 20 mm. They dissipate energy only while the
  // stop is being compressed, so they cannot pull the wheel toward a stop.
  const bump = Math.max(0, travel - config.travelBump);
  const rebound = Math.max(0, -travel - config.travelRebound);
  const stopRate = 350000;
  let bumpStopForce = stopRate * (bump - rebound) + 15000000 * (bump * bump * bump - rebound * rebound * rebound);
  if (bump > 0 && velocity > 0) bumpStopForce += 2200 * velocity;
  if (rebound > 0 && velocity < 0) bumpStopForce += 2200 * velocity;
  return { springForce, damperForce, bumpStopForce, suspensionForce: springForce + damperForce + bumpStopForce,
    springCurveOutOfRange: measuredSpring?.outOfRange || false, damperCurveOutOfRange: measuredDamper?.outOfRange || false };
}

const BASE_STATE = {
  time: 0, distance: 0, bodyY: 0, wheelY: 0, bodyVelocity: 0, wheelVelocity: 0,
  travel: 0, roadY: 0, rawRoadY: 0, roadVelocity: 0, contactForce: 0,
  springForce: 0, damperForce: 0, bumpStopForce: 0, holderReaction: 0,
  bodyAcceleration: 0, wheelAcceleration: 0, contact: true, bottomed: false,
  toppedOut: false, wheelRotation: 0, tireCompression: 0,
  effectiveMotionRatio: 0, effectiveWheelRate: 0,
  springCurveOutOfRange: false, damperCurveOutOfRange: false,
};

export class SuspensionSimulation {
  constructor(config = {}) { this.reset(config); }

  reset(config = this.config) {
    this.config = normalizeConfig(config);
    this._effectiveMotionRatio = getMotionRatio(this.config);
    this._forceConfig = { ...this.config, motionRatio: this._effectiveMotionRatio };
    this._curveModel = createCurveModel(this.config.componentProfile, { sprungMass: this.config.sprungMass, motionRatio: this._effectiveMotionRatio });
    this._effectiveWheelRate = this._curveModel?.profile.spring ? this._curveModel.tangentRate * this._effectiveMotionRatio ** 2 : this.config.springType === 'air'
      ? this.config.airExponent * (this.config.airPressure * 100000 + ATM) * this.config.airArea ** 2 * this._effectiveMotionRatio ** 2 / (this.config.airVolume * 0.001)
      : this.config.springRate * this._effectiveMotionRatio ** 2;
    this.state = { ...BASE_STATE };
    this.history = [];
    this._nextRecord = RECORD_INTERVAL;
    this._stats = { duration: 0, bodySquared: 0, wheelSquared: 0, lost: 0, curveExtrapolated: 0, bodyPeak: 0, wheelPeak: 0, travelPeak: 0, contactPeak: 0, reactionPeak: 0 };
    this._updateState(this._evaluate([0, 0, 0, 0], 0));
    this.history.push(this.snapshot());
    return this.snapshot();
  }

  /** Changes start a fresh, statically trimmed experiment. */
  configure(patch) { return this.reset({ ...this.config, ...patch }); }

  _evaluate(vector, time) {
    const config = this.config;
    const speed = config.speed / 3.6;
    const distance = time * speed;
    const roadY = roadEnvelope(distance, config);
    const epsilon = 0.001;
    const roadVelocity = speed === 0 ? 0 : speed * (roadEnvelope(distance + epsilon, config) - roadEnvelope(distance - epsilon, config)) / (2 * epsilon);
    const [bodyY, bodyVelocity, wheelY, wheelVelocity] = vector;
    const travel = wheelY - bodyY;
    const forces = suspensionForces(travel, wheelVelocity - bodyVelocity, this._forceConfig, this._curveModel);
    const tireCompression = (config.sprungMass + config.unsprungMass) * G / config.tireRate + roadY - wheelY;
    const contactForce = tireCompression > 0 ? Math.max(0, config.tireRate * tireCompression + config.tireDamping * (roadVelocity - wheelVelocity)) : 0;
    const bodyAcceleration = config.holderMode === 'fixed' ? 0 : (forces.suspensionForce - config.sprungMass * G) / config.sprungMass;
    const wheelAcceleration = (contactForce - forces.suspensionForce - config.unsprungMass * G) / config.unsprungMass;
    return {
      derivative: [config.holderMode === 'fixed' ? 0 : bodyVelocity, bodyAcceleration, wheelVelocity, wheelAcceleration],
      time, distance, bodyY, bodyVelocity, wheelY, wheelVelocity, travel, roadY,
      rawRoadY: roadHeight(distance, config), roadVelocity, tireCompression, contactForce,
      ...forces, holderReaction: forces.suspensionForce, bodyAcceleration, wheelAcceleration,
      contact: contactForce > 1e-3, bottomed: travel > config.travelBump,
      toppedOut: travel < -config.travelRebound, wheelRotation: distance / config.tireRadius,
      effectiveMotionRatio: this._effectiveMotionRatio, effectiveWheelRate: this._effectiveWheelRate,
    };
  }

  _updateState(result) {
    const { derivative, suspensionForce, ...fields } = result;
    Object.assign(this.state, fields);
    if (this.config.holderMode === 'fixed') {
      this.state.bodyY = 0; this.state.bodyVelocity = 0;
    }
  }

  step(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return this.snapshot();
    const config = this.config;
    const damping = Math.max(config.compressionDamping, config.reboundDamping, this._curveModel?.damperMaxSlope || 0) * this._effectiveMotionRatio ** 2 + config.tireDamping + 2200;
    // Bound the explicit step additionally for extreme damping slider values.
    const stiffness = config.tireRate + Math.max(this._effectiveWheelRate, (this._curveModel?.springMaxSlope || 0) * this._effectiveMotionRatio ** 2);
    const limit = Math.min(0.001, config.unsprungMass / (4 * Math.max(1, damping)), .25 * Math.sqrt(config.unsprungMass / stiffness));
    let remaining = dt;
    while (remaining > 1e-12) {
      const h = Math.min(limit, remaining);
      const s = this.state;
      const vector = [s.bodyY, s.bodyVelocity, s.wheelY, s.wheelVelocity];
      const time = s.time;
      const k1 = this._evaluate(vector, time).derivative;
      const k2 = this._evaluate(vector.map((v, i) => v + h * k1[i] / 2), time + h / 2).derivative;
      const k3 = this._evaluate(vector.map((v, i) => v + h * k2[i] / 2), time + h / 2).derivative;
      const k4 = this._evaluate(vector.map((v, i) => v + h * k3[i]), time + h).derivative;
      const next = vector.map((v, i) => v + h * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) / 6);
      this._updateState(this._evaluate(next, time + h));
      const a = this.state;
      const stats = this._stats;
      stats.duration += h;
      stats.bodySquared += a.bodyAcceleration * a.bodyAcceleration * h;
      stats.wheelSquared += a.wheelAcceleration * a.wheelAcceleration * h;
      if (!a.contact) stats.lost += h;
      if (a.springCurveOutOfRange || a.damperCurveOutOfRange) stats.curveExtrapolated += h;
      stats.bodyPeak = Math.max(stats.bodyPeak, Math.abs(a.bodyAcceleration));
      stats.wheelPeak = Math.max(stats.wheelPeak, Math.abs(a.wheelAcceleration));
      stats.travelPeak = Math.max(stats.travelPeak, Math.abs(a.travel));
      stats.contactPeak = Math.max(stats.contactPeak, a.contactForce);
      stats.reactionPeak = Math.max(stats.reactionPeak, Math.abs(a.holderReaction));
      if (a.time + 1e-10 >= this._nextRecord) {
        this.history.push(this.snapshot());
        if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
        this._nextRecord += RECORD_INTERVAL;
      }
      remaining -= h;
    }
    return this.snapshot();
  }

  advance(seconds) { return this.step(seconds); }
  snapshot() { return { ...this.state }; }

  metrics() {
    const s = this._stats;
    const rmsBodyAcceleration = s.duration ? Math.sqrt(s.bodySquared / s.duration) : 0;
    const rmsWheelAcceleration = s.duration ? Math.sqrt(s.wheelSquared / s.duration) : 0;
    return {
      duration: s.duration, rmsBodyAcceleration, peakBodyAcceleration: s.bodyPeak,
      rmsWheelAcceleration, peakWheelAcceleration: s.wheelPeak, peakTravel: s.travelPeak,
      contactLossPct: s.duration ? s.lost / s.duration * 100 : 0,
      peakContactForce: s.contactPeak, peakHolderReaction: s.reactionPeak,
      curveExtrapolationPct: s.duration ? s.curveExtrapolated / s.duration * 100 : 0,
      bodyRMS: rmsBodyAcceleration, bodyPeak: s.bodyPeak, travelPeak: s.travelPeak,
    };
  }

  exportCSV() {
    const keys = ['time', 'distance', 'bodyY', 'wheelY', 'travel', 'roadY', 'rawRoadY', 'bodyVelocity', 'wheelVelocity', 'bodyAcceleration', 'wheelAcceleration', 'contactForce', 'springForce', 'damperForce', 'bumpStopForce', 'holderReaction', 'tireCompression', 'effectiveMotionRatio', 'effectiveWheelRate', 'contact', 'bottomed'];
    const rows = this.history.slice();
    if (rows.at(-1)?.time !== this.state.time) rows.push(this.snapshot());
    return keys.join(',') + '\n' + rows.map(row => keys.map(key => typeof row[key] === 'boolean' ? Number(row[key]) : row[key].toFixed(7)).join(',')).join('\n') + '\n';
  }
}

function circleIntersections(a, ra, b, rb) {
  const dy = b[0] - a[0], dz = b[1] - a[1];
  const distance = Math.hypot(dy, dz);
  if (distance < 1e-10 || distance > ra + rb || distance < Math.abs(ra - rb)) return null;
  const along = (ra * ra - rb * rb + distance * distance) / (2 * distance);
  const height = Math.sqrt(Math.max(0, ra * ra - along * along));
  const py = a[0] + along * dy / distance, pz = a[1] + along * dz / distance;
  return [[py - height * dz / distance, pz + height * dy / distance], [py + height * dz / distance, pz - height * dy / distance]];
}

const rotateYZ = (offset, angle) => [offset[0] * Math.cos(angle) - offset[1] * Math.sin(angle), offset[0] * Math.sin(angle) + offset[1] * Math.cos(angle)];

/**
 * Double wishbone: exact front-view circle closure, constant upright length.
 * Multilink: equivalent front-view pivots with five illustrated spatial links;
 * its five individual 3-D lengths are not solved as a constrained multibody.
 * MacPherson: rigid knuckle guided by a lower arm and telescoping upper strut.
 * The spring-length derivative at static trim may set a constant dynamic
 * motion ratio. No lateral/steering compliance or longitudinal forces enter
 * the vertical equations.
 */
export function getGeometry(input = DEFAULT_CONFIG, wheelDisplacement = 0) {
  const config = normalizeConfig(input);
  wheelDisplacement = finite(wheelDisplacement, 0);
  const r = config.tireRadius;
  const target = r + finite(wheelDisplacement, 0);
  const lowerPivot = [r - 0.12, -0.72];
  const lowerBase = [r - 0.11, -0.09];
  const upperBase = [r + 0.25, -0.10];
  const upperPivot = config.structure === 'multilink' ? [r + 0.22, -0.64] : [r + 0.20, -0.62];
  const mount = [r + 0.70, -0.45];
  const lowerLength = Math.hypot(lowerBase[0] - lowerPivot[0], lowerBase[1] - lowerPivot[1]);
  const upperLength = Math.hypot(upperBase[0] - upperPivot[0], upperBase[1] - upperPivot[1]);
  const uprightLength = Math.hypot(upperBase[0] - lowerBase[0], upperBase[1] - lowerBase[1]);
  const uprightAngle = Math.atan2(upperBase[1] - lowerBase[1], upperBase[0] - lowerBase[0]);
  const strutAngle = Math.atan2(mount[1] - lowerBase[1], mount[0] - lowerBase[0]);
  const hubOffset = [0.11, 0.09];
  let valid = true;
  const closure = (lowerY) => {
    const vertical = lowerY - lowerPivot[0];
    if (Math.abs(vertical) >= lowerLength) return null;
    const lower = [lowerY, lowerPivot[1] + Math.sqrt(lowerLength * lowerLength - vertical * vertical)];
    let upper, rotation;
    if (config.structure === 'macpherson') {
      rotation = Math.atan2(mount[1] - lower[1], mount[0] - lower[0]) - strutAngle;
      const socketOffset = rotateYZ([(mount[0] - lowerBase[0]) * 0.45, (mount[1] - lowerBase[1]) * 0.45], rotation);
      upper = [lower[0] + socketOffset[0], lower[1] + socketOffset[1]];
    } else {
      const candidates = circleIntersections(upperPivot, upperLength, lower, uprightLength);
      if (!candidates) return null;
      upper = candidates.reduce((best, point) => Math.hypot(point[0] - upperBase[0], point[1] - upperBase[1]) < Math.hypot(best[0] - upperBase[0], best[1] - upperBase[1]) ? point : best);
      rotation = Math.atan2(upper[1] - lower[1], upper[0] - lower[0]) - uprightAngle;
    }
    const offset = rotateYZ(hubOffset, rotation);
    return { lower, upper, rotation, hub: [lower[0] + offset[0], lower[1] + offset[1]] };
  };
  let lowerY = lowerBase[0] + wheelDisplacement;
  let solved;
  for (let i = 0; i < 16; i++) {
    solved = closure(lowerY);
    if (!solved) { valid = false; break; }
    const error = solved.hub[0] - target;
    if (Math.abs(error) < 1e-9) break;
    const next = closure(lowerY + 1e-5);
    if (!next) { valid = false; break; }
    const derivative = (next.hub[0] - solved.hub[0]) / 1e-5;
    if (Math.abs(derivative) < 0.05) { valid = false; break; }
    lowerY -= clamp(error / derivative, -0.1, 0.1);
  }
  if (!solved || Math.abs(solved.hub[0] - target) > 1e-5) {
    valid = false;
    solved = closure(lowerBase[0]);
    const delta = target - solved.hub[0];
    solved.lower[0] += delta; solved.upper[0] += delta; solved.hub[0] = target;
  }
  const { lower, upper, hub, rotation } = solved;
  const points = [], links = [];
  const point = (id, position, kind) => { points.push({ id, position, kind }); return id; };
  const link = (a, b, kind) => links.push({ a, b, kind });
  const lowerBall = point('lower-ball', [0, ...lower], 'upright');
  const upperBall = point('upper-ball', [0, ...upper], 'upright');
  const hubPoint = point('hub', [0, ...hub], 'upright');
  const lowerFront = point('lower-front', [-0.22, ...lowerPivot], 'chassis');
  const lowerRear = point('lower-rear', [0.22, ...lowerPivot], 'chassis');
  link(lowerFront, lowerBall, 'lower'); link(lowerRear, lowerBall, 'lower');
  link(lowerBall, hubPoint, 'link'); link(hubPoint, upperBall, 'link');
  let springTop, springBottom;
  if (config.structure === 'macpherson') {
    const top = point('strut-top', [0, ...mount], 'chassis');
    link(top, upperBall, 'strut');
    springTop = [0, ...mount]; springBottom = [0, ...upper];
  } else {
    const upperFront = point('upper-front', [-0.18, ...upperPivot], 'chassis');
    const upperRear = point('upper-rear', [0.18, ...upperPivot], 'chassis');
    if (config.structure === 'multilink') {
      link(upperFront, upperBall, 'link'); link(upperRear, upperBall, 'link');
      // Lower links have separate spatial attachments on the rigid upright.
      const rearSocket = point('rear-socket', [0.12, hub[0] - 0.06, hub[1] - 0.03], 'upright');
      links[1].b = rearSocket;
    } else {
      link(upperFront, upperBall, 'upper'); link(upperRear, upperBall, 'upper');
    }
    springTop = [0, r + 0.68, -0.80];
    springBottom = [0, lowerPivot[0] * 0.30 + lower[0] * 0.70 + 0.06, lowerPivot[1] * 0.30 + lower[1] * 0.70];
  }
  const tieInner = point('tie-inner', [-0.16, r + 0.09, -0.76], 'chassis');
  const steering = point('steering', [-0.14, hub[0] + 0.035, hub[1] - 0.035], 'upright');
  link(tieInner, steering, 'tie');
  const camber = (config.structure === 'macpherson' ? -Math.PI / 180 : uprightAngle) * 180 / Math.PI + rotation * 180 / Math.PI;
  const description = config.structure === 'multilink'
    ? '5-link illustration; camber uses equivalent front-view pivots, not full spatial constraint closure.'
    : config.structure === 'macpherson'
      ? 'Front-view lower-arm closure with a telescoping strut and rigid knuckle; zero toe assumption.'
      : 'Front-view double-wishbone circle closure with a rigid upright; zero toe assumption.';
  return { hub: [0, ...hub], points, links, springTop, springBottom, camber, toe: 0, valid, description };
}

/**
 * Small-signal spring travel / wheel travel about static trim. The ratio is
 * computed from the rendered linkage geometry, not a structure preset.
 */
export function getMotionRatio(input = DEFAULT_CONFIG) {
  const config = normalizeConfig(input);
  if (!config.autoMotionRatio) return config.motionRatio;
  const epsilon = 0.001;
  const springLength = geometry => Math.hypot(...geometry.springTop.map((coordinate, i) => coordinate - geometry.springBottom[i]));
  const rebound = getGeometry(config, -epsilon);
  const compression = getGeometry(config, epsilon);
  if (!rebound.valid || !compression.valid) return config.motionRatio;
  return clamp((springLength(rebound) - springLength(compression)) / (2 * epsilon), 0.2, 1.3);
}
