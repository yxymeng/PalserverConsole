# 测试样本

本目录不是 PalServer 存档下载区，也不包含可恢复的游戏存档。

- `golden/world-structure-v1.json` 是公开 CI 默认运行的合成结构语料，只包含解析器需要识别的字段名和预期计数，不含玩家数据、UUID、IP、密码或真实路径。
- `sanitized/` 中的本地样本默认全部被 Git 忽略，只供开发机或私有 runner 做只读验证。
- 不要把真实 `Level.sav`、玩家数据、密码或日志复制到这里。
- 私有 runner 只能通过 `PALSERVER_M5_LEVEL_SAV` 和 `PALSERVER_OOZ_DLL` 指向工作区外的只读文件；不要把样本或 DLL 复制进仓库。
- GitHub Actions 的公开报告会显示 golden fixture 结果和跳过数；真实环境未手动启用时明确显示 `not configured`。
