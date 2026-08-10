import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("备份页提供恢复事务的继续和回滚操作", () => {
  const pagePath = fileURLToPath(new URL("./BackupsPage.tsx", import.meta.url));
  const source = readFileSync(pagePath, "utf8");

  expect(source).toContain("restoreRecovery");
  expect(source).toContain("sourceBackupId");
  expect(source).toContain("继续恢复");
  expect(source).toContain("回滚");
  expect(source).toContain("/api/backups/restore/resume");
  expect(source).toContain("/api/backups/restore/rollback");
  expect(source).toContain('"X-CSRF-Token"');
  expect(source).toContain("await load()");
});
