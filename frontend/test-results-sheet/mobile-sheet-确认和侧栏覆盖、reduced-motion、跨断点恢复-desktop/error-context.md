# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: mobile-sheet.spec.ts >> 确认和侧栏覆盖、reduced-motion、跨断点恢复
- Location: e2e\mobile-sheet.spec.ts:97:1

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'confirm', exact: true })

```

# Test source

```ts
  1   | import { expect, test, type Page } from "@playwright/test";
  2   | 
  3   | // Real project primitives, isolated from server operations and user data.
  4   | const harness = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
  5   | import RefreshRuntime from '/@react-refresh';
  6   | RefreshRuntime.injectIntoGlobalHook(window);
  7   | window.$RefreshReg$ = () => {};
  8   | window.$RefreshSig$ = () => type => type;
  9   | window.__vite_plugin_react_preamble_installed__ = true;
  10  | await import('/sheet-app');
  11  | </script></body></html>`;
  12  | const harnessApp = `
  13  | import React from '/node_modules/.vite/deps/react.js';
  14  | import { createRoot } from '/node_modules/.vite/deps/react-dom_client.js';
  15  | import { Dialog, DialogContent, DialogTitle } from '/src/components/ui/dialog.tsx';
  16  | import { Sheet, SheetContent, SheetTitle } from '/src/components/ui/sheet.tsx';
  17  | import { ConfirmActionDialog } from '/src/components/ConfirmActionDialog.tsx';
  18  | import '/src/styles.css';
  19  | const h = React.createElement;
  20  | function App() {
  21  |   const [open, setOpen] = React.useState('');
  22  |   const [busy, setBusy] = React.useState(false);
  23  |   return h('main', {},
  24  |     ...['dialog', 'sheet', 'confirm'].map(kind => h('button', {key:kind, onClick:()=>setOpen(kind)}, kind)),
  25  |     h(Dialog, {open:open==='dialog', onOpenChange:value=>{if(!busy&&!value)setOpen('');}},
  26  |       h(DialogContent, {}, h(DialogTitle, {}, '手势测试'), h('input', {'aria-label':'测试输入'}),
  27  |         h('button', {onClick:()=>setBusy(!busy)}, busy?'解除忙碌':'模拟忙碌'),
  28  |         h('div', {style:{height:900,flexShrink:0}}, '可滚动内容'), h('button', {}, '内容末尾'))),
  29  |     h(Sheet, {open:open==='sheet', onOpenChange:value=>{if(!value)setOpen('');}},
  30  |       h(SheetContent, {}, h(SheetTitle, {}, '侧栏测试'), h('button', {}, '侧栏操作'))),
  31  |     h(ConfirmActionDialog, {open:open==='confirm', title:'确认测试', description:'取消不会执行操作', confirmLabel:'执行', onOpenChange:value=>{if(!value)setOpen('');}, onConfirm:()=>{document.body.dataset.confirmed='true';}}));
  32  | }
  33  | createRoot(document.getElementById('root')).render(h(App));`;
  34  | 
  35  | async function swipe(page: Page, distance: number, interval: number, cancel = false) {
  36  |   const handle = page.getByRole("button", { name: "调整抽屉高度" });
  37  |   const box = (await handle.boundingBox())!;
  38  |   const x = box.x + box.width / 2;
  39  |   const y = box.y + box.height / 2;
  40  |   const client = await page.context().newCDPSession(page);
  41  |   await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  42  |   for (let step = 1; step <= 5; step++) {
  43  |     await page.waitForTimeout(interval);
  44  |     await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + distance * step / 5 }] });
  45  |   }
  46  |   await client.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
  47  |   await client.detach();
  48  | }
  49  | 
  50  | test.beforeEach(async ({ page }) => {
  51  |   await page.route("**/sheet-harness", route => route.fulfill({ contentType: "text/html", body: harness }));
  52  |   await page.route("**/sheet-app", route => route.fulfill({ contentType: "application/javascript", body: harnessApp }));
  53  |   await page.goto("/sheet-harness");
  54  | });
  55  | 
  56  | test("底部抽屉：真实触摸速度吸附、阻尼、取消、滚动、忙碌与恢复", async ({ page }, info) => {
  57  |   await page.getByRole("button", { name: "dialog", exact: true }).click();
  58  |   const dialog = page.getByRole("dialog");
  59  |   const handle = dialog.getByRole("button", { name: "调整抽屉高度" });
  60  |   if (info.project.name === "desktop") {
  61  |     await expect(handle).toBeHidden();
  62  |     await expect(dialog).not.toHaveClass(/mobile-bottom-sheet/);
  63  |     await page.screenshot({ path: info.outputPath("dialog-desktop.png") });
  64  |     await page.keyboard.press("Escape");
  65  |     await expect(dialog).toBeHidden();
  66  |     return;
  67  |   }
  68  |   await expect(dialog).toHaveAttribute("data-sheet-snap", "compact");
  69  |   await swipe(page, -90, 85);
  70  |   await expect(dialog).toHaveAttribute("data-sheet-snap", "compact");
  71  |   await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(506.4, 0);
  72  |   await swipe(page, -90, 8);
  73  |   await expect(dialog).toHaveAttribute("data-sheet-snap", "expanded");
  74  |   await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(832, 0);
  75  |   const box = (await handle.boundingBox())!;
  76  |   await page.mouse.move(195, box.y + 22);
  77  |   await page.mouse.down();
  78  |   await page.mouse.move(195, box.y + 2);
  79  |   const overshoot = (await dialog.boundingBox())!.height;
  80  |   expect(overshoot).toBeGreaterThan(832);
  81  |   expect(overshoot).toBeLessThan(852);
  82  |   await page.mouse.up();
  83  |   await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(832, 0);
  84  |   await swipe(page, 100, 20, true);
  85  |   await expect(dialog).toHaveAttribute("data-sheet-snap", "expanded");
  86  |   await dialog.getByRole("button", { name: "内容末尾" }).scrollIntoViewIfNeeded();
  87  |   await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  88  |   await expect(handle).toBeInViewport();
  89  |   await dialog.evaluate(el => { el.scrollTop = 0; });
  90  |   await dialog.getByRole("textbox", { name: "测试输入" }).fill("表单输入保持正常");
  91  |   await page.screenshot({ path: info.outputPath("sheet-expanded-mobile.png") });
  92  |   await handle.press("ArrowDown");
  93  |   await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(506.4, 0);
  94  |   await dialog.getByRole("button", { name: "模拟忙碌" }).click();
  95  |   await swipe(page, 160, 8);
  96  |   await expect(dialog).toBeVisible();
  97  |   await expect(dialog).toHaveAttribute("data-sheet-snap", "compact");
  98  |   await dialog.getByRole("button", { name: "解除忙碌" }).click();
> 99  |   await swipe(page, 200, 8);
      |                                                                 ^ Error: locator.click: Test timeout of 30000ms exceeded.
  100 |   await expect(dialog).toBeHidden();
  101 |   await expect(page.getByRole("button", { name: "dialog", exact: true })).toBeFocused();
  102 |   await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  103 | });
  104 | 
  105 | test("确认和侧栏覆盖、reduced-motion、跨断点恢复", async ({ page }, info) => {
  106 |   for (const kind of ["confirm", "sheet"]) {
  107 |     await page.getByRole("button", { name: kind, exact: true }).click();
  108 |     const dialog = page.getByRole(kind === "confirm" ? "alertdialog" : "dialog");
  109 |     if (info.project.name === "mobile") {
  110 |       const handle = dialog.getByRole("button", { name: "调整抽屉高度" });
  111 |       await expect(handle).toBeVisible();
  112 |       await page.emulateMedia({ reducedMotion: "reduce" });
  113 |       await handle.press("ArrowUp");
  114 |       expect((await dialog.boundingBox())!.height).toBeCloseTo(832, 0);
  115 |       await handle.press("ArrowDown");
  116 |       await page.screenshot({ path: info.outputPath(`${kind}-mobile.png`) });
  117 |       await page.setViewportSize({ width: 1000, height: 844 });
  118 |       await expect(handle).toBeHidden();
  119 |       await expect(dialog).not.toHaveClass(/mobile-bottom-sheet/);
  120 |       await page.setViewportSize({ width: 390, height: 844 });
  121 |       await expect(handle).toBeVisible();
  122 |     }
  123 |     await page.keyboard.press("Escape");
  124 |     await expect(dialog).toBeHidden();
  125 |     expect(await page.evaluate(() => document.body.dataset.confirmed)).toBeUndefined();
  126 |   }
  127 | });
  128 | 
```