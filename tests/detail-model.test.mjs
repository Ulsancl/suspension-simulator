import test from 'node:test';
import assert from 'node:assert/strict';
import { SuspensionSimulation, getGeometry } from '../src/physics.js';
import { suspensionDetail } from '../src/detail-model.js';

const G = 9.80665;
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Number.isFinite(actual) && Number.isFinite(expected)
  && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}, tolerance ${tolerance}`);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const finiteTree = value => typeof value === 'number' ? Number.isFinite(value) : value === null || typeof value !== 'object' || Object.values(value).every(finiteTree);
// Evaluate the unchanged solver at exact constitutive boundaries. Integration
// and kinetic-energy derivative checks below separately use public advance().
const instant = (sim, { q = 0, bodyY = 0, bodyVelocity = 0, wheelVelocity = 0, time = 0 } = {}) =>
  sim._evaluate([bodyY, bodyVelocity, bodyY + q, wheelVelocity], time);
const kineticEnergy = (config, snapshot) => .5 * config.sprungMass * snapshot.bodyVelocity ** 2 + .5 * config.unsprungMass * snapshot.wheelVelocity ** 2;

test('both holder modes and all three spring/structure types retain static preload, zero rates and exact source snapshots', () => {
  for (const holderMode of ['fixed', 'sprung']) for (const springType of ['coil', 'progressive', 'air']) for (const structure of ['wishbone', 'multilink', 'macpherson']) {
    const sim = new SuspensionSimulation({ holderMode, springType, structure, road: 'flat' }), snapshot = freeze(sim.snapshot());
    const original = structuredClone({ config: sim.config, snapshot, history: sim.history, metrics: sim.metrics() });
    const d = suspensionDetail(freeze(sim.config), snapshot);
    near(d.forces.springN, sim.config.sprungMass * G);
    near(d.forces.wheel.contactN, (sim.config.sprungMass + sim.config.unsprungMass) * G);
    near(d.forces.transmittedHolderN, sim.config.sprungMass * G);
    near(d.forces.body.constraintN, 0); near(d.forces.body.netN, 0); near(d.forces.wheel.netN, 0);
    assert.equal(d.motion.axialTravelM, 0); assert.equal(d.motion.axialVelocityMps, 0);
    assert.equal(d.power.damperLossW, 0); assert.equal(d.power.stopLossW, 0); assert.equal(d.power.kineticRateW, 0);
    assert.equal(d.spring.source, springType); assert.equal(d.tire.branch, 'loaded'); assert.equal(d.tire.reportedContact, true);
    assert.deepEqual({ config: sim.config, snapshot, history: sim.history, metrics: sim.metrics() }, original);
  }
});

test('dynamic force and instantaneous mechanical power balances close across the 18 physical configurations', () => {
  for (const holderMode of ['fixed', 'sprung']) for (const springType of ['coil', 'progressive', 'air']) for (const structure of ['wishbone', 'multilink', 'macpherson']) {
    const sim = new SuspensionSimulation({ holderMode, springType, structure, singleEvent: true }), s = sim.advance(.42), d = suspensionDetail(sim.config, s);
    assert.ok(finiteTree(d));
    near(d.forces.body.netN, sim.config.sprungMass * s.bodyAcceleration);
    near(d.forces.wheel.netN, sim.config.unsprungMass * s.wheelAcceleration);
    near(d.forces.body.residualN, 0); near(d.forces.wheel.residualN, 0);
    near(d.forces.body.suspensionN, -d.forces.wheel.suspensionN);
    near(d.forces.suspensionN, s.springForce + s.damperForce + s.bumpStopForce);
    near(d.power.residualW, 0, 1e-7);
    assert.ok(d.power.damperLossW >= 0 && d.power.stopLossW >= 0);
    // Equal virtual work at the wheel and at the reduced axial coordinate.
    near(d.motion.springAxialForceN * d.motion.axialVelocityMps, s.springForce * (s.wheelVelocity - s.bodyVelocity));
    near(d.motion.damperAxialForceN * d.motion.axialVelocityMps, d.power.damperLossW);
    assert.equal(d.forces.transmittedHolderN, s.holderReaction);
  }
});

test('fixed-body external constraint differs from transmitted suspension load and changes sign', () => {
  const fixed = new SuspensionSimulation({ holderMode: 'fixed', road: 'flat', autoMotionRatio: false, motionRatio: .8 });
  const compressed = suspensionDetail(fixed.config, instant(fixed, { q: .04, wheelVelocity: .5 }));
  near(compressed.forces.transmittedHolderN, 4533.328); near(compressed.forces.body.constraintN, -1395.2);
  const rebound = suspensionDetail(fixed.config, instant(fixed, { q: -.12, wheelVelocity: -.5 }));
  near(rebound.forces.transmittedHolderN, -8435.472); near(rebound.forces.body.constraintN, 11573.6);
  for (const d of [compressed, rebound]) {
    near(d.forces.body.suspensionN + d.forces.body.gravityN + d.forces.body.constraintN, 0);
    assert.equal(d.power.constraintW, 0); assert.equal(d.power.bodyKineticRateW, 0);
  }
  const free = new SuspensionSimulation({ ...fixed.config, holderMode: 'sprung' });
  const d = suspensionDetail(free.config, instant(free, { q: .04, wheelVelocity: .5 }));
  assert.equal(d.forces.body.constraintN, 0); assert.ok(d.forces.body.inertialN > 0);
});

test('motion ratio preserves axial/wheel work while remaining distinct from nonlinear displayed spring-length change', () => {
  const sim = new SuspensionSimulation({ autoMotionRatio: false, motionRatio: .65, road: 'flat' });
  const s = instant(sim, { q: .012, wheelVelocity: -.4 }), d = suspensionDetail(sim.config, s);
  near(d.motion.axialTravelM, .0078); near(d.motion.axialVelocityMps, -.26);
  near(d.motion.staticWheelRateNpm, 32000 * .65 ** 2);
  near(d.motion.springAxialForceN, 320 * G / .65 + 32000 * .0078);
  near(d.motion.damperAxialForceN, 2800 * -.26);
  const geometric = new SuspensionSimulation({ structure: 'wishbone', road: 'flat' });
  const length = q => { const g = getGeometry(geometric.config, q); return Math.hypot(...g.springTop.map((value, index) => value - g.springBottom[index])); };
  const gd = suspensionDetail(geometric.config, instant(geometric, { q: .08 }));
  near(gd.motion.axialTravelM, geometric.state.effectiveMotionRatio * .08);
  assert.ok(Math.abs((length(0) - length(.08)) - gd.motion.axialTravelM) > .001);
});

test('reported kinetic-energy rates agree with independent centered differences of integrated mass energies', () => {
  for (const holderMode of ['fixed', 'sprung']) for (const springType of ['coil', 'progressive', 'air']) {
    const sim = new SuspensionSimulation({ holderMode, springType, road: 'flat', speed: 0, autoMotionRatio: false, motionRatio: .8 });
    const bodyY = holderMode === 'fixed' ? 0 : .001, bodyVelocity = holderMode === 'fixed' ? 0 : .023;
    Object.assign(sim.state, { bodyY, bodyVelocity, wheelY: bodyY + .003, wheelVelocity: .13 });
    const h = 1e-6, before = sim.snapshot(), middle = sim.advance(h), after = sim.advance(h);
    const d = suspensionDetail(sim.config, middle), finiteDifference = (kineticEnergy(sim.config, after) - kineticEnergy(sim.config, before)) / (2 * h);
    near(d.power.kineticRateW, finiteDifference, 2e-6);
    near(d.power.bodyKineticRateW + d.power.wheelKineticRateW, d.power.kineticRateW);
    near(d.power.gravityW + d.power.tireOnWheelW + d.power.springOnMassesW + d.power.damperOnMassesW + d.power.stopOnMassesW + d.power.constraintW, finiteDifference, 2e-6);
  }
});

test('bump and rebound stops dissipate only while penetrating further and recover elastic work on exit', () => {
  const sim = new SuspensionSimulation({ road: 'flat', autoMotionRatio: false, motionRatio: .8 });
  for (const side of [-1, 1]) for (const direction of [-1, 0, 1]) {
    const q = side > 0 ? sim.config.travelBump + .02 : -sim.config.travelRebound - .02, velocity = direction * .4;
    const d = suspensionDetail(sim.config, instant(sim, { q, wheelVelocity: velocity }));
    near(d.stop.elasticN, side * 7120); near(d.stop.bumpPenetrationM + d.stop.reboundPenetrationM, .02);
    assert.equal(d.stop.loading, side * direction > 0);
    near(d.stop.dampingN, side * direction > 0 ? 2200 * velocity : 0);
    near(d.power.stopLossW, side * direction > 0 ? 352 : 0);
    if (side * direction < 0) assert.ok(d.power.stopOnMassesW > 0, 'elastic stop returns work during release');
  }
  for (const q of [-sim.config.travelRebound, sim.config.travelBump]) {
    const d = suspensionDetail(sim.config, instant(sim, { q, wheelVelocity: Math.sign(q) }));
    assert.equal(d.stop.loading, false); near(d.forces.stopN, 0); near(d.power.stopLossW, 0);
  }
});

test('tire geometric separation, tensile-force clipping and a tiny positive load are separate branches', () => {
  const sim = new SuspensionSimulation({ road: 'flat', tireDamping: 2000 });
  const equilibriumCompression = (sim.config.sprungMass + sim.config.unsprungMass) * G / sim.config.tireRate;
  const detached = suspensionDetail(sim.config, instant(sim, { q: equilibriumCompression, wheelVelocity: -2 }));
  assert.equal(detached.tire.branch, 'detached'); assert.ok(detached.tire.rawForceN > 0); assert.equal(detached.tire.actualForceN, 0);
  const clamped = suspensionDetail(sim.config, instant(sim, { q: .005, wheelVelocity: 2 }));
  assert.equal(clamped.tire.branch, 'clamped'); assert.ok(clamped.tire.compressionM > 0); assert.ok(clamped.tire.rawForceN < 0);
  assert.equal(clamped.tire.actualForceN, 0); assert.equal(clamped.power.tireOnWheelW, 0);
  near(clamped.tire.dampingTrialN, -4000); near(clamped.tire.rawForceN, -1520.57275);
  const velocity = (sim.config.tireRate * equilibriumCompression - .0005) / sim.config.tireDamping;
  const tiny = suspensionDetail(sim.config, instant(sim, { wheelVelocity: velocity }));
  assert.equal(tiny.tire.branch, 'loaded'); near(tiny.tire.actualForceN, .0005); assert.equal(tiny.tire.reportedContact, false);
  const loaded = suspensionDetail(sim.config, instant(sim, { wheelVelocity: -.3 }));
  assert.equal(loaded.tire.branch, 'loaded'); assert.equal(loaded.tire.reportedContact, true);
  near(loaded.tire.actualForceN, loaded.tire.elasticTrialN + loaded.tire.dampingTrialN);
  assert.ok(loaded.power.tireOnWheelW < 0, 'positive ground force does negative work on a downward-moving wheel');
});

test('active air observations reconstruct the absolute-pressure law and separate preload trim from pressure-area force', () => {
  const sim = new SuspensionSimulation({ road: 'flat', springType: 'air', autoMotionRatio: false, motionRatio: .8 });
  for (const q of [-.025, 0, .025]) {
    const d = suspensionDetail(sim.config, instant(sim, { q })), a = d.air;
    assert.equal(d.spring.source, 'air'); assert.ok(a); assert.equal(a.volumeLimited, false);
    near(a.initialVolumeM3, .003); near(a.volumeM3, .003 - .008 * .8 * q);
    near(a.initialAbsolutePressurePa, 601325); near(a.absolutePressurePa * a.volumeM3 ** 1.3, 601325 * .003 ** 1.3);
    near(a.absolutePressurePa - a.gaugePressurePa, 101325);
    near(d.forces.springN, 320 * G + .8 * .008 * (a.absolutePressurePa - a.initialAbsolutePressurePa));
    assert.ok(Math.abs(d.motion.springAxialForceN - sim.config.airArea * a.gaugePressurePa) > 50);
  }
});

test('air volume protection has a visible threshold without fictional flow, and static wheel rate stays a static reference', () => {
  const sim = new SuspensionSimulation({ road: 'flat', springType: 'air', airVolume: .5, airArea: .015, airPressure: .5, autoMotionRatio: false, motionRatio: 1.3 });
  const onset = (.0005 * .85) / (.015 * 1.3);
  const before = suspensionDetail(sim.config, instant(sim, { q: onset * .99 }));
  const first = suspensionDetail(sim.config, instant(sim, { q: onset * 1.01 }));
  const later = suspensionDetail(sim.config, instant(sim, { q: onset * 1.5 }));
  assert.equal(before.air.volumeLimited, false); assert.equal(first.air.volumeLimited, true); assert.equal(later.air.volumeLimited, true);
  near(first.air.volumeM3, .000075); near(later.air.volumeM3, .000075);
  assert.ok(later.air.rawVolumeM3 < first.air.rawVolumeM3); near(first.air.absolutePressurePa, later.air.absolutePressurePa);
  near(first.forces.springN, later.forces.springN); near(first.motion.staticWheelRateNpm, later.motion.staticWheelRateNpm);
  const coil = new SuspensionSimulation({ road: 'flat', springType: 'progressive' });
  const zero = suspensionDetail(coil.config, instant(coil)), compressed = suspensionDetail(coil.config, instant(coil, { q: .08 }));
  assert.equal(compressed.motion.staticWheelRateNpm, zero.motion.staticWheelRateNpm); assert.equal(compressed.air, null);
});

test('measured profiles override only their own component, retain extrapolation provenance and remain passive', () => {
  const profile = { format: 'suspension-components/v1', units: 'SI', name: 'test independent segments', source: 'test fixture',
    spring: [[0, 0], [.05, 4000], [.06, 4100]], damper: [[-1, -200], [0, 0], [.3, 90], [1, 60]] };
  const sim = new SuspensionSimulation({ road: 'flat', springType: 'air', autoMotionRatio: false, motionRatio: .8, componentProfile: profile });
  const d = suspensionDetail(sim.config, instant(sim, { q: .1, wheelVelocity: 5 }));
  assert.equal(d.spring.source, 'curve'); assert.equal(d.damper.source, 'curve'); assert.equal(d.air, null);
  assert.equal(d.spring.curveOutOfRange, true); assert.equal(d.damper.curveOutOfRange, true);
  const staticCompression = (320 * G / .8) / 80000;
  near(d.motion.springAxialForceN, 4100 + 10000 * (staticCompression + .8 * .1 - .06));
  near(d.forces.damperN, 0); near(d.power.damperLossW, 0, 1e-12);
  const negative = suspensionDetail(sim.config, instant(sim, { wheelVelocity: -.5 }));
  near(negative.motion.damperAxialForceN, -80); near(negative.power.damperLossW, 32); assert.equal(negative.damper.branch, 'rebound');
  const damperOnly = new SuspensionSimulation({ road: 'flat', springType: 'air', componentProfile: { ...profile, spring: null } });
  const a = suspensionDetail(damperOnly.config, damperOnly.snapshot()); assert.equal(a.spring.source, 'air'); assert.ok(a.air); assert.equal(a.damper.source, 'curve');
  const springOnly = new SuspensionSimulation({ road: 'flat', autoMotionRatio: false, motionRatio: .8, componentProfile: { ...profile, damper: null } });
  assert.equal(suspensionDetail(springOnly.config, springOnly.snapshot()).damper.source, 'coefficient');
});

test('current details do not alter history, cumulative statistics, display speed or detached output objects', () => {
  const sim = new SuspensionSimulation({ holderMode: 'sprung', singleEvent: true }); sim.advance(.42);
  const snapshot = freeze(sim.snapshot()), history = freeze(structuredClone(sim.history)), metrics = freeze(sim.metrics());
  const before = structuredClone({ config: sim.config, snapshot, history, metrics });
  const first = suspensionDetail(freeze(sim.config), snapshot), faster = suspensionDetail({ ...sim.config, timeScale: 3 }, snapshot);
  assert.deepEqual(first, faster);
  first.forces.body.constraintN = 999; first.motion.axialTravelM = 999;
  assert.notEqual(suspensionDetail(sim.config, snapshot).motion.axialTravelM, 999);
  assert.deepEqual({ config: sim.config, snapshot, history, metrics }, before);
  assert.deepEqual(sim.history, history); assert.deepEqual(sim.metrics(), metrics);
});

test('invalid observations are rejected without normalization, source mutation or nonfinite detail output', () => {
  const sim = new SuspensionSimulation({ road: 'flat' }), c = freeze(sim.config), s = freeze(sim.snapshot()), before = structuredClone({ c, s });
  for (const invalid of [null, {}, { ...c, sprungMass: 0 }, { ...c, motionRatio: 2 }, { ...c, timeScale: '1' }, { ...c, unknown: true }]) assert.throws(() => suspensionDetail(invalid, s));
  for (const invalid of [null, {}, { ...s, wheelVelocity: NaN }, { ...s, effectiveMotionRatio: 0 }, { ...s, bodyY: 1 },
    { ...s, travel: 1 }, { ...s, contact: 1 }, { ...s, contactForce: -1 }, { ...s, time: -1 }]) assert.throws(() => suspensionDetail(c, invalid));
  assert.deepEqual({ c, s }, before); assert.ok(finiteTree(suspensionDetail(c, s)));
});
