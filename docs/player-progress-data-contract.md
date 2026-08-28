# 玩家进度数据契约

本契约记录玩家进度字段的只读来源与统计口径。字段缺失、类型异常或负数时返回
`partial | unavailable`，不得补成 `0`。

| API 字段 | 玩家存档来源 | 统计公式 |
| --- | --- | --- |
| `dungeonClears` | `RecordData.NormalDungeonClearCount`、`RecordData.FixedDungeonClearCount` | 两个非负整数之和；任一缺失时不可用 |
| `oilRigClears` | `RecordData.OilrigClearCount` | 非负整数原值 |
| `relics` | `RecordData.RelicObtainForInstanceFlag` | Map 中值为 `true / 1` 的条目数 |
| `fastTravel` | `RecordData.FastTravelPointUnlockFlag` | Map 中值为 `true / 1` 的条目数 |
| `memos` | `RecordData.NoteObtainForInstanceFlag` | Map 中值为 `true / 1` 的条目数 |
| `technologyPoints` | `SaveData.TechnologyPoint` | 当前非负整数原值，不是历史累计获得量 |

`relics` 不读取 `RelicPossessNum`（当前持有数量），也不读取
`RelicBonusExpTableIndex`（奖励表索引）。`fastTravel` 与 `memos` 同样不使用对应
`*BonusExpTableIndex` 代替解锁条目数。

## 回归基线

`fixtures/golden/player-progress-v1.json` 是从一次只读真实玩家存档核对中提取的无标识
golden baseline。它只保留上述源字段计数和 expected result，不包含玩家名、UUID、真实路径
或可恢复存档。公开 CI 会重建匿名 Map 并验证归一化结果。

本机在 2026-08-27 对三份当前玩家存档进行了只读核对：

| 字段 | 真实样本结果 |
| --- | --- |
| `dungeonClears` | 18、23、24；两个地下城计数源字段均存在 |
| `relics` | 11、25、26 |
| `fastTravel` | 85、149、174 |
| `memos` | 7、16、11 |
| `technologyPoints` | 54、7、35 |
| `oilRigClears` | 三份样本均缺少 `OilrigClearCount`，正确返回不可用 |

因此，油田字段的“缺失不补零”行为已有真实证据，但正数
`OilrigClearCount` 仍需后续包含油田通关记录的真实存档确认。额外只读扫描当前世界及其
官方备份中的 33 份玩家存档后，该字段仍全部缺失。维护者不得把当前结果描述为正数口径已验证。
