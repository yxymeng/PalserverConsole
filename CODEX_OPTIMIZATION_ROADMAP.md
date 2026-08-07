# PalServerConsole 优化开发路线

> 文档集版本：`2.1`（最终精简版）｜基线：`main@977f298`｜本文件只保存首版后的任务索引和验收条件。开发 `OPT-XX` 时只读取对应状态行与模块段落，不通读全文。

## 状态与顺序

状态：`[ ]` 未开始｜`[~]` 进行中｜`[x]` 已完成并通过模块验收｜`[!]` 阻塞｜`[-]` 取消

| ID | 模块 | 优先级 | 依赖 | 状态 | 阶段 |
| --- | --- | --- | --- | --- | --- |
| OPT-01 | 配置输入与序列化安全 | P0 | 无 | `[x]` | A |
| OPT-02 | 显式配置应用工作流 | P0 | OPT-01 | `[x]` | A |
| OPT-03 | 生命周期状态与幂等性 | P0 | OPT-02 | `[ ]` | A |
| OPT-04 | ServerProfile 与世界绑定 | P0 | OPT-03 | `[ ]` | A |
| OPT-05 | 快照保留与磁盘保护 | P0 | OPT-04 | `[ ]` | A |
| OPT-06 | 崩溃可恢复的备份恢复 | P0 | OPT-04 | `[ ]` | A |
| OPT-07 | 本地网络、后台监督与持久日志 | P1 | OPT-03 | `[ ]` | A |
| OPT-08 | 迁移、版本与启动依赖一致性 | P1 | 阶段 A 通过 | `[ ]` | B |
| OPT-09 | 后端模块化 | P1 | OPT-08 | `[ ]` | B |
| OPT-10 | 前端模块化与 API 类型统一 | P1 | OPT-09 | `[ ]` | B |
| OPT-11 | Windows CI 与测试语料 | P1 | OPT-08 至 OPT-10 | `[ ]` | B |
| OPT-12 | Windows 便携版与安全升级 | P1 | 阶段 B 通过 | `[ ]` | C |
| OPT-13 | 运维健康与容量可观测性 | P2 | OPT-05 至 OPT-07、OPT-12 | `[ ]` | C |
| OPT-14 | SteamCMD 安全更新 | P2 | 阶段 C 通过 | `[ ]` | 可选 |
| OPT-15 | 维护通知集成 | P2 | OPT-13 | `[ ]` | 可选 |
| OPT-16 | 多实例与多世界 | P3 | OPT-04、OPT-12 | `[ ]` | 可选 |
| OPT-17 | 受控远程访问与角色权限 | P3 | OPT-12 | `[ ]` | 可选 |
| OPT-18 | 可选只读 UE4SS bridge | P3 | OPT-11、OPT-13 | `[ ]` | 可选 |

阶段顺序固定为 A → 阶段 A 验收 → B → 阶段 B 验收 → C → 发布验收。可选模块只有发布验收通过后才允许启动。

## OPT-01 配置输入与序列化安全

- 目标：阻止字段名、逗号、括号、换行和重复键向 `OptionSettings` 注入额外配置；`AdminPassword` 只能保留。
- 入口：`backend/palserver_console/config_editor.py`、`main.py`、`backend/tests/test_m7_config.py`。
- 实现：服务端限制键集合和请求规模，按类型规范化值；生成后重新解析并比对键和值；未知键只能编辑源文件已存在项。
- 验收：恶意 payload 返回稳定错误码；合法值 round-trip 不增删键、不改变密码、不丢未知字段；后端相关与全量检查通过。

