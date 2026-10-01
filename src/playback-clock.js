const CLOCK_STEP=1/120;
const clocks=new WeakMap();
export function advancePlayback(simulation, seconds, afterStep = () => true) {
  if (!Number.isFinite(seconds) || seconds <= 0) return { advanced: 0, stalled: false };
  if (seconds > 1) return { advanced: 0, stalled: true };
  let clock=clocks.get(simulation);
  if(!clock||clock.config!==simulation.config||Math.abs(clock.modelTime-simulation.state.time)>1e-10)clock={pending:0,config:simulation.config,modelTime:simulation.state.time};
  clock.pending+=seconds;clocks.set(simulation,clock);
  let advanced = 0;
  while(clock.pending>=CLOCK_STEP-1e-12){
    simulation.advance(CLOCK_STEP*simulation.config.timeScale);advanced+=CLOCK_STEP;
    clock.pending=Math.max(0,clock.pending-CLOCK_STEP);clock.modelTime=simulation.state.time;
    if(afterStep()===false){clock.pending=0;break;}
  }
  return { advanced, stalled: false };
}
