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

“服务器配置”页保存的是 `data/pending/PalWorldSettings.ini` 草稿，不是正在运行的服务器文件。应用前必须停止 PalServer；外部修改会阻止自动覆盖。`AdminPassword` 只显示“已配置/未配置”，`WorldOption.sav` 存在时页面持续显示覆盖优先级警告。

## 故障排查顺序

1. 记录页面上的 `errorCode`、中文说明和发生时间。
2. 在本机访问 `http://127.0.0.1:8223/api/health`，确认返回 `status: ok`。
3. 检查“服务器管理”页的路径、进程状态和启动参数。
4. 检查 `data/logs/console.stdout.log` 与 `console.stderr.log`，不要把日志上传到公开位置。
5. 若涉及恢复或配置冲突，停止 PalServer，先保留安全副本，再按维护窗口清单处理。

不要使用浏览器开发者工具直接调用 PalServer REST；REST/RCON 密钥只应在后端进程内读取。