完成记录：2026-08-08
- 修改：`config_editor.py` 解析并限制 JSON 草稿、字段和值，规范化布尔/数值/文本，拒绝重复键和未知新增字段；序列化后回读比对，并在应用前复核草稿。`main.py` 使用原始 JSON 解析以拦截重复键；`test_m7_config.py` 覆盖注入、密码保留、round-trip 和 API 错误码。
- 验证：`.\.venv\Scripts\python.exe -m pytest backend/tests/test_m7_config.py`（12 passed）；`.\.venv\Scripts\python.exe -m ruff check backend/palserver_console/config_editor.py backend/palserver_console/main.py backend/tests/test_m7_config.py`（All checks passed）；`.\.venv\Scripts\python.exe -m mypy`（Success: no issues found in 31 source files）；`.\.venv\Scripts\python.exe -m pytest`（66 passed, 2 skipped）。
- 未验证：未对真实 PalServer 或真实 `PalWorldSettings.ini` 执行写入；2 个既有存档集成测试因 `PALSERVER_M5_LEVEL_SAV`、`PALSERVER_OOZ_DLL`/`libooz.dll` 未配置而跳过。
- 风险/回滚：历史 INI 若本身含有重复键、无效字段名或不成对引号/括号，将被安全拒绝而不能创建草稿；回滚仅需还原本模块改动的三个后端文件和本路线记录，未修改任何真实配置或存档。

## OPT-02 显式配置应用工作流

- 目标：普通 stop/restart 与配置应用完全解耦，“重启并应用”准确报告每个阶段。
- 入口：`backend/palserver_console/config_editor.py`、`lifecycle.py`、`main.py`，以及 `backend/tests/test_m2_lifecycle.py`、`test_m7_config.py`。
- 实现：移除 `apply_pending_if_safe` 的隐式挂点；新增显式 operation；记录 save/stop/apply/restart/health_check 状态，冲突或应用失败时停止并给出恢复动作。
- 验收：普通 stop/restart 不改变草稿或真实 INI；只有显式操作能应用；失败不会显示“已应用”或吞掉错误。

完成记录：2026-08-08
- 修改：移除普通 lifecycle 的隐式草稿应用；新增 `apply_config_and_restart` operation，按 `saving`、`stopping`、`applying_config`、`restarting`、`health_check` 阶段执行。`/api/config/apply-with-restart` 只创建该显式 operation；应用失败时保留停服状态、错误码和“检查草稿或备份后使用普通 start”的恢复动作。草稿复核同步允许新增已知 schema 字段，仍拒绝新增未知字段。
- 验证：`.\.venv\Scripts\python.exe -m pytest backend/tests/test_m2_lifecycle.py backend/tests/test_m7_config.py`（28 passed）；`.\.venv\Scripts\python.exe -m ruff check backend/palserver_console/config_editor.py backend/palserver_console/lifecycle.py backend/palserver_console/main.py backend/tests/test_m2_lifecycle.py backend/tests/test_m7_config.py`（All checks passed）；`.\.venv\Scripts\python.exe -m mypy`（Success: no issues found in 31 source files）；`.\.venv\Scripts\python.exe -m pytest`（71 passed, 2 skipped）。
- 未验证：未在真实 PalServer 或真实 `PalWorldSettings.ini` 上执行 stop、apply、restart；2 个既有存档集成测试因 `PALSERVER_M5_LEVEL_SAV`、`PALSERVER_OOZ_DLL`/`libooz.dll` 未配置而跳过。
- 风险/回滚：真实环境的 `health_check` 只确认重启后进程未立即退出，尚未替代 REST 健康探测；如需回滚，恢复本模块的三处后端代码、两处测试和本路线记录，真实 INI 保持在操作前备份中，应用失败不会自动重启服务器。

## OPT-03 生命周期状态与幂等性

- 目标：同一时间只有一个影响 PalServer 的活动操作，重复请求稳定返回同一结果，旧确认不能作用于新进程。
- 入口：`backend/palserver_console/lifecycle.py`、`persistence.py`、`main.py`，以及 `backend/tests/test_m2_lifecycle.py`、`test_m8_integration.py`。
- 实现：统一 operation 状态机；幂等检查与创建同一事务；启动时处理中断状态；force-stop 绑定父 operation、PID 集合和有效期。
- 验收：并发重复请求不创建双 operation；等待确认阻止冲突操作；重启后陈旧确认失效；状态转换可审计。

## OPT-04 ServerProfile 与世界绑定

- 目标：生命周期、备份、配置和世界解析使用同一份单实例配置及明确 World ID。
- 入口：`backend/palserver_console/config.py`、`steam.py`、`backups.py`、`world/service.py`、`persistence.py`，以及 `backend/tests/test_m2_lifecycle.py`、`test_m5_world.py`、`test_m6_backups.py`。
- 实现：建立 `ServerProfile`；首次列出候选并由本机用户选择；路径漂移、缺失或多候选时阻止写操作；校验 Windows reparse point 和路径越界。
- 验收：多个世界不会自动选择写目标；修改时间不改变绑定；异常路径下恢复、删除和配置写入全部失败关闭。

