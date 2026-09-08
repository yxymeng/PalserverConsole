import { expect, test } from "@playwright/test";

test("FlowMist operation states, themes and fallback", async ({ page }, testInfo) => {
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
    window.showOperation = (state, stage) => root.render(React.createElement(OperationStatusIsland, {
      operation: { operationId: 'preview', kind: 'restart', state, stage, errorCode: null, detail: null },
      onCancel: () => window.showOperation('cancelled', 'countdown'),
      onForceStop: () => window.showOperation('running', 'force_stopping'),
    }));
    window.showOperation('running', 'stopping');
  ` });
  });
  await page.goto("/");
  const island = page.getByLabel("当前操作状态");
  const progress = island.getByRole("progressbar");
  await expect(progress).toHaveAttribute("aria-valuenow", "66");
  await expect(progress.locator("canvas")).toBeVisible();
  expect(await progress.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext("webgl");
    return gl !== null && !gl.isContextLost() && gl.getError() === gl.NO_ERROR;
  })).toBe(true);
  for (const theme of ["light", "island", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await expect(island).toBeVisible();
    const box = await island.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= page.viewportSize()!.width).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`flowmist-${theme}-${testInfo.project.name}.png`), animations: "disabled" });
  }
  const show = async (state: string, stage: string) => page.evaluate(([state, stage]) => {
    (window as unknown as { showOperation: (state: string, stage: string) => void }).showOperation(state, stage);
  }, [state, stage]);
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
  await expect(progress).toHaveAttribute("aria-valuenow", "38");
  await page.addInitScript(() => { HTMLCanvasElement.prototype.getContext = () => null; });
  await page.reload();
  await expect(progress.locator(".flowmist-fallback")).toBeVisible();
  await expect(progress).toHaveAttribute("aria-valuenow", "66");
});
