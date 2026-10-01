import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, roadHeight, getGeometry, getMotionRatio, SuspensionSimulation } from '../src/physics.js';

const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected} ± ${tolerance}`);
const G = 9.80665;

test('flat-road static preload balances gravity for every spring and holder mode', () => {
  for (const springType of ['coil', 'progressive', 'air']) {
    for (const holderMode of ['fixed', 'sprung']) {
      const sim = new SuspensionSimulation({ road: 'flat', springType, holderMode });
      sim.advance(1);
      near(sim.state.wheelY, 0, 1e-10);
      near(sim.state.bodyY, 0, 1e-10);
      near(sim.state.springForce, DEFAULT_CONFIG.sprungMass * G, 1e-6);
      near(sim.state.contactForce, (DEFAULT_CONFIG.sprungMass + DEFAULT_CONFIG.unsprungMass) * G, 1e-6);
    }
  }
});

test('fixed holder stays fixed while the wheel responds; sprung mode moves both masses', () => {
  const fixed = new SuspensionSimulation({ singleEvent: true });
  fixed.advance(1.6);
  assert.equal(fixed.state.bodyY, 0);
  assert.equal(fixed.state.bodyVelocity, 0);
  assert.equal(fixed.metrics().peakBodyAcceleration, 0);
  assert.ok(fixed.metrics().peakWheelAcceleration > 1);
  assert.ok(fixed.metrics().peakTravel > 0.01);
  const sprung = new SuspensionSimulation({ holderMode: 'sprung', singleEvent: true });
  sprung.advance(1.6);
  assert.ok(sprung.metrics().peakBodyAcceleration > 0.1);
  assert.ok(sprung.history.some(s => Math.abs(s.bodyY) > 0.001));
});

test('sharp step uses a circular approach envelope before wheel centre reaches the edge', () => {
  const cfg = normalizeConfig({ road: 'step', roadHeight: 0.08, roadWidth: 1, singleEvent: true });
  const edge = cfg.roadSpacing * 0.55 - cfg.roadWidth / 2;
  const distance = edge - 0.10;
  const sim = new SuspensionSimulation(cfg);
  sim.advance(distance / (cfg.speed / 3.6));
  assert.equal(roadHeight(distance, cfg), 0);
  const expected = cfg.roadHeight + Math.sqrt(cfg.tireRadius ** 2 - 0.10 ** 2) - cfg.tireRadius;
  near(sim.state.roadY, expected, 1e-6);
  assert.ok(sim.state.roadY > 0.06);
});

test('a narrow pothole is bridged by tyre radius rather than dropping to its full depth', () => {
  const cfg = normalizeConfig({ road: 'pothole', roadWidth: 0.10, roadHeight: 0.15 });
  const center = cfg.roadSpacing * 0.55;
  const sim = new SuspensionSimulation(cfg);
  sim.advance(center / (cfg.speed / 3.6));
  near(roadHeight(center, cfg), -0.15);
  const expected = Math.sqrt(cfg.tireRadius ** 2 - (cfg.roadWidth / 2) ** 2) - cfg.tireRadius;
  near(sim.state.roadY, expected, 1e-6);
  assert.ok(sim.state.roadY > -0.005);
});

test('tyre contact is unilateral and reports contact loss after a severe obstacle', () => {
  const sim = new SuspensionSimulation({ road: 'step', roadHeight: 0.18, speed: 100, holderMode: 'sprung', compressionDamping: 250, reboundDamping: 350, singleEvent: true });
  sim.advance(1.5);
  assert.ok(sim.metrics().contactLossPct > 0);
  assert.ok(sim.history.every(s => s.contactForce >= 0));
  assert.ok(sim.history.some(s => !s.contact && s.contactForce === 0));
  const detached = new SuspensionSimulation({ road: 'flat' });
  detached.state.wheelY = 0.15;
  detached.state.wheelVelocity = -2;
  detached.step(1e-8);
  assert.equal(detached.state.contactForce, 0, 'damper may not pull a detached tyre toward the road');
});

test('air spring follows absolute-pressure polytropic law and pressure changes tangent stiffness', () => {
  const forceAt = (patch, travel) => {
    const sim = new SuspensionSimulation({ road: 'flat', springType: 'air', autoMotionRatio: false, ...patch });
    sim.state.wheelY = travel;
    sim.step(1e-9);
    return { force: sim.state.springForce, config: sim.config };
  };
  const low = forceAt({ airPressure: 3 }, 0.01);
  const high = forceAt({ airPressure: 8 }, 0.01);
  assert.ok(high.force > low.force);
  const c = low.config;
  const volume = c.airVolume / 1000;
  const pressure = c.airPressure * 100000 + 101325;
  const expected = c.sprungMass * G + c.motionRatio * c.airArea * pressure * ((volume / (volume - c.airArea * c.motionRatio * 0.01)) ** c.airExponent - 1);
  near(low.force, expected, 1e-5);
  assert.ok(forceAt({ airVolume: 1 }, 0.01).force > forceAt({ airVolume: 6 }, 0.01).force);
});

test('coil wheel rate and damping use squared motion ratio, with distinct damper branches', () => {
  for (const velocity of [0.4, -0.4]) {
    const sim = new SuspensionSimulation({ road: 'flat', motionRatio: 0.65, autoMotionRatio: false });
    sim.state.wheelY = 0.012;
    sim.state.wheelVelocity = velocity;
    sim.step(1e-9);
    near(sim.state.springForce, sim.config.sprungMass * G + sim.config.springRate * 0.65 ** 2 * 0.012, 1e-4);
    const c = velocity > 0 ? sim.config.compressionDamping : sim.config.reboundDamping;
    near(sim.state.damperForce, c * 0.65 ** 2 * velocity, 1e-4);
    assert.ok(sim.state.damperForce * velocity > 0);
  }
});

test('damping dissipates oscillation energy after an initial wheel displacement', () => {
  const energy = sim => 0.5 * sim.config.unsprungMass * sim.state.wheelVelocity ** 2 + 0.5 * (sim.config.tireRate + sim.config.springRate * sim.config.motionRatio ** 2) * sim.state.wheelY ** 2;
  const undamped = new SuspensionSimulation({ road: 'flat', speed: 0, compressionDamping: 0, reboundDamping: 0, tireDamping: 0, autoMotionRatio: false });
  const damped = new SuspensionSimulation({ road: 'flat', speed: 0, compressionDamping: 1800, reboundDamping: 1800, tireDamping: 0, autoMotionRatio: false });
  undamped.state.wheelY = 0.005;
  damped.state.wheelY = 0.005;
  const initial = energy(undamped);
  undamped.advance(1);
  damped.advance(1);
  near(energy(undamped), initial, initial * 0.0001);
  assert.ok(energy(damped) < initial * 0.001);
});

test('front-view wishbone preserves arm and upright lengths and meets requested hub height', () => {
  const distances = geometry => {
    const points = new Map(geometry.points.map(p => [p.id, p.position]));
    return geometry.links.filter(l => l.kind === 'upper' || l.kind === 'lower').map(l => {
      const a = points.get(l.a), b = points.get(l.b);
      return Math.hypot(...a.map((n, i) => n - b[i]));
    });
  };
  const base = getGeometry({ structure: 'wishbone' });
  for (const travel of [-0.1, 0, 0.11]) {
    const geometry = getGeometry({ structure: 'wishbone' }, travel);
    assert.equal(geometry.valid, true);
    near(geometry.hub[1], DEFAULT_CONFIG.tireRadius + travel, 1e-7);
    distances(geometry).forEach((length, i) => near(length, distances(base)[i], 1e-7));
  }
  assert.ok(getGeometry({ structure: 'wishbone' }, 0.1).camber < base.camber);
  for (const structure of ['multilink', 'macpherson']) {
    const geometry = getGeometry({ structure }, 0.08);
    assert.equal(geometry.valid, true);
    assert.ok(geometry.points.every(p => p.position.every(Number.isFinite)));
    assert.ok(geometry.springTop[2] < -0.2);
    near(geometry.hub[1], DEFAULT_CONFIG.tireRadius + 0.08, 1e-7);
  }
});

test('single event isolates the first obstacle and structure changes do not invent force multipliers', () => {
  const cfg = normalizeConfig({ road: 'step', singleEvent: true });
  near(roadHeight(cfg.roadSpacing * 0.55, cfg), cfg.roadHeight);
  near(roadHeight(cfg.roadSpacing * 1.55, cfg), 0);
  const states = ['wishbone', 'multilink', 'macpherson'].map(structure => new SuspensionSimulation({ structure, autoMotionRatio: false }).advance(0.7));
  states.slice(1).forEach(s => near(s.wheelY, states[0].wheelY, 1e-10));
});

test('automatic motion ratio derives from spring-length geometry and couples structures to wheel rate', () => {
  const length = geometry => Math.hypot(...geometry.springTop.map((p, i) => p - geometry.springBottom[i]));
  for (const structure of ['wishbone', 'multilink', 'macpherson']) {
    const derivative = (length(getGeometry({ structure }, -0.001)) - length(getGeometry({ structure }, 0.001))) / 0.002;
    near(getMotionRatio({ structure }), derivative, 1e-10);
    const sim = new SuspensionSimulation({ structure });
    near(sim.state.effectiveMotionRatio, derivative, 1e-10);
    near(sim.state.effectiveWheelRate, sim.config.springRate * derivative ** 2, 1e-6);
    assert.equal(sim.config.motionRatio, DEFAULT_CONFIG.motionRatio, 'manual setting remains available without replacing the geometric ratio');
  }
  const wishbone = new SuspensionSimulation({ structure: 'wishbone' });
  const strut = new SuspensionSimulation({ structure: 'macpherson' });
  assert.ok(Math.abs(wishbone.state.effectiveMotionRatio - strut.state.effectiveMotionRatio) > 0.1);
  wishbone.advance(0.7);
  strut.advance(0.7);
  assert.ok(Math.abs(wishbone.state.wheelY - strut.state.wheelY) > 1e-5);
  near(getMotionRatio({ autoMotionRatio: false, motionRatio: 0.72 }), 0.72, 1e-12);
});

test('long runs and extreme controls remain finite, with bounded recorded history', () => {
  const sim = new SuspensionSimulation({ holderMode: 'sprung', road: 'mixed', speed: 120, roadHeight: 0.20 });
  sim.advance(32);
  assert.ok(sim.history.length <= 3600);
  assert.ok(sim.history.every(s => Object.values(s).every(v => typeof v !== 'number' || Number.isFinite(v))));
  assert.ok(Math.abs(sim.state.bodyY) < 3);
  for (const springType of ['coil', 'progressive', 'air']) {
    const extreme = new SuspensionSimulation({ springType, road: 'washboard', speed: 160, roadHeight: 0.25, roadWidth: 0.08, unsprungMass: 15, sprungMass: 1200, springRate: 160000, tireRate: 800000, compressionDamping: 16000, reboundDamping: 20000, motionRatio: 1.3, airPressure: 16, airVolume: 0.5 });
    extreme.advance(1.5);
    assert.ok(Object.values(extreme.state).every(v => typeof v !== 'number' || Number.isFinite(v)), springType);
    assert.ok(Math.abs(extreme.state.wheelY) < 3, springType);
  }
});

test('snapshots are isolated, configuration resets experiments, CSV preserves recorded samples', () => {
  const sim = new SuspensionSimulation();
  sim.advance(0.1);
  const copy = sim.snapshot();
  copy.wheelY = 100;
  assert.notEqual(sim.state.wheelY, 100);
  const csv = sim.exportCSV().trim().split('\n');
  assert.ok(csv[0].includes('bodyAcceleration'));
  assert.equal(csv[0].split(',').length, csv[1].split(',').length);
  assert.ok(csv.length >= 13);
  sim.configure({ holderMode: 'sprung' });
  assert.equal(sim.state.time, 0);
  assert.equal(sim.history.length, 1);
  assert.equal(sim.config.holderMode, 'sprung');
  const normalized = normalizeConfig({ sprungMass: NaN, springRate: -2, road: 'invalid' });
  assert.equal(normalized.sprungMass, DEFAULT_CONFIG.sprungMass);
  assert.equal(normalized.springRate, 4000);
  assert.equal(normalized.road, DEFAULT_CONFIG.road);
});
