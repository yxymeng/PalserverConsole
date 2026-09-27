import { animate } from "motion";
import { useLayoutEffect, useRef } from "react";

import { rubberBand, sheetTarget } from "./sheet-physics";

// Each mounted mobile sheet owns a lock, including sheets nested above another sheet.
let locks = 0;
let previousOverflow = "";

export function MobileSheetHandle({ onDismiss }: { onDismiss: () => void }) {
  const handleRef = useRef<HTMLButtonElement>(null);
  const dismissRef = useRef(onDismiss);
  useLayoutEffect(() => { dismissRef.current = onDismiss; }, [onDismiss]);

  useLayoutEffect(() => {
    const handle = handleRef.current;
    const panel = handle?.parentElement;
    if (!handle || !panel) return;
    const media = matchMedia("(max-width: 760px)");
    let dispose = () => {};
    const setup = () => {
      dispose();
      dispose = () => {};
      handle.disabled = !media.matches;
      if (!media.matches) return;
      const naturalHeight = panel.scrollHeight + 44;
      // React owns className and may replace it when navigating between entity types.
      panel.dataset.sheetMobile = "true";
      if (locks++ === 0) {
        previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
      }
      let expanded = 0;
      let compact = 0;
      let height = 0;
      let anchor: "compact" | "expanded" = "compact";
      let animation: ReturnType<typeof animate> | undefined;
      let openingFrame = 0;
      let dismissFrame = 0;
      let drag: { id: number; y: number; height: number; samples: { y: number; time: number }[] } | null = null;
      const write = (value: number) => {
        height = value;
        panel.style.setProperty("--sheet-transform", `translate3d(0, ${expanded - value}px, 0)`);
      };
      const commit = (value: number) => {
        height = value;
        panel.style.setProperty("--sheet-height", `${value}px`);
        panel.style.removeProperty("--sheet-transform");
        panel.style.removeProperty("--sheet-tail");
        delete panel.dataset.sheetMoving;
      };
      const prepare = (target: number) => {
        // Keep content layout stable while the surface follows the finger or spring.
        panel.style.setProperty("--sheet-height", `${expanded}px`);
        panel.style.setProperty("--sheet-tail", `${Math.max(0, expanded - target)}px`);
        panel.dataset.sheetMoving = "true";
        write(height);
      };
      const finishDismiss = () => {
        dismissRef.current();
        dismissFrame = requestAnimationFrame(() => {
          // Returning to a previous detail or rejecting a close leaves the panel mounted.
          if (panel.isConnected && !panel.hasAttribute("data-closed")) {
            settle(anchor === "expanded" ? expanded : compact);
          }
        });
      };
      const settle = (target: number, velocity = 0) => {
        animation?.stop();
        cancelAnimationFrame(openingFrame);
        cancelAnimationFrame(dismissFrame);
        velocity = Math.max(-2400, Math.min(2400, velocity));
        if (target === 0) {
          panel.dataset.sheetClosing = "true";
          if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
            commit(0);
            finishDismiss();
            return;
          }
          prepare(height);
          animation = animate(height, 0, {
            type: "spring", stiffness: 700, damping: 44, mass: 0.65, velocity, restDelta: 0.5, restSpeed: 10,
            onUpdate: write,
            onComplete: finishDismiss,
          });
          return;
        }
        delete panel.dataset.sheetClosing;
        anchor = target === expanded ? "expanded" : "compact";
        panel.dataset.sheetSnap = anchor;
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) { commit(target); return; }
        prepare(target);
        animation = animate(height, target, {
          type: "spring", stiffness: 620, damping: 42, mass: 0.7, velocity, restDelta: 0.5, restSpeed: 10,
          onUpdate: write,
          onComplete: () => commit(target),
        });
      };
      const layout = (enter: boolean) => {
        animation?.stop();
        cancelAnimationFrame(openingFrame);
        cancelAnimationFrame(dismissFrame);
        if (drag && handle.hasPointerCapture(drag.id)) handle.releasePointerCapture(drag.id);
        drag = null;
        delete panel.dataset.sheetClosing;
        delete panel.dataset.sheetDragging;
        const viewport = window.visualViewport;
        const available = viewport?.height ?? window.innerHeight;
        expanded = Math.max(120, available - 12);
        compact = Math.min(expanded, Math.max(220, Math.min(naturalHeight, available * 0.6)));
        panel.style.setProperty("--sheet-bottom", `${Math.max(0, window.innerHeight - available - (viewport?.offsetTop ?? 0))}px`);
        const target = anchor === "expanded" ? expanded : compact;
        if (enter && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
          height = 0;
          prepare(target);
          openingFrame = requestAnimationFrame(() => settle(target));
        } else commit(target);
        panel.dataset.sheetSnap = anchor;
      };
      const resize = () => layout(false);
      const down = (event: PointerEvent) => {
        if (!event.isPrimary || event.button !== 0) return;
        const target = event.target instanceof Element ? event.target : null;
        const area = target?.closest(".mobile-sheet-handle, header");
        if (!area || area.parentElement !== panel) return;
        const control = target?.closest("button, input, textarea, select, a, summary, [role='button']");
        if (control && control !== handle) return;
        animation?.stop();
        cancelAnimationFrame(openingFrame);
        cancelAnimationFrame(dismissFrame);
        prepare(height);
        drag = { id: event.pointerId, y: event.clientY, height, samples: [{ y: event.clientY, time: event.timeStamp }] };
        handle.setPointerCapture(event.pointerId);
        panel.dataset.sheetDragging = "true";
      };
      const move = (event: PointerEvent) => {
        if (!drag || drag.id !== event.pointerId) return;
        const rawHeight = drag.height + drag.y - event.clientY;
        // Downward travel remains direct until the closed boundary; overshoot is bounded.
        write(rubberBand(rawHeight, 0, expanded));
        drag.samples.push({ y: event.clientY, time: event.timeStamp });
        drag.samples = drag.samples.filter((sample) => event.timeStamp - sample.time <= 100);
      };
      const finish = (event: PointerEvent) => {
        if (!drag || drag.id !== event.pointerId) return;
        const start = drag.samples.find((sample) => event.timeStamp - sample.time <= 100);
        const elapsed = start ? event.timeStamp - start.time : 0;
        const velocity = start && elapsed > 0 ? (start.y - event.clientY) / elapsed * 1000 : 0;
        const cancelled = event.type !== "pointerup";
        drag = null;
        delete panel.dataset.sheetDragging;
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        settle(cancelled ? (anchor === "expanded" ? expanded : compact) : sheetTarget(height, velocity, compact, expanded), cancelled ? 0 : velocity);
      };
      const keydown = (event: KeyboardEvent) => {
        if (!["ArrowUp", "ArrowDown", "Home", "End", "Enter", " "].includes(event.key)) return;
        event.preventDefault();
        settle(event.key === "ArrowUp" || event.key === "End" ? expanded
          : event.key === "ArrowDown" || event.key === "Home" ? compact
            : anchor === "compact" ? expanded : compact);
      };
      layout(true);
      panel.addEventListener("pointerdown", down);
      panel.addEventListener("pointermove", move);
      panel.addEventListener("pointerup", finish);
      panel.addEventListener("pointercancel", finish);
      panel.addEventListener("lostpointercapture", finish);
      handle.addEventListener("keydown", keydown);
      window.visualViewport?.addEventListener("resize", resize);
      window.addEventListener("resize", resize);
      dispose = () => {
        animation?.stop();
        cancelAnimationFrame(openingFrame);
        cancelAnimationFrame(dismissFrame);
        panel.removeEventListener("pointerdown", down);
        panel.removeEventListener("pointermove", move);
        panel.removeEventListener("pointerup", finish);
        panel.removeEventListener("pointercancel", finish);
        panel.removeEventListener("lostpointercapture", finish);
        handle.removeEventListener("keydown", keydown);
        window.visualViewport?.removeEventListener("resize", resize);
        window.removeEventListener("resize", resize);
        delete panel.dataset.sheetMobile;
        panel.style.removeProperty("--sheet-height");
        panel.style.removeProperty("--sheet-bottom");
        panel.style.removeProperty("--sheet-transform");
        panel.style.removeProperty("--sheet-tail");
        delete panel.dataset.sheetMoving;
        delete panel.dataset.sheetSnap;
        delete panel.dataset.sheetDragging;
        delete panel.dataset.sheetClosing;
        if (--locks === 0) document.body.style.overflow = previousOverflow;
      };
    };
    setup();
    media.addEventListener("change", setup);
    return () => { dispose(); media.removeEventListener("change", setup); };
  }, []);

  return <button ref={handleRef} className="mobile-sheet-handle" type="button" aria-label="调整抽屉高度" title="拖动调整高度，上下方向键切换高度"><span /></button>;
}
