import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { applyDatabaseMigrations } from "../packages/research-agent/dist/index.js";

test("component migrations are append-only and transactional", async () => {
  const directory = await mkdtemp(join(tmpdir(), "honeycrisp-migrations-"));
  const database = new DatabaseSync(join(directory, "memory.sqlite"));
  try {
    applyDatabaseMigrations(database, "fixture", [{
      version: 1,
      name: "baseline",
      up(target) {
        target.exec("CREATE TABLE durable_rows (id TEXT PRIMARY KEY); INSERT INTO durable_rows VALUES ('preserved');");
      },
    }]);

    assert.throws(() => applyDatabaseMigrations(database, "fixture", [
      { version: 1, name: "baseline", up() {} },
      {
        version: 2,
        name: "broken_change",
        up(target) {
          target.exec("INSERT INTO durable_rows VALUES ('rolled_back');");
          throw new Error("fixture failure");
        },
      },
    ]), /broken_change/);
    assert.deepEqual(database.prepare("SELECT id FROM durable_rows ORDER BY id").all().map((row) => ({ ...row })), [{ id: "preserved" }]);
    assert.deepEqual(database.prepare("SELECT version, name FROM schema_migrations WHERE component = 'fixture'").all().map((row) => ({ ...row })), [{ version: 1, name: "baseline" }]);
    assert.throws(() => applyDatabaseMigrations(database, "fixture", [{ version: 1, name: "renamed", up() {} }]), /renamed/);
    assert.throws(() => applyDatabaseMigrations(database, "gap", [{ version: 2, name: "missing_baseline", up() {} }]), /contiguous/);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
