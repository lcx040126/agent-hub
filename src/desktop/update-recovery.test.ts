import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopUpdateManifest } from "./update-manifest.js";
import { FileDesktopUpdateRecovery } from "./update-recovery.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("desktop update recovery state", () => {
  it("keeps the last healthy installer while the next update is pending", async () => {
    const directory = await temporaryDirectory();
    const installer03 = path.join(directory, "download-03", "AgentHub-Setup-0.3.0-x64.exe");
    const installer04 = path.join(directory, "download-04", "AgentHub-Setup-0.4.0-x64.exe");
    const database = path.join(directory, "data", "agent-hub.sqlite");
    await writeFileWithParents(installer03, "installer-03");
    await writeFileWithParents(installer04, "installer-04");
    await writeFileWithParents(database, "database-before-update");

    const recovery = new FileDesktopUpdateRecovery(path.join(directory, "updates"));
    const first = await recovery.prepare({
      currentVersion: "0.2.0",
      manifest: manifest("0.3.0", "installer-03"),
      manifestSha256: "1".repeat(64),
      installerPath: installer03,
      backupFiles: [{ sourcePath: database, relativeName: "server/agent-hub.sqlite", required: true }],
    });
    expect(first.previousInstallerPath).toBeUndefined();
    await expect(readFile(path.join(first.backupDirectory!, "server", "agent-hub.sqlite"), "utf8"))
      .resolves.toBe("database-before-update");

    await recovery.markStartupHealthy("0.3.0");
    expect(await recovery.getPendingRecoveryPlan()).toBeUndefined();
    await expect(stat(first.installerPath)).resolves.toMatchObject({ size: 12 });

    const second = await recovery.prepare({
      currentVersion: "0.3.0",
      manifest: manifest("0.4.0", "installer-04"),
      manifestSha256: "2".repeat(64),
      installerPath: installer04,
      backupFiles: [{ sourcePath: database, relativeName: "server/agent-hub.sqlite", required: true }],
    });
    expect(second.previousInstallerPath).toBe(first.installerPath);
    await expect(recovery.getPendingRecoveryPlan()).resolves.toMatchObject({
      fromVersion: "0.3.0",
      targetVersion: "0.4.0",
      rollbackInstallerPath: first.installerPath,
      attemptedInstallerPath: second.installerPath,
    });
  });

  it("records failure and can abandon a launch that never replaced the application", async () => {
    const directory = await temporaryDirectory();
    const installer = path.join(directory, "AgentHub-Setup-0.3.0-x64.exe");
    await writeFile(installer, "installer-03");
    const recovery = new FileDesktopUpdateRecovery(path.join(directory, "updates"));
    await recovery.prepare({
      currentVersion: "0.2.0",
      manifest: manifest("0.3.0", "installer-03"),
      manifestSha256: "3".repeat(64),
      installerPath: installer,
    });
    await recovery.markPendingFailed("installer launch failed");
    expect(await recovery.getPendingRecoveryPlan()).toBeTruthy();
    await recovery.abandonPending();
    expect(await recovery.getPendingRecoveryPlan()).toBeUndefined();
  });

  it("binds a full application backup and an exact database restore target to one update", async () => {
    const directory = await temporaryDirectory();
    const installer = path.join(directory, "AgentHub-Setup-0.3.0-x64.exe");
    const applicationDirectory = path.join(directory, "installed", "Agent Hub");
    const executablePath = path.join(applicationDirectory, "Agent Hub.exe");
    const databaseRoot = path.join(directory, "user-data");
    const databasePath = path.join(databaseRoot, "server", "agent-hub.sqlite");
    await writeFile(installer, "installer-03");
    await writeFileWithParents(executablePath, "application-02");
    await writeFileWithParents(path.join(applicationDirectory, "resources", "app.asar"), "asar-02");
    await writeFileWithParents(databasePath, "database-02");

    const recovery = new FileDesktopUpdateRecovery(path.join(directory, "updates"));
    const prepared = await recovery.prepare({
      currentVersion: "0.2.0",
      manifest: manifest("0.3.0", "installer-03"),
      manifestSha256: "5".repeat(64),
      installerPath: installer,
      applicationDirectory,
      applicationExecutablePath: executablePath,
      restoreRootDirectory: databaseRoot,
      backupFiles: [{
        sourcePath: databasePath,
        relativeName: "server/agent-hub.sqlite",
        restorePath: databasePath,
        required: true,
      }],
    });

    await expect(readFile(path.join(prepared.applicationBackupDirectory!, "Agent Hub.exe"), "utf8"))
      .resolves.toBe("application-02");
    await expect(recovery.getPendingRecoveryPlan()).resolves.toMatchObject({
      applicationDirectory,
      applicationExecutablePath: executablePath,
      restoreRootDirectory: databaseRoot,
      restoreFiles: [{ restorePath: databasePath }],
    });
    await recovery.markStartupHealthy("0.3.0");
    await expect(stat(prepared.backupDirectory!)).resolves.toMatchObject({});
  });

  it("rejects backup paths that attempt directory traversal", async () => {
    const directory = await temporaryDirectory();
    const installer = path.join(directory, "AgentHub-Setup-0.3.0-x64.exe");
    const database = path.join(directory, "agent-hub.sqlite");
    await writeFile(installer, "installer-03");
    await writeFile(database, "db");
    const recovery = new FileDesktopUpdateRecovery(path.join(directory, "updates"));
    await expect(recovery.prepare({
      currentVersion: "0.2.0",
      manifest: manifest("0.3.0", "installer-03"),
      manifestSha256: "4".repeat(64),
      installerPath: installer,
      backupFiles: [{ sourcePath: database, relativeName: "../outside.sqlite", required: true }],
    })).rejects.toThrow(/backup path/i);
  });
});

function manifest(version: string, contents: string): DesktopUpdateManifest {
  return {
    formatVersion: 1,
    product: "agent-hub",
    channel: "stable",
    repository: "lcx040126/agent-hub",
    version,
    publishedAt: "2026-08-26T12:00:00.000Z",
    protocolVersion: 1,
    minimumSourceProtocolVersion: 1,
    schemaVersion: 2,
    minimumSourceSchemaVersion: 2,
    asset: {
      fileName: `AgentHub-Setup-${version}-x64.exe`,
      url: `https://github.com/lcx040126/agent-hub/releases/download/v${version}/AgentHub-Setup-${version}-x64.exe`,
      sizeBytes: Buffer.byteLength(contents),
      sha256: createHash("sha256").update(contents).digest("hex"),
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-update-recovery-"));
  directories.push(directory);
  return directory;
}

async function writeFileWithParents(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value);
}
