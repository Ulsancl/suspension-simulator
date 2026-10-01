import test from 'node:test';
import assert from 'node:assert/strict';
import { SuspensionSimulation } from '../src/physics.js';
import { advancePlayback } from '../src/playback-clock.js';

test('actual suspension playback keeps configured time scale at 60 and 3 FPS',()=>{
  const states=[];
  for(const fps of [60,3]){
    const sim=new SuspensionSimulation({holderMode:'sprung',road:'bump',speed:30,timeScale:.5});
    for(let i=0;i<fps*5;i++)advancePlayback(sim,1/fps);
    states.push(sim.snapshot());
  }
  for(const state of states)assert.ok(Math.abs(state.time-2.5)<1e-9);
  for(const key of ['bodyY','bodyVelocity','wheelY','wheelVelocity','travel'])assert.ok(Math.abs(states[0][key]-states[1][key])<1e-5,key);
});
test('a long rendering stall does not silently change experiment time or configuration',()=>{
  const sim=new SuspensionSimulation({road:'mixed',timeScale:3});const before=sim.snapshot(),config={...sim.config};
  assert.equal(advancePlayback(sim,1.01).stalled,true);
  assert.deepEqual(sim.snapshot(),before);assert.deepEqual(sim.config,config);
  for(const dt of [NaN,Infinity,-1,0])assert.equal(advancePlayback(sim,dt).advanced,0);
  assert.deepEqual(sim.snapshot(),before);
});
test('single event playback stops within the frame instead of advancing its remaining time',()=>{
  const sim=new SuspensionSimulation({road:'bump',singleEvent:true,speed:30,timeScale:3});
  const result=advancePlayback(sim,1,()=>sim.state.time<.3-1e-10);
  assert.ok(Math.abs(sim.state.time-.3)<1e-9);assert.ok(Math.abs(result.advanced-.1)<1e-9);
});
