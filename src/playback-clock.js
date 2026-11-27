const CLOCK_STEP=1/120;
const MAX_FRAME_STEPS = 8000;
const clocks=new WeakMap();
export function advancePlayback(simulation, seconds, afterStep = () => true) {
  if (!Number.isFinite(seconds) || seconds <= 0) return { advanced: 0, stalled: false };
  if (seconds > 1) return { advanced: 0, stalled: true };
  let clock=clocks.get(simulation);
  if(!clock||clock.config!==simulation.config||Math.abs(clock.modelTime-simulation.state.time)>1e-10)clock={pending:0,config:simulation.config,modelTime:simulation.state.time};
  clock.pending+=seconds;clocks.set(simulation,clock);
  let advanced = 0, remainingSteps = MAX_FRAME_STEPS;
  const modelStep = CLOCK_STEP * simulation.config.timeScale;
  const stepsPerTick = Math.ceil(modelStep / simulation.integrationLimit());
  while (clock.pending >= CLOCK_STEP - 1e-12) {
    if (stepsPerTick > remainingSteps) {
      clock.pending = 0;
      return { advanced, stalled: true };
    }
    remainingSteps -= stepsPerTick;
    simulation.advance(modelStep);
    advanced += CLOCK_STEP;
    clock.pending=Math.max(0,clock.pending-CLOCK_STEP);clock.modelTime=simulation.state.time;
    if(afterStep()===false){clock.pending=0;break;}
  }
  return { advanced, stalled: false };
}