## OPT-05 快照保留与磁盘保护

- 目标：长期运行时 snapshots/cache 不无限增长，磁盘不足也保留最后成功数据。
- 入口：`backend/palserver_console/world/service.py`、`cache.py`、`worker.py`、`backend/tests/test_m5_world.py`。
- 实现：按数量、总字节、年龄和最低剩余空间限制；清理孤立临时文件和无引用项；区分采集、解析和源文件时间；缓存 `libooz.dll` 发现结果。
- 验收：大量模拟变更后占用保持在边界内；清理失败不删除当前缓存；磁盘不足返回稳定错误并继续提供 stale 数据。

## OPT-06 崩溃可恢复的备份恢复

- 目标：异常、进程崩溃或断电后可识别恢复阶段并安全继续或回滚。
- 入口：`backend/palserver_console/backups.py`、`persistence.py`、`main.py`、`backend/tests/test_m6_backups.py`。
- 实现：持久 restore journal；校验源树和 staging；记录 World ID、源备份、安全副本、阶段与校验信息；启动时只报告并提供 resume/rollback。
- 验收：每个替换点故障注入都有确定恢复路径；未完成事务阻止冲突写入；回滚失败保留现场和英文原始异常。

## OPT-07 本地网络、后台监督与持久日志

- 目标：loopback 请求不受系统代理影响，后台任务可恢复，日志真实、有限且脱敏。
- 入口：`backend/palserver_console/main.py`、`monitoring.py`、`audit.py`、`auth.py`、`config.py`，以及 `backend/tests/test_m1_auth.py`、`test_m3_monitoring.py`、`test_m4_audit.py`、`test_m8_integration.py`。
- 实现：本地 httpx 使用 `trust_env=False`；后台循环暴露存活、最后成功和错误并退避重试；增加滚动日志；清理过期登录尝试和会话。
- 验收：设置 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 后本地 REST 仍正常；注入异常后任务恢复；日志滚动且不含测试密码。

## 阶段 A 验收

- 仅审核 OPT-01 至 OPT-07，不修改代码。
- 必查配置注入、隐式应用、operation 并发、世界绑定、磁盘配额、restore journal、路径删除/替换/kill。
- 运行受影响全量后端、前端和 E2E；逐项披露真实 `.sav` 或 Windows 环境缺口。
- Critical=0、High=0，且用户接受未验证项后才能通过。记录：`尚未执行`。

## OPT-08 迁移、版本与启动依赖一致性

- 目标：升级可恢复，应用、API、数据库、前端和解析器版本可准确识别。
- 入口：`backend/palserver_console/persistence.py`、`config.py`、`__init__.py`、`__main__.py`、`pyproject.toml`、`frontend/package.json`、`scripts/start-console.ps1`。
- 实现：迁移前备份并明确事务边界；统一版本来源；health/bootstrap 暴露各版本；启动器按锁文件哈希判断依赖；建立 Python 可重复锁定方案。
- 验收：历史 schema 升级有测试；迁移失败可恢复旧数据库；UI/API 版本一致；干净环境依赖安装可重复。

## OPT-09 后端模块化

- 目标：拆分过大的 `main.py`，保持 URL、状态码、错误码和响应契约不变。
- 入口：`backend/palserver_console/main.py`、其服务模块和 `backend/tests/`。
- 实现：按 auth/server/live/world/backups/config/audit 拆 `APIRouter`；分离装配、领域服务、适配器和 schema；建立可替换依赖工厂。
- 验收：`main.py` 仅保留应用创建、middleware、lifespan 和 router 装配；API contract 回归测试证明行为未变。

## OPT-10 前端模块化与 API 类型统一

- 目标：拆分 `App.tsx` 和全局样式，收敛前后端双格式兼容层。
- 入口：`frontend/src/App.tsx`、`App.test.tsx`、`styles.css`、`frontend/e2e/`。
- 实现：按 feature 拆页面、hooks、API client、types 和样式；移除 legacy 组件；由单一 schema 同步类型；补 Error Boundary、请求取消和 SSE 重连状态。
- 验收：`App.tsx` 只保留应用壳；核心页面有行为测试；桌面与移动端 E2E 通过且中文界面行为不变。

