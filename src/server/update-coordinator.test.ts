import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UpdateCoordinator } from "./update-coordinator.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("UpdateCoordinator", () => {
  it("checks a newer manifest and stages a package after SHA-256 validation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-update-"));
    directories.push(directory);
    const bytes = new TextEncoder().encode("agent-hub-update");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const coordinator = new UpdateCoordinator({
      currentVersion: "0.1.0",
      manifestUrl: "https://updates.example.test/manifest.json",
      stagingDirectory: path.join(directory, "staged"),
      fetchImpl: async (input) => new Response(String(input).endsWith("manifest.json") ? JSON.stringify({ version: "0.2.0", protocolVersion: 1, schemaVersion: 2, packageUrl: "https://updates.example.test/package.bin", sha256, sizeBytes: bytes.byteLength }) : bytes),
    });
    await expect(coordinator.check()).resolves.toMatchObject({ state: "available", availableVersion: "0.2.0" });
    await expect(coordinator.stage()).resolves.toMatchObject({ state: "staged" });
    const staged = await readFile(coordinator.getStatus().stagedPath!);
    expect(staged.toString()).toBe("agent-hub-update");
  });

  it("rejects a package with a mismatched digest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-update-"));
    directories.push(directory);
    const coordinator = new UpdateCoordinator({
      manifestUrl: "https://updates.example.test/manifest.json",
      stagingDirectory: path.join(directory, "staged"),
      fetchImpl: async (input) => new Response(String(input).endsWith("manifest.json") ? JSON.stringify({ version: "0.2.0", protocolVersion: 1, schemaVersion: 2, packageUrl: "https://updates.example.test/package.bin", sha256: "0".repeat(64) }) : "tampered"),
    });
    await coordinator.check();
    await expect(coordinator.stage()).resolves.toMatchObject({ state: "failed" });
    expect(coordinator.getStatus().error).toContain("SHA-256");
  });

  it("backs up a file database before an update", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-update-"));
    directories.push(directory);
    const databasePath = path.join(directory, "agent-hub.sqlite");
    await writeFile(databasePath, "sqlite-placeholder");
    const coordinator = new UpdateCoordinator({ stagingDirectory: path.join(directory, "staged"), databasePath });
    const backup = await coordinator.backupDatabase();
    expect(backup).toBeTruthy();
    await expect(readFile(backup!)).resolves.toEqual(Buffer.from("sqlite-placeholder"));
  });
});
