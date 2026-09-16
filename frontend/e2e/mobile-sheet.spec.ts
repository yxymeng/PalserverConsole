import { expect, test, type Page } from "@playwright/test";

// Real project primitives, isolated from server operations and user data.
const harness = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;
await import('/sheet-app');
</script></body></html>`;
const harnessApp = `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '/src/components/ui/dialog.tsx';
import { Sheet, SheetContent, SheetTitle } from '/src/components/ui/sheet.tsx';
import { ConfirmActionDialog } from '/src/components/ConfirmActionDialog.tsx';
import { MobileSheetHandle } from '/src/components/ui/mobile-sheet-handle.tsx';
import '/src/styles.css';
const h = React.createElement;
function App() {
  const [open, setOpen] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  return h('main', {},
    ...['card', 'dialog', 'sheet', 'confirm'].map(kind => h('button', {key:kind, onClick:()=>setOpen(kind)}, kind)),
    open==='card' && h('section', {role:'dialog', 'aria-label':'详情卡片', style:{position:'fixed',inset:'10% 10%',zIndex:50,display:'flex',flexDirection:'column',background:'var(--surface)'}},
      h(MobileSheetHandle, {onDismiss:()=>{if(!busy)setOpen('');}}), h('h2', {}, '详情卡片'), h('input', {'aria-label':'测试输入'}),
      h('button', {onClick:()=>setBusy(!busy)}, busy?'解除忙碌':'模拟忙碌'),
      h('button', {onClick:()=>setOpen('')}, '关闭详情'), h('div', {style:{height:900,flexShrink:0}}, '可滚动内容'), h('button', {}, '内容末尾')),
    h(Dialog, {open:open==='dialog', onOpenChange:value=>{if(!value)setOpen('');}},
      h(DialogContent, {className:'psc-broadcast-dialog'}, h(DialogTitle, {}, '全服广播系统'), h('textarea', {'aria-label':'广播内容正文'}),
        h(DialogFooter, {}, h('button', {onClick:()=>setOpen('')}, '取消'), h('button', {}, '立即发送广播')))),
    h(Sheet, {open:open==='sheet', onOpenChange:value=>{if(!value)setOpen('');}},
      h(SheetContent, {className:'psc-ban-sheet'}, h(SheetTitle, {}, '侧栏测试'), h('button', {}, '侧栏操作'))),
    h(ConfirmActionDialog, {open:open==='confirm', title:'确认测试', description:'取消不会执行操作', confirmLabel:'执行', onOpenChange:value=>{if(!value)setOpen('');}, onConfirm:()=>{document.body.dataset.confirmed='true';}}));
}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));`;

async function swipe(page: Page, distance: number, interval: number, cancel = false) {
  const handle = page.getByRole("button", { name: "调整抽屉高度" });
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const client = await page.context().newCDPSession(page);
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 5; step++) {
    await page.waitForTimeout(interval);
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + distance * step / 5 }] });
  }
  await client.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
  await client.detach();
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => console.error("Sheet harness:", error.message));
  await page.route("**/sheet-harness", route => route.fulfill({ contentType: "text/html", body: harness }));
  await page.route("**/sheet-app", route => route.fulfill({ contentType: "application/javascript", body: harnessApp }));
  await page.goto("/sheet-harness");
  await expect(page.getByRole("button", { name: "dialog", exact: true })).toBeVisible({ timeout: 5000 });
});

test("详情卡片：真实触摸速度吸附、阻尼、取消、滚动、忙碌与恢复", async ({ page }, info) => {
  await page.getByRole("button", { name: "card", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "详情卡片" });
  const handle = dialog.getByRole("button", { name: "调整抽屉高度" });
  if (info.project.name === "desktop") {
    await expect(handle).toBeHidden();
    await expect(dialog).not.toHaveClass(/mobile-bottom-sheet/);
    await page.screenshot({ path: info.outputPath("dialog-desktop.png") });
    await page.getByRole("button", { name: "关闭详情" }).click();
    await expect(dialog).toBeHidden();
    return;
  }
  await expect(dialog).toHaveAttribute("data-sheet-snap", "compact");
  await swipe(page, -90, 85);
  await expect(dialog).toHaveAttribute("data-sheet-snap", "compact");
  await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(506.4, 0);
  await swipe(page, -90, 8);
  await expect(dialog).toHaveAttribute("data-sheet-snap", "expanded");
  await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(832, 0);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(195, box.y + 22);
  await page.mouse.down();
  await page.mouse.move(195, box.y + 2);
  const overshoot = (await dialog.boundingBox())!.height;
  expect(overshoot).toBeGreaterThan(832);
  expect(overshoot).toBeLessThan(852);
  await page.mouse.up();
  await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(832, 0);
  await swipe(page, 100, 20, true);
  await expect(dialog).toHaveAttribute("data-sheet-snap", "expanded");
  await dialog.getByRole("button", { name: "内容末尾" }).scrollIntoViewIfNeeded();
  await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  await expect(handle).toBeInViewport();
  await dialog.evaluate(el => { el.scrollTop = 0; });
  await dialog.getByRole("textbox", { name: "测试输入" }).fill("表单输入保持正常");
  await page.screenshot({ path: info.outputPath("sheet-expanded-mobile.png") });
  await handle.press("ArrowDown");
  await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(506.4, 0);
  await dialog.getByRole("button", { name: "模拟忙碌" }).click();
  await swipe(page, 160, 8);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-sheet-snap", "compact");
  await dialog.getByRole("button", { name: "解除忙碌" }).evaluate((button: HTMLButtonElement) => button.click());
  await swipe(page, 200, 8);
  expect(await dialog.isVisible()).toBe(true);
  expect((await dialog.boundingBox())!.height).toBeGreaterThan(0);
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
});

test("操作确认、广播和普通侧栏保持原样并限制在手机视口内", async ({ page }, info) => {
  for (const kind of ["confirm", "dialog", "sheet"]) {
    await page.getByRole("button", { name: kind, exact: true }).click();
    const dialog = page.getByRole(kind === "confirm" ? "alertdialog" : "dialog");
    if (info.project.name === "mobile") {
      await expect(dialog.getByRole("button", { name: "调整抽屉高度" })).toHaveCount(0);
      await expect(dialog).not.toHaveClass(/mobile-bottom-sheet/);
      await expect.poll(async () => {
        const box = (await dialog.boundingBox())!;
        return box.x + box.width;
      }).toBeLessThanOrEqual(390);
      const box = (await dialog.boundingBox())!;
      expect(box.x, kind).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, kind).toBeLessThanOrEqual(390);
      expect(box.y, kind).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, kind).toBeLessThanOrEqual(844);
      if (kind === "confirm") {
        await expect(dialog.getByRole("button", { name: "取消" })).toBeInViewport();
        await expect(dialog.getByRole("button", { name: "执行" })).toBeInViewport();
      }
      await page.screenshot({ path: info.outputPath(`${kind}-mobile.png`) });
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => document.body.dataset.confirmed)).toBeUndefined();
  }
});
