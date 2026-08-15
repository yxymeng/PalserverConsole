---
version: 1
slug: "frontend-src-app-consoleshell-tsx"
primary_target: "frontend/src/app/ConsoleShell.tsx"
related_targets: ["frontend/src/features/overview/Overview.tsx","frontend/src/features/server/ServerControlPanel.tsx","frontend/src/features/monitoring/LiveMonitoring.tsx","frontend/src/features/overview/OperationalHealthPanel.tsx"]
---

# 首页与应用外壳

- Scope / mode: `Operate`；首个增量模块只迁移应用外壳与首页，不改后端 API、世界数据、配置或维护业务。
- Audience / job: Windows 本机或可信 LAN 手机浏览器中的个人 PalServer 管理员，需要先看清状态，再安全执行启动、保存、关闭、重启和玩家管理。
- Direction: 继承 `DESIGN.md` 的“精密值守台”；桌面固定侧栏与 sticky 顶栏，手机使用抽屉；首页依次呈现 LAN 警告、服务器控制、实时指标、在线玩家和运维健康。
- Memorable interaction: 顶部动态状态岛承载生命周期倒计时、取消、强制确认与实际完成反馈，不降级成普通 toast。
- Constraints: 官方 `@shadcn` registry、Base UI、Tailwind CSS v4、`base-nova`；组件必须映射现有 token；保留四项一级导航、API 语义、中文状态、键盘焦点与 reduced-motion。
- States: 本机/LAN、未配置/停止/运行/转换/失败，实时数据加载/断线/过期/空/错误，指标未就绪，操作 queued/running/awaiting force/terminal，运维健康与清理预览。
- Validation: scoped Vitest、lint、typecheck、test、build，桌面与手机 Playwright；只用 mock/合成数据，不触碰真实服务器。
