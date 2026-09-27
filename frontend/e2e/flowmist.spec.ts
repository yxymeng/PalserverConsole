import { expect, test, type Page } from "@playwright/test";

async function mountIsland(page: Page) {
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/src/main.tsx", async (route) => {
    // Let Vite prepare the entry dependencies even with a cold optimizer cache.
    await route.fetch();
    return route.fulfill({ contentType: "text/javascript", body: `
    import React from '/node_modules/.vite/deps/react.js';
    import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import { OperationStatusIsland } from '/src/components/OperationStatusIsland.tsx';
    import '/src/styles.css';
    const root = ReactDOM.createRoot(document.getElementById('root'));
    window.showOperation = (state, stage, options = {}) => root.render(React.createElement(OperationStatusIsland, {
      operation: { operationId: 'preview', kind: 'restart', state, stage, errorCode: null, detail: null, ...options },
      onCancel: () => window.showOperation('cancelled', 'countdown', options),
      onForceStop: () => window.showOperation('running', 'force_stopping', options),
    }));
    window.showOperation('running', 'stopping');
  ` });
  });
  await page.goto("/");
}

test("closing fills once across countdown and shutdown, and resets only for a new operation", async ({ page }) => {
  const startedAt = new Date("2026-09-27T12:00:00Z").getTime();
  await page.clock.install({ time: startedAt });
  await mountIsland(page);
  const progress = page.getByLabel("当前操作状态").getByRole("progressbar");
  const show = async (state: string, stage: string, operationId = "stop-once") => {
    await page.evaluate(({ state, stage, operationId, startedAt }) => {
      (window as unknown as { showOperation: (state: string, stage: string, options: object) => void })
        .showOperation(state, stage, { operationId, kind: "stop", updatedAt: startedAt / 1000 });
    }, { state, stage, operationId, startedAt });
    await expect(progress).toHaveAttribute("aria-valuetext", /.+/);
  };
  const value = async () => Number(await progress.getAttribute("aria-valuenow"));
  await show("queued", "queued");
  await expect(progress).toHaveAttribute("aria-valuenow", "8");
  const canvas = await progress.locator("canvas").elementHandle();
  let previous = await value();
  await show("running", "countdown");
  await expect(progress).toHaveAttribute("aria-valuetext", "剩余 30 秒");
  expect(await value()).toBeGreaterThanOrEqual(previous);
  await page.clock.fastForward(30_000);
  await expect(progress).toHaveAttribute("aria-valuetext", "剩余 0 秒");
  previous = await value();
  expect(previous).toBeLessThan(100);
  for (const stage of ["saving", "stopping", "saving"]) {
    await show("running", stage);
    await expect(progress).toHaveAttribute("aria-valuetext", stage === "saving" ? /保存世界/ : /安全关闭/);
    const current = await value();
    expect(current).toBeGreaterThanOrEqual(previous);
    expect(current).toBeLessThan(100);
    previous = current;
  }
  await show("succeeded", "stopped");
  await expect(progress).toHaveAttribute("aria-valuenow", "100");
  expect(await canvas!.evaluate((element) => element === document.querySelector(".operation-flowmist canvas"))).toBe(true);
  await show("queued", "queued", "next-stop");
  await expect(progress).toHaveAttribute("aria-valuenow", "8");
  await show("running", "stopping", "next-stop");
  await expect(progress).toHaveAttribute("aria-valuetext", /安全关闭/);
  previous = await value();
  await show("awaiting_force_confirmation", "shutdown_timeout", "next-stop");
  await expect(progress).toHaveAttribute("aria-valuetext", "等待确认");
  expect(await value()).toBe(previous);
  await show("failed", "failed", "next-stop");
  await expect(progress).toHaveAttribute("aria-valuetext", "未完成");
  expect(await value()).toBe(previous);
  await show("running", "countdown", "cancel-stop");
  await expect(progress).toHaveAttribute("aria-valuetext", "剩余 0 秒");
  previous = await value();
  await page.getByLabel("当前操作状态").getByRole("button", { name: "取消", exact: true }).click();
  await expect(progress).toHaveAttribute("aria-valuetext", "已取消");
  expect(await value()).toBe(previous);
});

test("a new countdown without updatedAt starts fresh after cancellation", async ({ page }) => {
  const startedAt = new Date("2026-09-27T12:00:00Z").getTime();
  await page.clock.install({ time: startedAt });
  await page.clock.pauseAt(startedAt + 1_000);
  await mountIsland(page);
  const island = page.getByLabel("当前操作状态");
  const progress = island.getByRole("progressbar");
  const show = async (operationId: string, updatedAt?: null) => page.evaluate(({ operationId, updatedAt }) => {
    (window as unknown as { showOperation: (state: string, stage: string, options: object) => void })
      .showOperation("running", "countdown", { operationId, kind: "stop", updatedAt });
  }, { operationId, updatedAt });
  for (const updatedAt of [undefined, null]) {
    await show(`old-${updatedAt}`, updatedAt);
    await expect(progress).toHaveAttribute("aria-valuenow", "8");
    await page.clock.fastForward(15_000);
    await expect(progress).toHaveAttribute("aria-valuetext", "剩余 15 秒");
    await expect(progress).toHaveAttribute("aria-valuenow", "34");
    await island.getByRole("button", { name: "取消", exact: true }).click();
    await expect(progress).toHaveAttribute("aria-valuetext", "已取消");
    await expect(progress).toHaveAttribute("aria-valuenow", "34");
    await show(`new-${updatedAt}`, updatedAt);
    await expect(progress).toHaveAttribute("aria-valuetext", "剩余 30 秒");
    await expect(progress).toHaveAttribute("aria-valuenow", "8");
    await page.clock.fastForward(5_000);
    await expect(progress).toHaveAttribute("aria-valuetext", "剩余 25 秒");
    const value = Number(await progress.getAttribute("aria-valuenow"));
    expect(value).toBeGreaterThan(8);
    expect(value).toBeLessThan(34);
  }
});

