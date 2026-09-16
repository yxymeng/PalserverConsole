import test from 'node:test';
import assert from 'node:assert/strict';
import {createFlowMist,normalizeOptions,palettes,getPalette} from '../src/index.js';
function fixture() {
  const frames=new Map(), values={}, calls={draw:0,delete:0};let id=0;
  const gl=new Proxy({}, {get:(_,key)=>{
    if(key==='getShaderParameter'||key==='getProgramParameter')return()=>true;
    if(key==='getUniformLocation')return(_,name)=>name;
    if(key==='uniform1f')return(name,value)=>values[name]=value;
    if(key==='drawArrays')return()=>calls.draw++;
    if(String(key).startsWith('delete'))return()=>calls.delete++;
    if(String(key).startsWith('create'))return()=>({});
    return ()=>{};
  }});
  const motion=Object.assign(new EventTarget(),{matches:false});
  const win={matchMedia:()=>motion,devicePixelRatio:2,
    requestAnimationFrame:fn=>{frames.set(++id,fn);return id},cancelAnimationFrame:id=>frames.delete(id),
    ResizeObserver:class{observe(){}disconnect(){calls.disconnect=true}}};
  const doc=Object.assign(new EventTarget(),{defaultView:win,hidden:false});
  const canvas=Object.assign(new EventTarget(),{ownerDocument:doc,getContext:()=>gl,getBoundingClientRect:()=>({width:500,height:100})});
  return{canvas,frames,values,calls,motion,doc};
}
test('public values, palette stability and validation',()=>{
  assert.equal(normalizeOptions({value:-10}).value,0);assert.equal(normalizeOptions({value:120}).value,100);
  assert.throws(()=>normalizeOptions({value:NaN}),TypeError);assert.throws(()=>normalizeOptions({palette:'MISSING'}),RangeError);
  assert.equal(palettes.filter(p=>!p.code.startsWith('PAL_')).length,10);
  assert.equal(palettes.filter(p=>p.code.startsWith('PAL_') && p.transparent).length,4);
  assert.equal(getPalette('OCEAN').name,'蓝汐');assert.ok(Object.isFrozen(palettes[0].colors));
});
test('project palettes enable transparency without changing upstream rendering',()=>{
  const f=fixture(), r=createFlowMist(f.canvas,{palette:'PAL_TIDE'});
  assert.equal(f.values.transparentBackground,1);
  r.update({palette:'OCEAN'});assert.equal(f.values.transparentBackground,0);
  r.destroy();
});
test('pause, endpoints, motion preference, teardown and remount',()=>{
  const f=fixture(), r=createFlowMist(f.canvas,{value:62});
  assert.equal(f.values.progress,.62);assert.equal(f.frames.size,1);
  r.update({paused:true,value:100});assert.equal(f.values.progress,1);assert.equal(f.frames.size,0);
  r.update({value:0});assert.equal(f.values.progress,0);
  f.motion.matches=true;r.update({paused:false,value:40});assert.equal(f.values.progress,.4);assert.equal(f.frames.size,0);
  f.motion.matches=false;f.motion.dispatchEvent(new Event('change'));assert.equal(f.frames.size,1);
  r.destroy();r.destroy();assert.equal(f.frames.size,0);assert.equal(f.calls.delete,4);assert.ok(f.calls.disconnect);
  const count=f.calls.draw;r.update({value:20});assert.equal(f.calls.draw,count);
  createFlowMist(f.canvas,{paused:true}).destroy();
});
test('context restoration restarts rendering; hidden pages stop scheduling',()=>{
  const f=fixture(), r=createFlowMist(f.canvas);
  f.canvas.dispatchEvent(new Event('webglcontextlost',{cancelable:true}));assert.equal(f.frames.size,0);
  f.canvas.dispatchEvent(new Event('webglcontextrestored'));assert.equal(f.frames.size,1);
  f.doc.hidden=true;f.doc.dispatchEvent(new Event('visibilitychange'));assert.equal(f.frames.size,0);
  f.doc.hidden=false;f.doc.dispatchEvent(new Event('visibilitychange'));assert.equal(f.frames.size,1);
  r.destroy();
});
test('unsupported WebGL throws explicitly',()=>assert.throws(()=>createFlowMist({getContext:()=>null}),/WebGL/));

test('continuous updates preserve animation time and visible progress',()=>{
  const f=fixture(), r=createFlowMist(f.canvas,{value:0});
  function tick(now) {
    const pending=[...f.frames.values()];f.frames.clear();
    pending.forEach(frame=>frame(now));
  }
  for(let i=0;i<120;i++) {
    const pending=[...f.frames.keys()];
    r.update({value:(i+1)*100/120});
    assert.deepEqual([...f.frames.keys()],pending,'updates must keep the scheduled frame');
    tick(i*1000/60);
  }
  assert.ok(f.values.time>8,'cloud animation must continue');
  assert.ok(f.values.progress>.9,'visible progress must follow frequent updates');
  for(let i=120;i<240;i++)tick(i*1000/60);
  assert.equal(f.values.progress,1);
  r.destroy();assert.equal(f.frames.size,0);
});
