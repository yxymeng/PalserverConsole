# Windows 便携版

Windows 便携版由 64 位 CPython 3.13 构建，并在 `Program/` 内自带 Python runtime、后端依赖和已构建的前端页面。普通使用者不需要安装 Python 或 Node.js。

## 启动

1. 解压整个发布压缩包到一个可写的本地目录，例如 `D:\Apps\PalServerConsole`；不要只复制 `Program/`。
2. 双击根目录的 `PalServerConsole.exe`；它会启动 `Program/` 内的程序并打开默认浏览器。`start-console.bat` 仅保留为故障排查备用入口。
3. 服务就绪后会打开默认浏览器；本机地址通常为 `http://127.0.0.1:8223/`。

如果 `8223` 已被 PalworldPanel 等其他程序占用，控制台不会与它共享端口或覆盖原页面，而是仅在本次运行改用 `18223` 并打开 `http://127.0.0.1:18223/`；已保存的端口设置不会被自动改写。若 `18223` 也被占用，启动器会保留英文 `Ports ... are already in use` 错误。

不要从 `Program/` 中移动、删除或单独替换 `_internal/` 文件。首次运行产生的数据库、日志、草稿和缓存都位于根目录的 `data/`，不位于 `Program/`。

## 校验与签名状态

发布包根目录的 `checksums.sha256` 用于核对下载或复制过程中是否损坏。它覆盖 `Program/`、构建元数据、启动器和许可证文件，故意不覆盖会持续变化的 `data/`。升级脚本要求清单与包内非数据文件完全一致；缺少、被修改或额外追加的程序文件都会阻止升级。

当前便携包为**未签名**交付物。`checksums.sha256` 只能发现意外损坏或与发布方另行提供的 hash 不一致，不能替代 Authenticode 身份验证；在实际签名完成前，不得把它描述为“已签名”或“受 Windows 信任”。

`metadata\build-info.json` 同时记录 Git revision 和 `sourceTreeState`。正式发布包必须为 `clean`；显式使用 `-AllowDirtySource` 生成的 `dirty` 包只用于本地验收，不得发布。

## 升级与回退

1. 关闭 PalServerConsole，确认 `PalServerConsole.exe` 没有继续运行。
2. 将新版本压缩包解压到另一个目录，保留旧安装目录不动。
3. 在旧安装目录运行：

   ```powershell
   .\upgrade-portable.ps1 -NewPackage "D:\Downloads\PalServerConsole-新版本"
   ```

4. 脚本会先校验新包 `checksums.sha256`，读取新包支持的数据库 schema 上限，并在 `data\upgrade-backups\<时间戳>\` 复制 `app.db`。之后替换根目录启动器和 `Program/`，绝不替换或删除 `data/`。

如果现有 `app.db` 的 schema 比候选版本更新，脚本会以 `INCOMPATIBLE_DOWNGRADE` 拒绝降级，旧程序保持不变。升级的文件校验或替换失败时，脚本会自动恢复旧启动器和旧 `Program/`，并保留数据库备份。成功升级后，旧程序保留在根目录 `program-backups/Program-<时间戳>`，旧启动器保存为 `program-backups/PalServerConsole-<时间戳>.exe`；人工回退时需要同时恢复两者，不要回退或覆盖 `data/`。

若出现 `DATABASE_SIDECAR_PRESENT`，请先按正常方式启动一次旧控制台、再停止它，确保 SQLite WAL/journal 已安全收尾后再升级。不要在升级过程中复制、删除或替换真实 PalServer 存档。
