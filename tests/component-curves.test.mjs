import assert from 'node:assert/strict';
import test from 'node:test';
import {COMPONENT_PROFILE_TEMPLATE,validateComponentProfile,createCurveModel,interpolateCurve} from '../src/component-curves.js';
import {SuspensionSimulation,DEFAULT_CONFIG} from '../src/physics.js';
const near=(a,b,tolerance=1e-8)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} vs ${b}`);
const profile=()=>structuredClone(COMPONENT_PROFILE_TEMPLATE);
test('component schema requires explicit SI and strictly sorted numeric points',()=>{
  for(const value of [{format:'wrong',units:'SI'}, {...profile(),units:'mm'}, {...profile(),spring:[[0,0],[0,1]]}, {...profile(),spring:[[0,0],[.1,'3200']]}, {...profile(),damper:[[-1,2],[0,0],[1,2]]}, {...profile(),damper:[[0,0],[1,1]]}])assert.throws(()=>validateComponentProfile(value));
});
test('validated measured data is detached immutable and excludes unknown fields',()=>{
  const input=profile();input.unsafe='<script>';const result=validateComponentProfile(input);input.spring[1][1]=99;
  assert.equal(result.spring[1][1],3200);assert.ok(Object.isFrozen(result.spring[1]));assert.equal(result.unsafe,undefined);assert.equal(validateComponentProfile(result),result);
});
test('piecewise lookup uses exact interpolation and explicitly flags endpoint extrapolation',()=>{
  const points=[[0,0],[1,2],[2,6]];near(interpolateCurve(points,.5).value,1);near(interpolateCurve(points,1.5).value,4);near(interpolateCurve(points,3).value,10);assert.equal(interpolateCurve(points,3).outOfRange,true);
});
test('measured spring finds static compression from load and preserves gravity equilibrium',()=>{
  const model=createCurveModel(profile(),{sprungMass:320,motionRatio:.85});near(model.staticCompression,320*9.80665/.85/32000);near(model.evaluateSpring(0).force,320*9.80665);near(model.tangentRate,32000);
  const sim=new SuspensionSimulation({...DEFAULT_CONFIG,road:'flat',componentProfile:profile()});sim.advance(3);near(sim.state.wheelY,0);near(sim.state.bodyY,0);
});
test('equivalent measured linear spring and asymmetric damper reproduce coefficient dynamics',()=>{
  const config={...DEFAULT_CONFIG,holderMode:'sprung',autoMotionRatio:false,motionRatio:.85},baseline=new SuspensionSimulation(config),measured=new SuspensionSimulation({...config,componentProfile:profile()});baseline.advance(4);measured.advance(4);
  for(const key of ['wheelY','bodyY','contactForce','springForce','damperForce'])near(baseline.state[key],measured.state[key],1e-6);
  near(baseline.metrics().rmsBodyAcceleration,measured.metrics().rmsBodyAcceleration,1e-6);
});
test('measured damper applies axial velocity and force through motion ratio and remains passive',()=>{
  const model=createCurveModel(profile(),{sprungMass:320,motionRatio:.5});near(model.evaluateDamper(2).force,900);near(model.evaluateDamper(-2).force,-1400);
  for(const v of [-10,-2,-.05,0,.05,2,10])assert.ok(model.evaluateDamper(v).force*v>=0);
});
test('nonlinear measured spring changes wheel tangent and actual transient response',()=>{
  const measured=profile();measured.spring=[[0,0],[.1,2000],[.2,6000],[.3,12000],[.4,20000]];
  const linear=new SuspensionSimulation(DEFAULT_CONFIG),nonlinear=new SuspensionSimulation({...DEFAULT_CONFIG,componentProfile:measured});linear.advance(2);nonlinear.advance(2);
  assert.notEqual(linear.state.effectiveWheelRate,nonlinear.state.effectiveWheelRate);assert.ok(Math.abs(linear.metrics().peakTravel-nonlinear.metrics().peakTravel)>.001);
});
test('out-of-coverage flags and full-run duration statistics identify extrapolated force data',()=>{
  const measured=profile();measured.damper=[[-.01,-28],[0,0],[.01,18]];
  const sim=new SuspensionSimulation({...DEFAULT_CONFIG,componentProfile:measured});sim.advance(3);assert.ok(sim.metrics().curveExtrapolationPct>0);assert.ok(sim.history.some(row=>row.damperCurveOutOfRange));
});
test('static load outside a measured spring curve is rejected and excessive slope data is rejected',()=>{
  const input=profile();input.spring=[[0,0],[.01,100]];assert.throws(()=>new SuspensionSimulation({...DEFAULT_CONFIG,componentProfile:input}),/정적 축하중/);
  assert.throws(()=>validateComponentProfile({...profile(),spring:[[0,0],[.000001,1000]]}),/기울기/);
});
test('steep admitted measured curves use a stable integration interval under low wheel mass',()=>{
  const input=profile();input.spring=[[0,0],[.01,80000],[.02,160000]];input.damper=[[-1,-150000],[0,0],[1,150000]];
  const sim=new SuspensionSimulation({...DEFAULT_CONFIG,componentProfile:input,unsprungMass:15,autoMotionRatio:false,motionRatio:1.3,roadHeight:.12});sim.advance(.8);
  assert.ok(Object.values(sim.state).filter(v=>typeof v==='number').every(Number.isFinite));assert.ok(Number.isFinite(sim.metrics().rmsWheelAcceleration));
});
