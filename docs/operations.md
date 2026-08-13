# 日常操作

## 状态和新鲜度

页面中的实时、世界、备份和审计数据都带 `source`、`observedAt`、`stale`、`errorCode`。`最新` 只表示后端最近一次成功读取；`已过期` 时不要根据旧数据执行高风险操作，先刷新并检查英文错误码。

统一错误响应格式为：

```json
{"errorCode":"CONFIG_CONFLICT","message":"检测到 PalWorldSettings.ini 已被外部修改，请先查看差异。","retryable":false}
```

`retryable=true` 只表示可以稍后重试，不代表操作已经成功。operation 使用 `queued`、`running`、`succeeded`、`failed`、`cancelled` 和 `awaiting_force_confirmation`；关闭浏览器不会取消后端操作，页面应通过 operation ID 继续查询。

## 备份

“官方备份”页默认无限保留。设置数字后只清理最旧且完整的历史备份。恢复前会创建安全副本并经过 staging 校验；服务器运行时恢复和删除都会被拒绝。恢复失败时后端尝试恢复 `Level.sav`、`LevelMeta.sav` 和 `Players` 三类内容，并返回 `ROLLBACK_FAILED` 或 `RESTORE_FAILED`。

## 配置草稿

“服务器配置”页保存的是 `data/pending/PalWorldSettings.ini` 草稿，不是正在运行的服务器文件。应用前必须停止 PalServer；外部修改会阻止自动覆盖。“面板设置 → 基本信息”中的 `AdminPassword` 只显示配置状态，输入新值后才会写入草稿；未输入新值时保留原值，密码不会回显。局域网登录校验真实 `PalWorldSettings.ini` 中的游戏管理员密码；`WorldOption.sav` 存在时页面持续显示覆盖优先级警告。

控制台监听端口位于“配置”页，只能在本机修改；修改后需重启控制台。控制台启动时根据是否已配置游戏 `AdminPassword` 决定监听地址：未配置时仅监听 `127.0.0.1`；首次设置并应用密码后需重启控制台才开放可信 LAN。如果已保存端口被 PalworldPanel 等其他程序占用，控制台不会共享或覆盖同一个 URL，而是仅在本次运行改用备用端口 `18223`，已保存的端口设置保持不变；如果备用端口也被其他程序占用，会保留英文 `Ports ... are already in use` 错误并停止启动。

## 首页实时状态

首页 CPU、内存和磁盘指标统计 `PalServer.exe` 及其全部后代进程，包含实际承载服务负载的 `PalServer-Win64-Shipping-Cmd.exe`。CPU 使用率按 Windows Task Manager 的整机 `0–100%` 口径计算；内存为进程树 RSS 总和；磁盘读取和写入为相邻采样间的每秒速率。首次采样显示校准状态，服务器空闲时显示 `0 B/秒` 是有效结果。

## 世界数据中的帕鲁

帕鲁列表有昵称时只显示昵称，无昵称时显示中文种族名；主人列显示玩家名称。属性列可显示性别、闪光、头目、狂暴、觉醒、导入角色和浓缩等级。头像及中文目录为离线资源，来源、固定版本和许可证见 `THIRD_PARTY_NOTICES.md`；可捕获人类/NPC 若上游没有专属头像，会显示明确的未知头像。

## 多实例提示

PalServerConsole 主要面向单 PalServer 使用。多实例用户需要确保 Console、Game、Query、REST API、RCON 端口都不重复。当前版本存在两项已知限制：两个命名实例误用同一个 Console Port 时，可能打开到另一个已经运行的实例；当前多实例检查覆盖 Game/Query Port，但没有完整检查 REST API / RCON Port。它们只影响同机多实例用户，单 PalServer + 单 Console 用户不受影响。

## 故障排查顺序

1. 记录页面上的 `errorCode`、中文说明和发生时间。
2. 在本机访问 `http://127.0.0.1:8223/api/health`，确认返回 `status: ok`。
3. 检查“配置”页的监听端口与服务器路径，并在“首页”检查进程状态、生命周期操作和实时数据来源。
4. 检查 `data/logs/console.stdout.log` 与 `console.stderr.log`，不要把日志上传到公开位置。
5. 若涉及恢复或配置冲突，停止 PalServer，先保留安全副本，再按维护窗口清单处理。

不要使用浏览器开发者工具直接调用 PalServer REST；REST/RCON 密钥只应在后端进程内读取。
