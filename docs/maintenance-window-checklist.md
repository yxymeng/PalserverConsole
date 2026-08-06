# 真实服务器维护窗口清单

本清单只供用户明确批准的维护窗口使用。控制台不会自动执行以下步骤，默认测试均使用 mock、临时目录或只读快照。

## 只读准备

- [ ] 记录窗口开始时间、操作者和回滚联系人。
- [ ] 在本机确认 `PalServer.exe`、`PalWorldSettings.ini`、当前世界目录和 `backup\world` 路径。
- [ ] 确认控制台访问地址是 `127.0.0.1` 或可信 LAN，Windows Firewall 仅允许 `LocalSubnet`。
- [ ] 读取 `/api/live/info`、`/api/live/players`、`/api/live/metrics`，记录 `observedAt` 和 `stale=false`。
- [ ] 在“官方备份”页确认目标备份完整，包含 `Level.sav`、`LevelMeta.sav`、`Players`。

## 低风险验证

- [ ] 在无玩家或得到玩家同意后，单独确认一次“保存世界”。
- [ ] 等待存档文件稳定至少 5 秒，确认世界页面出现新的成功缓存和解析耗时。
- [ ] 记录当前配置和备份列表；不要把完整 INI、玩家 IP 或存档复制到公开位置。

## 高风险步骤（每项都要再次确认）

- [ ] 关闭/重启：确认维护通知内容、倒计时和 `operationId`；只有保存成功后才允许继续。
- [ ] 配置应用：确认草稿差异、源哈希和 `WorldOption.sav` 警告；PalServer 必须已停止。
- [ ] 备份恢复：确认备份 ID 是 `backup\world` 下一层目录；确认恢复前安全副本已创建。

## 验收与回滚

- [ ] 读取 `/api/shell/status`，确认进程路径和状态正确。
- [ ] 验证 REST `/info`、`/players`、`/metrics`，然后检查世界缓存时间戳。
- [ ] 配置应用后确认同目录 `.bak` 存在且可读；冲突不得被静默覆盖。
- [ ] 恢复后逐一校验 `Level.sav`、`LevelMeta.sav`、`Players`；失败时停止操作并保留 `ROLLBACK_FAILED` 原文。
- [ ] 记录结束时间、operation 状态、错误码和未完成项。
