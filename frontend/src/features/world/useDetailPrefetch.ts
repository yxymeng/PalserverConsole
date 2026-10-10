import { useEffect } from "react";
import type { DetailResource, WorldDetailCache } from "./worldDetailCache";

function isVisible(button: HTMLElement) {
  if (button.closest("[inert]")) return false;
  const rect = button.getBoundingClientRect();
  let top = 0, right = innerWidth, bottom = innerHeight, left = 0;
  if (!rect.width || !rect.height || rect.bottom <= top || rect.top >= bottom || rect.right <= left || rect.left >= right) return false;
  for (let parent = button.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      const bounds = parent.getBoundingClientRect();
      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      const bounds = parent.getBoundingClientRect();
      left = Math.max(left, bounds.left);
      right = Math.min(right, bounds.right);
    }
    const handle = parent.dataset.sheetMobile === "true" ? parent.querySelector(":scope > .mobile-sheet-handle") : null;
    if (handle) top = Math.max(top, handle.getBoundingClientRect().bottom);
    if (rect.bottom <= top || rect.top >= bottom || rect.right <= left || rect.left >= right) return false;
  }
  return true;
}

export function useDetailPrefetch(cache: WorldDetailCache, snapshotId: string | null | undefined) {
  useEffect(() => {
    cache.retainSnapshot(snapshotId);
    if (!snapshotId) return;
    let hoverTimer = 0;
    let idleTimer = 0;
    let idleCallback = 0;
    const selector = "button[data-detail-resource][data-detail-id]";
    const preload = (button: HTMLElement) => cache.preload(button.dataset.detailResource as DetailResource, button.dataset.detailId!, snapshotId);
    const target = (event: Event) => event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
    const over = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const button = target(event);
      if (!button || event.relatedTarget instanceof Node && button.contains(event.relatedTarget)) return;
      window.clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(() => preload(button), 120);
    };
    const out = (event: PointerEvent) => {
      const button = target(event);
      if (button && event.relatedTarget instanceof Node && button.contains(event.relatedTarget)) return;
      window.clearTimeout(hoverTimer);
    };
    const focus = (event: FocusEvent) => { const button = target(event); if (button) preload(button); };
    const visible = () => {
      let count = 0;
      for (const button of document.querySelectorAll<HTMLElement>(selector)) {
        if (!isVisible(button)) continue;
        preload(button);
        if (++count === 2) break;
      }
    };
    const schedule = () => {
      if (!matchMedia("(hover: none)").matches) return;
      window.clearTimeout(idleTimer);
      if (idleCallback) window.cancelIdleCallback(idleCallback);
      idleTimer = window.setTimeout(() => {
        idleCallback = window.requestIdleCallback ? window.requestIdleCallback(visible) : 0;
        if (!idleCallback) visible();
      }, 600);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    schedule();
    return () => {
      window.clearTimeout(hoverTimer);
      window.clearTimeout(idleTimer);
      if (idleCallback) window.cancelIdleCallback(idleCallback);
      observer.disconnect();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focus);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [cache, snapshotId]);
  useEffect(() => () => cache.clear(), [cache]);
}
