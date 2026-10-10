import { vertex, fragment } from './shaders.js';
import { getPalette } from './palettes.js';
export { palettes, getPalette } from './palettes.js';

export function normalizeOptions(options = {}) {
  const value = options.value ?? 0;
  if (!Number.isFinite(value)) throw new TypeError('value must be a finite number');
  const detail = options.detail ?? 0;
  if (detail !== 0 && detail !== 1) throw new RangeError('detail must be 0 or 1');
  const pixelRatio = options.pixelRatio ?? 1.25;
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0 || pixelRatio > 2) throw new RangeError('pixelRatio must be in (0, 2]');
  getPalette(options.palette);
  return {value: Math.min(100, Math.max(0, value)), palette: options.palette ?? 'ORIGINAL', detail,
    paused: Boolean(options.paused), pixelRatio};
}

/** Canvas renderer. Owns only the canvas; call destroy() on unmount. */
export function createFlowMist(canvas, options = {}) {
  let state = normalizeOptions(options);
  const gl = canvas.getContext('webgl', {alpha: true, premultipliedAlpha: false, antialias: false});
  if (!gl) throw new Error('FlowMist requires WebGL');
  const doc = canvas.ownerDocument, win = doc.defaultView;
  const motion = win.matchMedia('(prefers-reduced-motion: reduce)');
  let program, buffer, shaders = [], uniforms = {};
  let destroyed = false, lost = false, raf = 0, prev = null, lastDraw = -Infinity;
  let time = 7, shown = state.value / 100;
  function release() {
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    shaders.forEach(s => gl.deleteShader(s));
    buffer = program = null; shaders = [];
  }
  function init() {
    try {
      program = gl.createProgram();
      for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
        const shader = gl.createShader(type); shaders.push(shader);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Shader compilation failed');
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Shader linking failed');
      gl.useProgram(program);
      buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
      const a = gl.getAttribLocation(program, 'a'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
      for (const name of ['time','aspect','progress','detail','baseColor','accentColor','lightColor','shadeColor','accentCut','shadeStrength','lightStrength','transparentBackground']) uniforms[name] = gl.getUniformLocation(program, name);
    } catch (error) { release(); throw error; }
  }
  function draw() {
    if (destroyed || lost) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const scale = Math.min(win.devicePixelRatio || 1, state.pixelRatio);
    const w = Math.max(1, Math.round(rect.width * scale)), h = Math.max(1, Math.round(rect.height * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    gl.useProgram(program); gl.viewport(0, 0, w, h);
    const palette = getPalette(state.palette);
    gl.uniform1f(uniforms.transparentBackground, palette.transparent ? 1 : 0);
    ['baseColor','accentColor','lightColor','shadeColor'].forEach((name, i) => gl.uniform3fv(uniforms[name], [1,3,5].map(start => parseInt(palette.colors[i].slice(start, start+2), 16)/255)));
    for (const name of ['accentCut','shadeStrength','lightStrength']) gl.uniform1f(uniforms[name], palette[name]);
    for (const [name, value] of Object.entries({time, aspect: w/h, progress: shown, detail: state.detail})) gl.uniform1f(uniforms[name], value);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  function schedule() {
    if (!raf && !destroyed && !lost && !doc.hidden && !state.paused && !motion.matches) raf = win.requestAnimationFrame(frame);
  }
  function frame(now) {
    raf = 0;
    if (destroyed || lost || doc.hidden || state.paused || motion.matches) return;
    const dt = prev === null ? 0 : Math.min((now-prev)/1000, .05); prev = now;
    time += dt;
    shown += (state.value/100-shown)*(1-Math.exp(-dt*12));
    if (Math.abs(state.value/100-shown) < .00001) shown = state.value/100;
    if (now-lastDraw >= 40) { draw(); lastDraw = now; }
    schedule();
  }
  function wake() {
    win.cancelAnimationFrame(raf); raf = 0; prev = null;
    if (state.paused || motion.matches) shown = state.value/100;
    draw(); schedule();
  }
  function onLost(event) {
    event.preventDefault(); lost = true; win.cancelAnimationFrame(raf); raf = 0;
    options.onError?.(new Error('WebGL context lost; waiting for restoration'));
  }
  function onRestored() {
    if (destroyed) return;
    shaders = []; program = buffer = null;
    try { init(); lost = false; wake(); } catch(error) { options.onError?.(error); }
  }
  init();
  const observer = new win.ResizeObserver(draw); observer.observe(canvas);
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  doc.addEventListener('visibilitychange', wake);
  motion.addEventListener('change', wake);
  wake();
  return {
    update(next = {}) {
      if (destroyed) return;
      const wasPaused = state.paused;
      state = normalizeOptions({...state, ...next});
      if (state.paused !== wasPaused) { wake(); return; }
      // 普通更新保留动画时钟与待执行帧，避免连续更新让每帧 dt 都变成 0。
      if (state.paused || motion.matches) shown = state.value/100;
      draw(); schedule();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; win.cancelAnimationFrame(raf); observer.disconnect();
      doc.removeEventListener('visibilitychange', wake); motion.removeEventListener('change', wake);
      canvas.removeEventListener('webglcontextlost', onLost); canvas.removeEventListener('webglcontextrestored', onRestored);
      release();
    }
  };
}
