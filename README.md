# PalServerConsole

PalServerConsole 是运行在 PalServer 同一台 Windows 主机上的中文本地 Web 控制台。首版面向编程新手，覆盖服务器生命周期、官方备份、只读世界快照、实时监控、运营审计和 `PalWorldSettings.ini` 草稿。

## 双击启动

1. 安装 Python 3.11、3.12 或 3.13，并在安装程序中勾选 **Add Python to PATH**。
2. 安装 Node.js LTS（只在首次构建前端时使用）。
3. 双击项目目录中的 `start-console.bat`。
4. 浏览器打开 `http://127.0.0.1:8223/`。启动失败时不要关闭窗口，保留窗口中的英文错误信息。

启动器会自动创建 `.venv`、安装后端依赖、按 `package-lock.json` 检查前端依赖并构建静态页面。生产服务只启动一个 Python/Uvicorn 进程，不要求 Vite 常驻。

## 首次设置

在“服务器管理”页点击“扫描 Steam”，或填写 `PalServer.exe` 的完整路径和启动参数。路径必须指向实际文件。默认只监听 `127.0.0.1`；在“访问安全”页从本机设置至少 10 位 LAN 密码后，重启控制台才会监听局域网。

LAN 页面固定提示“仅可信内网使用，禁止公网暴露”。请在 Windows Firewall 中将规则限制为 `LocalSubnet`，不要把 HTTP 端口转发到公网。本机访问免登录，LAN 访问使用管理员密码。

## 安全操作边界

- 浏览器不接触 PalServer `AdminPassword`、RCON 密码或 LAN 密码。
- 保存世界、关闭、重启、备份恢复和配置应用都要求明确点击；关闭/重启会先保存，保存失败不会继续。
- 备份删除和恢复只接受官方 `backup\world` 的直接子目录；活动世界没有删除 API。
- 配置先保存到草稿。检测到外部编辑时显示 `CONFIG_CONFLICT`，不会自动覆盖。
- 真实服务器的恢复、配置应用和破坏性生命周期动作只应在用户批准的维护窗口执行。

## 常见问题

| 页面提示 | 处理方式 |
| --- | --- |
| `LAN_PASSWORD_REQUIRED` | 在服务器本机设置 LAN 密码，然后重启控制台。 |
| `SERVER_NOT_CONFIGURED` | 在“服务器管理”页选择有效的 `PalServer.exe`。 |
| `REST_CONNECTION_REFUSED` | 检查 PalServer 是否运行、REST 是否启用以及端口是否与 `PalWorldSettings.ini` 一致。 |
| `SNAPSHOT_PENDING` | 保存文件变化后等待稳定窗口；没有成功缓存时世界页面会显示过期状态。 |
| `CONFIG_CONFLICT` | 在配置页查看差异，确认目标文件确实应被覆盖后再点击确认。 |
| `ROLLBACK_FAILED` | 立即停止相关操作，保留英文错误详情；按维护清单使用恢复前安全副本人工回滚。 |

完整步骤见 [`docs/operations.md`](docs/operations.md)、[`docs/maintenance-window-checklist.md`](docs/maintenance-window-checklist.md) 和 [`docs/portable-packaging.md`](docs/portable-packaging.md)。

## 开发验证

在项目根目录执行：

```powershell
.venv\Scripts\python.exe -m ruff check backend
.venv\Scripts\python.exe -m mypy backend\palserver_console backend\tests
.venv\Scripts\python.exe -m pytest -q
Set-Location frontend
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run test
npm.cmd run build
npm.cmd run test:e2e
```

性能基线使用隔离的 FastAPI TestClient，不会连接或写入真实 PalServer：

```powershell
Set-Location ..
.venv\Scripts\python.exe scripts\measure-m8-performance.py
```

脚本输出空闲 RSS、API `p95` 和解析峰值状态。没有成功的存档解析缓存时，解析峰值会明确标记为 `not-measured`，不能把 API 基线当成真实存档性能。

## 数据与发布

`data/`、数据库、日志、真实 `.sav`、前端构建产物和 Playwright 截图均被 `.gitignore` 排除。发布前请检查 `git status` 和 `git check-ignore`，不要提交密码、Cookie、完整 IP、存档或运行数据。
