# 游戏数据与 Release 维护流程

PalserverConsole 的公开更新只能由仓库维护者在本地完成、验证后同步到 GitHub 并发布
Release。普通用户不运行 FModel、CUE4Parse 或 metadata 生成器，也不向项目写入游戏数据；
他们只下载维护者发布的 Windows portable，或在控制台“维护 → 服务器更新”中检查并安装
PalServerConsole 更新。

## Palworld 更新后的维护者流程

1. 在独立工作分支检查 Palworld 新增或变更的 Pal、图标、名称、映射与存档字段。
2. 只读使用本机游戏文件、FModel/CUE4Parse export 或已固定版本的同步脚本。
3. 将提取结果转换为项目的归一化输入；记录来源文件、游戏版本、导出工具版本和 SHA-256。
4. 通过 generator 更新离线 metadata bundle，不让运行时直接读取 FModel export。
5. 运行自动化测试、脱敏 golden regression 和获准的只读真实存档 smoke test。
6. 更新应用版本与 Release Notes，使用干净 Git revision 构建 Windows portable。
7. 维护者人工检查差异后再 commit、push，并创建 GitHub Release。
8. 上传精确命名的
   `PalServerConsole-<version>-windows-x64.zip`；普通用户随后才能检测到该版本。

## 为未来 FModel 全量数据迁移预留的边界

未来数据链保持单向：

```text
维护者本机 FModel / CUE4Parse export
        ↓  source manifest + tool/game version + SHA-256
归一化 staging model（稳定 ID、原始 localization key、来源状态）
        ↓  generator validation
backend/palserver_console/metadata/data/world-metadata-v1.json
        ↓
只读 runtime loader / API / frontend
```

现阶段不新增普通用户依赖，也不让页面或解析器直接耦合 FModel JSON 目录。现有
`backend/tools/generate_world_metadata.py`、`scripts/import-game-assets.ps1` 和
`scripts/sync-pal-catalog.ps1` 继续作为维护者侧入口；后续迁移只需替换或扩展 generator
输入适配层。所有资料以稳定 ID 为主键，官方中文缺失时保留 ID 并显示“资料未收录”，不得猜译。

建议后续真正启动全量迁移时新增一个 versioned source manifest，并让 generator 拒绝：

- 未记录游戏版本或工具版本的输入；
- SHA-256 与 manifest 不一致的 export；
- 重复稳定 ID、未知 localization key 或无来源的人工值；
- 运行时依赖 FModel 安装目录的输出。

## 普通用户检查与安装更新

- `GET /api/maintenance/application-update` 只读取固定仓库
  `yxymeng/PalserverConsole` 的 latest GitHub Release。
- “检查更新”不会写文件；“更新”只允许从控制台本机发起。
- 自动安装只支持 Windows portable。源码运行会提供 Release 链接，不执行自我覆盖。
- portable 会下载到自己的 `data/application-updates/`，校验包结构后退出控制台，调用
  `apply-downloaded-update.ps1` 与现有 `upgrade-portable.ps1`。
- 升级保留 `data/`，并沿用数据库备份、checksum、downgrade 阻止和 Program rollback。
- 该入口不更新 PalServer，不修改真实 `.sav`，也不允许普通用户生成或上传 metadata。

## v0.2.0 本地发布检查

1. 确认工作区只包含本轮内容，并完成全部 CI 等价检查。
2. 在干净提交上运行 `.\scripts\build-portable.ps1`。
3. 对 portable 根启动器执行 self-check，并用获准的真实存档做只读 smoke test。
4. 核对 `metadata/build-info.json`：版本为 `0.2.0`、`sourceTreeState` 为 `clean`。
5. 由维护者 push 后创建 tag `v0.2.0` 和 GitHub Release，上传 zip，并核对 Release Notes。
6. 用旧 portable 检查 latest Release；由于自更新入口从 v0.2.0 才开始提供，首次迁移到
   v0.2.0 仍需手工下载，后续版本可在控制台内直接升级。

## main 最小合并保护

工作流中的稳定必需检查名为 `Required checks`。维护者在 GitHub 仓库
Settings → Rules → Rulesets 为 `main` 配置：

- 合并前必须通过 pull request；
- required status check 选择 `Required checks`；
- 禁止 force push 和 branch deletion；
- 仓库写权限只授予维护者。

仓库内 workflow 只能提供检查，不能替代 GitHub 服务端 ruleset；本地分支不会自动修改远端设置。