test("early countdown keeps sea-teal pigment visible", async ({ page }, testInfo) => {
  const now = new Date("2026-09-27T12:00:00Z").getTime();
  await page.clock.setFixedTime(now);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mountIsland(page);
  await page.evaluate((now) => {
    (window as unknown as { showOperation: (state: string, stage: string, options: object) => void })
      .showOperation("running", "countdown", { operationId: "early-stop", kind: "stop", updatedAt: now / 1000 - 3 });
  }, now);
  const island = page.getByLabel("当前操作状态");
  const progress = island.getByRole("progressbar");
  await expect(progress).toHaveAttribute("aria-valuetext", "剩余 27 秒");
  const pixel = await progress.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext("webgl")!;
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const width = Math.max(1, Math.floor(canvas.width * .04));
    const pixels = new Uint8Array(width * canvas.height * 4);
    gl.readPixels(0, 0, width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let strongest = [0, 0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > strongest[3]) strongest = [...pixels.slice(i, i + 4)];
    }
    return strongest;
  });
  expect(pixel[3]).toBeGreaterThan(160);
  expect(pixel[0]).toBeLessThan(210);
  expect(pixel[2]).toBeGreaterThan(pixel[0]);
  for (const theme of ["light", "island", "dark"]) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await island.screenshot({ path: testInfo.outputPath(`flowmist-start-${theme}-${testInfo.project.name}.png`), animations: "disabled" });
  }
});

test("FlowMist operation states, themes and fallback", async ({ page }, testInfo) => {
  await mountIsland(page);
  const island = page.getByLabel("当前操作状态");
  const progress = island.getByRole("progressbar");
  await expect(progress).toHaveAttribute("aria-valuenow", "78");
  await expect(progress.locator("canvas")).toBeVisible();
  expect(await progress.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext("webgl");
    return gl !== null && !gl.isContextLost() && gl.getError() === gl.NO_ERROR;
  })).toBe(true);
  expect(await progress.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext("webgl")!;
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const cloud = new Uint8Array(4), empty = new Uint8Array(4);
    gl.readPixels(Math.floor(canvas.width * .4), Math.floor(canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, cloud);
    gl.readPixels(canvas.width - 1, Math.floor(canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, empty);
    return cloud[3] > 0 && empty[3] === 0;
  })).toBe(true);
  let previewSequence = 0;
  const show = async (state: string, stage: string, operationId = `preview-${++previewSequence}`) => page.evaluate(({ state, stage, operationId }) => {
    (window as unknown as { showOperation: (state: string, stage: string, options: object) => void }).showOperation(state, stage, { operationId });
  }, { state, stage, operationId });
  const cloudColors = () => progress.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext("webgl")!, program = gl.getParameter(gl.CURRENT_PROGRAM);
    return ["baseColor", "accentColor", "lightColor"].map((name) => [...gl.getUniform(program, gl.getUniformLocation(program, name))]);
  });
  // Settle the shader progress as well as CSS before comparing theme colors.
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["light", "island", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await expect(island).toBeVisible();
    const box = await island.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= page.viewportSize()!.width).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`flowmist-${theme}-${testInfo.project.name}.png`), animations: "disabled" });
    const colors = await cloudColors();
    for (const state of ["succeeded", "failed", "cancelled"]) {
      const operationId = `${theme}-${state}`;
      await show("running", "stopping", operationId);
      await expect(progress).toHaveAttribute("aria-valuenow", "78");
      await show(state, "stopping", operationId);
      await expect(progress).toHaveAttribute("aria-valuenow", state === "succeeded" ? "100" : "78");
      expect(await cloudColors()).toEqual(colors);
      await island.screenshot({ path: testInfo.outputPath(`flowmist-${theme}-${state}-${testInfo.project.name}.png`), animations: "disabled" });
    }
    await show("running", "stopping");
    await expect(progress).toHaveAttribute("aria-valuenow", "78");
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await show("running", "countdown");
  await island.getByRole("button", { name: "取消", exact: true }).click();
  await expect(progress).toHaveAttribute("aria-valuetext", "已取消");
  await show("awaiting_force_confirmation", "stopping");
  await expect(progress).toHaveAttribute("aria-valuetext", "等待确认");
  await island.getByRole("button", { name: "确认强制停止" }).click();
  await expect(island).toContainText("正在强制停止服务器。");
  await show("failed", "stopping");
  await expect(progress).toHaveAttribute("aria-valuetext", "未完成");
  await show("succeeded", "stopped");
  await expect(progress).toHaveAttribute("aria-valuetext", "已完成");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await show("running", "saving");
  await expect(progress).toHaveAttribute("aria-valuenow", "62");
  await page.addInitScript(() => { HTMLCanvasElement.prototype.getContext = () => null; });
  await page.reload();
  await expect(progress.locator(".flowmist-fallback")).toBeVisible();
  await expect(progress).toHaveAttribute("aria-valuenow", "78");
});
