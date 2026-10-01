import test from 'node:test';
import assert from 'node:assert/strict';
import {ExperimentLibrary,runExperiment} from '../src/experiments.js';
test('batch save validates every trial and capacity before changing the retained library',async()=>{
 const lib=new ExperimentLibrary({storage:null,maxRuns:2});await lib.ready();const a=runExperiment({}, {duration:1,name:'A'}),b=runExperiment({}, {duration:1,name:'B'}),c=runExperiment({}, {duration:1,name:'C'});
 await assert.rejects(()=>lib.saveBatch([a,{...b,history:[]} ]));assert.equal(lib.list().length,0);
 assert.equal((await lib.saveBatch([a,b])).ok,true);assert.equal(lib.list().length,2);
 assert.equal((await lib.saveBatch([c])).reason,'capacity');assert.deepEqual(lib.list().map(run=>run.id),[a.id,b.id]);
 await assert.rejects(()=>lib.saveBatch([a,a]));assert.equal(lib.list().length,2);
});
