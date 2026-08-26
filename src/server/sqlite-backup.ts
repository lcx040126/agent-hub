import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export async function createConsistentSqliteBackup(
  connection: DatabaseSync,
  destination: string,
): Promise<string> {
  const target = path.resolve(destination);
  await mkdir(path.dirname(target), { recursive: true });
  await rm(target, { force: true });
  connection.exec("PRAGMA wal_checkpoint(PASSIVE)");
  connection.exec(`VACUUM INTO '${escapeSqliteString(target)}'`);
  return target;
}

function escapeSqliteString(value: string): string {
  if (value.includes("\0")) throw new Error("SQLite backup path cannot contain a NUL character.");
  return value.replaceAll("'", "''");
}
