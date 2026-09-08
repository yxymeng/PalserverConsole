import { createElement, useEffect, useRef, useState } from 'react';
import { createFlowMist, normalizeOptions } from './index.js';

export function FlowMist({value = 0, palette = 'ORIGINAL', detail = 0, paused = false,
  pixelRatio = 1.25, label = '进度', className = '', style, onError, ...props}) {
  const canvas = useRef(null), renderer = useRef(null), errorHandler = useRef(onError);
  errorHandler.current = onError;
  const [failed, setFailed] = useState(false);
  const initial = useRef({value, palette, detail, paused, pixelRatio});
  const safe = normalizeOptions({value, palette, detail, paused, pixelRatio});
  useEffect(() => {
    setFailed(false);
    try { renderer.current = createFlowMist(canvas.current, {...initial.current, onError: e => errorHandler.current?.(e)}); }
    catch (error) { setFailed(true); errorHandler.current?.(error); }
    return () => { renderer.current?.destroy(); renderer.current = null; };
  }, []);
  useEffect(() => { renderer.current?.update({value, palette, detail, paused, pixelRatio}); }, [value, palette, detail, paused, pixelRatio]);
  return createElement('div', {...props, className: `flowmist ${className}`, style,
    role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': safe.value},
    createElement('canvas', {ref: canvas, 'aria-hidden': true, style: failed ? {display: 'none'} : undefined}),
    failed && createElement('div', {className: 'flowmist-fallback', style: {width: `${safe.value}%`}}),
    createElement('span', {className: 'flowmist-label'}, label),
    createElement('span', {className: 'flowmist-value'}, `${Math.round(safe.value)}%`));
}
