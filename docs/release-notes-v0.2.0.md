# PalServerConsole v0.2.0

## 主要改进

- 校准玩家地下城、雕像、传送点、手记与科技点统计；字段缺失不再伪造为零。
- 新增由真实存档只读核对派生的无标识 player-progress golden regression。
- 世界数据与配置页面改为按需加载，生产构建不再出现 500 kB chunk warning。
- 维护页新增 PalServerConsole “检查更新 / 更新”入口；Windows portable 可保留 `data`
  并调用现有安全升级链，源码运行提供 Release 下载入口。
- 固定 npm install-script policy，ESLint 以零 warning 为通过标准。
- Windows CI 针对 `main` 提供稳定的 `Required checks` 合并检查名。
- 补充维护者侧 Palworld/FModel 数据同步边界和可重复 Release 流程。

## 已知限制

- 当前三份真实玩家存档都没有 `OilrigClearCount`。缺失处理已验证，正数油田通关仍待
  含该记录的真实存档确认。
- v0.1.1 没有内置自更新入口，因此首次升级到 v0.2.0 需要手工下载 portable；v0.2.0
  之后可使用控制台更新。
- Windows portable 当前仍未做 Authenticode 签名；`checksums.sha256` 不能替代发布者身份签名。

