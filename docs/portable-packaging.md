# 便携版打包设计（后续版本）

便携版尚未实现。本文件只记录可执行设计，不把设计说明当成已发布安装包。

## 目标目录

```text
PalServerConsole\
  PalServerConsole.exe       # 未来的 Python 启动封装
  app\                       # FastAPI 与已构建 frontend/dist
  runtime\                   # 便携 Python、DLL 和依赖
  data\                      # 首次运行时创建，默认不随发布包携带
  start-console.bat          # 兼容当前双击入口
```

构建流程应在干净 Windows 虚拟机中完成：锁定 Python、Node 和依赖版本，执行后端测试、前端构建和 Playwright，确认生产只启动一个 Python 进程。发布包不能包含真实 `data/`、`.sav`、日志、数据库、Cookie 或任何密码。

首次启动应在 `data/` 外保存只读版本清单，并在依赖缺失时显示可复制的英文错误；升级只替换 `app/` 与 `runtime/`，不覆盖用户的 `data/`。升级前自动备份 `data/app.db`，失败时恢复上一份完整包和数据库副本。
