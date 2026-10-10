# PalServerConsole Roadmap

> 本文件只保留仍在进行或尚未开始的事项。已经完成的 OPT-01～OPT-16、阶段验收、PR 修复记录和历史测试结果由 Git 历史、代码与测试承担，不再复制到 Roadmap。

## 后续事项

### 后续版本默认值与游戏内生效核验 `[ ]`

- 配置页及 INI/SAV 读写已支持 `bAllowEnemyCampSpawnNearBaseCamp`、`FishingDifficultyRate`、`MaxBuildingLimitNumPerPlayer`；尚需在获准的维护窗口核验游戏内效果及语音配置生效行为。
- `MaxBuildingLimitNumPerPlayer` 的 `0–10000` 目前只是控制台调节范围，并非已确认的游戏硬上限；PowerShellGSM 模板和 PalModManager 整数读取可作为参考，但均未给出游戏最大值。未获确认前不套用其他参数或工具的上限。
- SAV 稀疏序列化目前按 `pal-conf` 2026-07-11 默认表处理，需核对后续版本默认值；例如官方 1.0.4 文档的 `BaseCampMaxNumInGuild` 默认值为 4，而该表为 3。
- 依据：[官方配置参数](https://docs.palworldgame.com/settings-and-operation/configuration/)、[1.0.4 官方公告](https://steamcommunity.com/games/1623730/announcements/detail/695397189431592457)。

### 受控远程访问与角色权限 `[ ]`

- 不直接把控制台端口映射到公网。
- 优先考虑 VPN / 零信任网络，或经过明确设计的 HTTPS reverse proxy。
- 启动实现前必须明确代理信任、Cookie、安全审计和角色权限边界。
- 不为了远程访问破坏当前“本机免登录 + 可信 LAN AdminPassword”的简单路径。

### 可选只读 UE4SS bridge `[ ]`

- 只有官方 REST 与存档数据确实无法满足明确需求时才启动。
- bridge 必须独立、只读、可禁用并支持版本握手。
- 不提供内存写入、任意命令、存档编辑或对现有 UE4SS mod 的自动接管。

### 多实例强化 `[ ]`

当前多实例能力可用，但保留以下 Known Limitation：

- 两个命名实例误用同一个 Console Port 时，可能打开到另一个已运行实例。
- 当前跨实例冲突检查覆盖 Game / Query Port，但尚未完整覆盖 REST API / RCON Port。

这些限制主要影响同机多 PalServer 的高级用户，不改变默认单实例使用路径。后续强化时应优先补齐实例身份与端口冲突检测，不重做现有实例模型。

## 不进入 Roadmap 的内容

以下内容已经完成，不再保留逐模块历史状态：

- 配置输入与显式应用；
- 生命周期状态与幂等性；
- ServerProfile / 世界绑定；
- 快照保留与磁盘保护；
- 崩溃可恢复的备份恢复；
- 后端/前端模块化；
- Windows CI、便携版与安全升级；
- 运维健康与容量可观测性；
- SteamCMD 安全更新；
- 维护通知；
- 多实例与多世界基础能力。

需要追溯实现、验证命令、PR Review 或具体提交时使用 Git 历史，不把完成日志重新搬回本文件。

## 维护规则

- 只记录“还需要做什么”，不记录每次测试流水账。
- 大型功能有独立 spec 时，本文件只保留指针和状态。
- 完成事项直接从本文件移除；确需长期保留的设计原因写入 `docs/adr/`。
- 临时发现的问题若不属于当前任务，可在这里新增短条目；开始实现后再建立独立 ticket/spec。
