import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createConsistentSqliteBackup } from "./sqlite-backup.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SQLite consistent backup", () => {
  it("includes committed WAL data and can be opened independently", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-sqlite-backup-"));
    directories.push(directory);
    const sourcePath = path.join(directory, "source.sqlite");
    const destination = path.join(directory, "backup", "room.sqlite");
    const source = new DatabaseSync(sourcePath);
    source.exec("PRAGMA journal_mode = WAL");
    source.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    source.prepare("INSERT INTO records(value) VALUES (?)").run("room data that must survive");

    await createConsistentSqliteBackup(source, destination);
    const backup = new DatabaseSync(destination, { readOnly: true });
    expect(backup.prepare("SELECT value FROM records").get()).toEqual({ value: "room data that must survive" });
    backup.close();
    source.close();
  });
});