## OPT-11 Windows CI 与测试语料

- 目标：每次提交都能重复验证，Palworld 更新导致的解析回归能被发现。
- 入口：`pyproject.toml`、`frontend/package*.json`、`fixtures/`、后端测试、前端 E2E，新增 `.github/workflows/`。
- 实现：Windows CI 覆盖 Python 支持边界和 Node.js LTS；运行全部静态检查、单测、构建和 Playwright；建立脱敏 golden fixture；必要真实样本只在私有 runner 只读验证。
- 验收：必要检查失败即阻止发布；fixture 测试默认不 skip；报告区分通过、跳过、未配置和真实环境验证。

## 阶段 B 验收

- 仅审核 OPT-08 至 OPT-11，并复核阶段 A 不变量没有回归。
- 全量 CI 通过；版本、迁移、API contract 和依赖安装可重复；无未记录兼容层或明显死代码。
- Critical=0、High=0，且用户接受未验证项后才能通过。记录：`尚未执行`。

## OPT-12 Windows 便携版与安全升级

- 目标：无 Python/Node.js 的普通 Windows 主机可运行，升级不覆盖 `data/`。
- 入口：`start-console.bat`、`scripts/start-console.ps1`、`pyproject.toml`、前端构建、运维文档。
- 实现：优先评估 PyInstaller onedir；程序与数据目录分离；升级前检查和 DB 备份；失败回退；生成校验和、构建元数据和第三方许可证。
- 验收：干净 Windows 可启动；替换程序版本后数据完整；不兼容降级被阻止并解释；未签名时不得声称已签名。

## OPT-13 运维健康与容量可观测性

- 目标：用户在故障前看到磁盘、备份、缓存、日志和后台健康风险。
- 入口：`backend/palserver_console/monitoring.py`、`backups.py`、`world/cache.py`、`main.py`、`frontend/src/App.tsx`。
- 实现：显示各目录占用、剩余空间、最后成功解析/备份和后台健康；清理先预览并确认；可选官方备份校验与外部导出验证。
- 验收：空间不足提前告警并阻止高风险复制；页面明确区分无数据、旧数据、后台停止和解析失败。

## 发布验收

- 仅审核 OPT-12 至 OPT-13，并复核阶段 A/B 不变量。
- 验证干净 Windows 启动、升级保留数据、迁移失败、磁盘不足、本机/LAN 安全边界及 mock/fixture 完整工作流。
- 真实 PalServer 只做用户批准维护窗口内的必要验证；默认不执行破坏性恢复和强制停止。
- Critical=0、High=0，且用户接受未验证项后才能通过。记录：`尚未执行`。

## OPT-14 SteamCMD 安全更新

发布验收后再拆解。用户显式触发；必须覆盖在线玩家检查、通知、保存、停服、更新、校验、启动、健康检查和失败恢复，不做默认无人值守更新。

## OPT-15 维护通知集成

发布验收后再拆解。提供可选通知适配层，只发送高价值维护和故障事件，secret 不进入前端、日志或导出。

## OPT-16 多实例与多世界

发布验收后再拆解。每个实例必须独立配置、端口、数据命名空间、operation lock 和写目标，禁止交叉写入。

## OPT-17 受控远程访问与角色权限

发布验收后再拆解。不直接映射 `8223`；优先 VPN/零信任网络或受控 HTTPS reverse proxy，再设计代理信任、Cookie、审计和角色权限。

## OPT-18 可选只读 UE4SS bridge

发布验收后且现有数据源确有缺口时再拆解。bridge 必须独立、只读、可禁用并支持版本握手；不得提供内存写入、任意命令或存档编辑。

## 待分流

| 日期 | 来源模块 | 问题与证据 | 建议归属 | 严重程度 | 状态 |
| --- | --- | --- | --- | --- | --- |

## 完成记录格式

在当前模块段落末尾追加：

```text
完成记录：YYYY-MM-DD
- 修改：文件及关键行为
- 验证：命令与精确结果
- 未验证：环境缺口或“无”
- 风险/回滚：残余风险和恢复方式
```
