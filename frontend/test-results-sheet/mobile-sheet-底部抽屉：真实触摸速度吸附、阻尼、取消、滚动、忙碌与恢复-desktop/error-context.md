# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: mobile-sheet.spec.ts >> 底部抽屉：真实触摸速度吸附、阻尼、取消、滚动、忙碌与恢复
- Location: e2e\mobile-sheet.spec.ts:48:1

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'dialog', exact: true })

```

# Test source

```ts
  1   | import { expect, test, type Page } from "@playwright/test";
  2   | 
  3   | // Real project primitives, isolated from server operations and user data.
  4   | const harness = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
  5   | import React from '/node_modules/.vite/deps/react.js';
  6   | import { createRoot } from '/node_modules/.vite/deps/react-dom_client.js';
  7   | import { Dialog, DialogContent, DialogTitle } from '/src/components/ui/dialog.tsx';
  8   | import { Sheet, SheetContent, SheetTitle } from '/src/components/ui/sheet.tsx';
  9   | import { ConfirmActionDialog } from '/src/components/ConfirmActionDialog.tsx';
  10  | import '/src/styles.css';
  11  | const h = React.createElement;
  12  | function App() {
  13  |   const [open, setOpen] = React.useState('');
  14  |   const [busy, setBusy] = React.useState(false);
  15  |   return h('main', {},
  16  |     ...['dialog', 'sheet', 'confirm'].map(kind => h('button', {key:kind, onClick:()=>setOpen(kind)}, kind)),
  17  |     h(Dialog, {open:open==='dialog', onOpenChange:value=>{if(!busy&&!value)setOpen('');}},
  18  |       h(DialogContent, {}, h(DialogTitle, {}, '手势测试'), h('input', {'aria-label':'测试输入'}),
  19  |         h('button', {onClick:()=>setBusy(!busy)}, busy?'解除忙碌':'模拟忙碌'),
  20  |         h('div', {style:{height:900,flexShrink:0}}, '可滚动内容'), h('button', {}, '内容末尾'))),
  21  |     h(Sheet, {open:open==='sheet', onOpenChange:value=>{if(!value)setOpen('');}},
  22  |       h(SheetContent, {}, h(SheetTitle, {}, '侧栏测试'), h('button', {}, '侧栏操作'))),
  23  |     h(ConfirmActionDialog, {open:open==='confirm', title:'确认测试', description:'取消不会执行操作', confirmLabel:'执行', onOpenChange:value=>{if(!value)setOpen('');}, onConfirm:()=>{document.body.dataset.confirmed='true';}}));
  24  | }
  25  | createRoot(document.getElementById('root')).render(h(App));
  26  | </script></body></html>`;
  27  | 
  28  | async function swipe(page: Page, distance: number, interval: number, cancel = false) {
  29  |   const handle = page.getByRole("button", { name: "调整抽屉高度" });
  30  |   const box = (await handle.boundingBox())!;
  31  |   const x = box.x + box.width / 2;
  32  |   const y = box.y + box.height / 2;
  33  |   const client = await page.context().newCDPSession(page);
  34  |   await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  35  |   for (let step = 1; step <= 5; step++) {
  36  |     await page.waitForTimeout(interval);
  37  |     await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + distance * step / 5 }] });
  38  |   }
  39  |   await client.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
  40  |   await client.detach();
  41  | }
  42  | 
  43  | test.beforeEach(async ({ page }) => {
  44  |   await page.route("**/sheet-harness", route => route.fulfill({ contentType: "text/html", body: harness }));
  45  |   await page.goto("/sheet-harness");
  46  | });
  47  | 
  48  | test("底部抽屉：真实触摸速度吸附、阻尼、取消、滚动、忙碌与恢复", async ({ page }, info) => {
> 49  |   await page.getByRole("button", { name: "dialog", exact: true }).click();
      |                                                                   ^ Error: locator.click: Test timeout of 30000ms exceeded.
  50  |   const dialog = page.getByRole("dialog");
  51  |   const handle = dialog.getByRole("button", { name: "调整抽屉高度" });
  52  |   if (info.project.name === "desktop") {
  53  |     await expect(handle).toBeHidden();
  54  |     await expect(dialog).not.toHaveClass(/mobile-bottom-sheet/);
  55  |     await page.screenshot({ path: info.outputPath("dialog-desktop.png") });
  56  |     await page.keyboard.press("Escape");
  57  |     await expect(dialog).toBeHidden();
  58  |     return;
  59  |   }
  60  |   await expect(dialog).toHaveAttribute("data-sheet-snap", "compact");
  61  |   await swipe(page, -90, 85);
  62  |   await expect(dialog).toHaveAttribute("data-sheet-snap", "compact");
  63  |   await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(506.4, 0);
  64  |   await swipe(page, -90, 8);
  65  |   await expect(dialog).toHaveAttribute("data-sheet-snap", "expanded");
  66  |   await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(832, 0);
  67  |   const box = (await handle.boundingBox())!;
  68  |   await page.mouse.move(195, box.y + 22);
  69  |   await page.mouse.down();
  70  |   await page.mouse.move(195, box.y + 2);
  71  |   const overshoot = (await dialog.boundingBox())!.height;
  72  |   expect(overshoot).toBeGreaterThan(832);
  73  |   expect(overshoot).toBeLessThan(852);
  74  |   await page.mouse.up();
  75  |   await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(832, 0);
  76  |   await swipe(page, 100, 20, true);
  77  |   await expect(dialog).toHaveAttribute("data-sheet-snap", "expanded");
  78  |   await dialog.getByRole("button", { name: "内容末尾" }).scrollIntoViewIfNeeded();
  79  |   await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  80  |   await expect(handle).toBeInViewport();
  81  |   await dialog.evaluate(el => { el.scrollTop = 0; });
  82  |   await dialog.getByRole("textbox", { name: "测试输入" }).fill("表单输入保持正常");
  83  |   await page.screenshot({ path: info.outputPath("sheet-expanded-mobile.png") });
  84  |   await handle.press("ArrowDown");
  85  |   await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(506.4, 0);
  86  |   await dialog.getByRole("button", { name: "模拟忙碌" }).click();
  87  |   await swipe(page, 160, 8);
  88  |   await expect(dialog).toBeVisible();
  89  |   await expect(dialog).toHaveAttribute("data-sheet-snap", "compact");
  90  |   await dialog.getByRole("button", { name: "解除忙碌" }).click();
  91  |   await swipe(page, 200, 8);
  92  |   await expect(dialog).toBeHidden();
  93  |   await expect(page.getByRole("button", { name: "dialog", exact: true })).toBeFocused();
  94  |   await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  95  | });
  96  | 
  97  | test("确认和侧栏覆盖、reduced-motion、跨断点恢复", async ({ page }, info) => {
  98  |   for (const kind of ["confirm", "sheet"]) {
  99  |     await page.getByRole("button", { name: kind, exact: true }).click();
  100 |     const dialog = page.getByRole(kind === "confirm" ? "alertdialog" : "dialog");
  101 |     if (info.project.name === "mobile") {
  102 |       const handle = dialog.getByRole("button", { name: "调整抽屉高度" });
  103 |       await expect(handle).toBeVisible();
  104 |       await page.emulateMedia({ reducedMotion: "reduce" });
  105 |       await handle.press("ArrowUp");
  106 |       expect((await dialog.boundingBox())!.height).toBeCloseTo(832, 0);
  107 |       await handle.press("ArrowDown");
  108 |       await page.screenshot({ path: info.outputPath(`${kind}-mobile.png`) });
  109 |       await page.setViewportSize({ width: 1000, height: 844 });
  110 |       await expect(handle).toBeHidden();
  111 |       await expect(dialog).not.toHaveClass(/mobile-bottom-sheet/);
  112 |       await page.setViewportSize({ width: 390, height: 844 });
  113 |       await expect(handle).toBeVisible();
  114 |     }
  115 |     await page.keyboard.press("Escape");
  116 |     await expect(dialog).toBeHidden();
  117 |     expect(await page.evaluate(() => document.body.dataset.confirmed)).toBeUndefined();
  118 |   }
  119 | });
  120 | 
```