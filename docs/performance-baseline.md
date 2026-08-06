# M8 性能基线

使用 `scripts/measure-m8-performance.py` 在隔离 `FastAPI TestClient` 中测量。测试不会连接真实 PalServer，也不会写入存档、配置或备份。

最近一次工作区测量（2026-08-06）：

| 指标 | 结果 |
| --- | ---: |
| 空闲 RSS | 53,592,064 bytes |
| 30 次 `/api/health` 平均 | 0.670 ms |
| `/api/health` p50 | 0.611 ms |
| `/api/health` p95 | 1.018 ms |
| `/api/health` 最大值 | 1.029 ms |

这些数值是本机开发环境的 API 基线，不是 PalServer、浏览器或真实存档解析的总内存。当前 `data/app.db` 没有成功的 `snapshot_versions`，因此本次解析峰值标记为 `not-measured`；必须在用户批准的维护窗口或明确的脱敏解析环境中运行真实解析后，才能填写 `parseDurationMs`、`peakMemoryBytes` 和缓存大小。

目标仍遵循 `plan.md` 第 15 节：FastAPI 空闲 RSS 不高于 150 MB，缓存型本地 API p95 小于 200 ms，Node.js 只用于安装、开发和构建。
