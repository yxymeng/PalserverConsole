import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("备份页提供恢复事务的继续和回滚操作", () => {
  const pagePath = fileURLToPath(new URL("./BackupsPage.tsx", import.meta.url));
  const source = readFileSync(pagePath, "utf8");

  expect(source).toContain('requestJson<RestoreRecovery>("/api/backups/restore/recovery"');
  expect(source).toContain("const [recovery, setRecovery] = useState<RestoreRecovery | null>(null);");
  expect(source).not.toContain("const recovery = data?.restoreRecovery");
  expect(source).toContain("sourceBackupId");
  expect(source).toContain("继续恢复");
  expect(source).toContain("回滚");
  expect(source).toContain("/api/backups/restore/resume");
  expect(source).toContain("/api/backups/restore/rollback");
  expect(source).toContain('"X-CSRF-Token"');
  expect(source).toContain("await Promise.allSettled([loadBackups(), loadRecovery()])");
});

test("备份列表失败时独立恢复状态仍保留恢复操作", () => {
  const pagePath = fileURLToPath(new URL("./BackupsPage.tsx", import.meta.url));
  const source = readFileSync(pagePath, "utf8");

  expect(source).toContain('requestJson<BackupResponse>("/api/backups"');
  expect(source).toContain("setBackupError");
  expect(source).toContain("setRecovery(next)");
  expect(source).toContain("recovery?.active");
  expect(source).toContain("当前 phase：");
  expect(source).toContain("sourceBackupId：");
  expect(source).toContain("journalError");
  expect(source).toContain("/api/backups/restore/resume");
  expect(source).toContain("/api/backups/restore/rollback");
});
