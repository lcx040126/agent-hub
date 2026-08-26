import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { PendingRecoveryPlan } from "./update-recovery.js";
import { WindowsUpdateRecoveryExecutor } from "./windows-update-watchdog.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Windows update recovery watchdog", () => {
  it.skipIf(process.platform !== "win32")(
    "does not arm until PowerShell validates recovery inputs and reports a live heartbeat",
    async () => {
      const directory = path.join(await temporaryDirectory(), "Agent & Hub");
      const recoveryRoot = path.join(directory, "updates");
      const applicationDirectory = path.join(directory, "installed", "Agent Hub");
      const applicationBackupDirectory = path.join(recoveryRoot, "backups", "update-03", "application");
      const applicationExecutablePath = path.join(applicationDirectory, "Agent Hub.exe");
      const databaseRoot = path.join(directory, "user-data");
      const databasePath = path.join(databaseRoot, "server", "agent-hub.sqlite");
      const databaseBackupPath = path.join(recoveryRoot, "backups", "update-03", "server", "agent-hub.sqlite");
      const statePath = path.join(recoveryRoot, "state.json");
      await write(applicationExecutablePath, "new-version");
      await write(path.join(applicationBackupDirectory, "Agent Hub.exe"), "old-version");
      await write(databasePath, "new-database");
      await write(databaseBackupPath, "old-database");
      await write(statePath, JSON.stringify({
        formatVersion: 1,
        pending: { fromVersion: "0.2.0", targetVersion: "0.3.0" },
      }));

      const executor = new WindowsUpdateRecoveryExecutor(recoveryRoot, {
        timeoutSeconds: 30,
        restartExecutable: false,
        handshakeTimeoutMs: 10_000,
      });
      await executor.arm(plan({
        applicationDirectory,
        applicationBackupDirectory,
        applicationExecutablePath,
        databaseRoot,
        databasePath,
        databaseBackupPath,
        recoveryRoot,
      }));

      const activePath = path.join(recoveryRoot, "watchdog-active.json");
      const active = JSON.parse(await readFile(activePath, "utf8")) as {
        readyMarkerPath: string;
        heartbeatMarkerPath: string;
      };
      const readyMarker = JSON.parse(await readFile(active.readyMarkerPath, "utf8")) as {
        targetVersion: string;
      };
      const heartbeatMarker = JSON.parse(await readFile(active.heartbeatMarkerPath, "utf8")) as {
        sequence: number;
      };
      expect(readyMarker.targetVersion).toBe("0.3.0");
      expect(heartbeatMarker.sequence).toBeGreaterThanOrEqual(1);

      await executor.disarm("0.3.0");
      await waitUntilMissing(activePath);
    },
    15_000,
  );

  it.skipIf(process.platform !== "win32")(
    "rejects an early watchdog exit when a required recovery backup is missing",
    async () => {
      const directory = await temporaryDirectory();
      const recoveryRoot = path.join(directory, "updates");
      const applicationDirectory = path.join(directory, "installed", "Agent Hub");
      const applicationBackupDirectory = path.join(recoveryRoot, "backups", "update-03", "application");
      const applicationExecutablePath = path.join(applicationDirectory, "Agent Hub.exe");
      const databaseRoot = path.join(directory, "user-data");
      const databasePath = path.join(databaseRoot, "server", "agent-hub.sqlite");
      const missingDatabaseBackupPath = path.join(recoveryRoot, "backups", "update-03", "server", "missing.sqlite");
      const statePath = path.join(recoveryRoot, "state.json");
      await write(applicationExecutablePath, "current-version");
      await write(path.join(applicationBackupDirectory, "Agent Hub.exe"), "old-version");
      await write(databasePath, "current-database");
      await write(statePath, JSON.stringify({
        formatVersion: 1,
        pending: { fromVersion: "0.2.0", targetVersion: "0.3.0" },
      }));

      const executor = new WindowsUpdateRecoveryExecutor(recoveryRoot, {
        timeoutSeconds: 30,
        restartExecutable: false,
        handshakeTimeoutMs: 10_000,
      });
      await expect(executor.arm(plan({
        applicationDirectory,
        applicationBackupDirectory,
        applicationExecutablePath,
        databaseRoot,
        databasePath,
        databaseBackupPath: missingDatabaseBackupPath,
        recoveryRoot,
      }))).rejects.toThrow(/failed before it was ready.*backup is missing/i);

      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      expect(state.pending).toMatchObject({ fromVersion: "0.2.0", targetVersion: "0.3.0" });
      await expect(stat(path.join(recoveryRoot, "watchdog-active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    },
    15_000,
  );

  it.skipIf(process.platform !== "win32")(
    "continues recovery after the process that armed the watchdog exits",
    async () => {
      const directory = await temporaryDirectory();
      const recoveryRoot = path.join(directory, "updates");
      const applicationDirectory = path.join(directory, "installed", "Agent Hub");
      const applicationBackupDirectory = path.join(recoveryRoot, "backups", "update-03", "application");
      const applicationExecutablePath = path.join(applicationDirectory, "Agent Hub.exe");
      const databaseRoot = path.join(directory, "user-data");
      const databasePath = path.join(databaseRoot, "server", "agent-hub.sqlite");
      const databaseBackupPath = path.join(recoveryRoot, "backups", "update-03", "server", "agent-hub.sqlite");
      const statePath = path.join(recoveryRoot, "state.json");
      const helperPath = path.join(directory, "arm-watchdog.mts");
      const helperInputPath = path.join(directory, "arm-watchdog-input.json");
      const recoveryPlan = plan({
        applicationDirectory,
        applicationBackupDirectory,
        applicationExecutablePath,
        databaseRoot,
        databasePath,
        databaseBackupPath,
        recoveryRoot,
      });
      await write(applicationExecutablePath, "broken-new-version");
      await write(path.join(applicationBackupDirectory, "Agent Hub.exe"), "healthy-old-version");
      await write(databasePath, "migrated-database");
      await write(databaseBackupPath, "pre-update-database");
      await write(statePath, JSON.stringify({
        formatVersion: 1,
        pending: { fromVersion: "0.2.0", targetVersion: "0.3.0" },
      }));
      await write(helperInputPath, JSON.stringify({ recoveryRoot, recoveryPlan }));
      const watchdogModuleUrl = pathToFileURL(path.resolve("src/desktop/windows-update-watchdog.ts")).href;
      await write(helperPath, `
import { readFile } from "node:fs/promises";
import { WindowsUpdateRecoveryExecutor } from ${JSON.stringify(watchdogModuleUrl)};
const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const executor = new WindowsUpdateRecoveryExecutor(input.recoveryRoot, {
  timeoutSeconds: 5,
  restartExecutable: false,
  handshakeTimeoutMs: 10_000,
});
await executor.arm(input.recoveryPlan);
`);

      await execFileAsync(process.execPath, [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        helperPath,
        helperInputPath,
      ], { timeout: 15_000 });

      const activePath = path.join(recoveryRoot, "watchdog-active.json");
      const active = JSON.parse(await readFile(activePath, "utf8")) as { resultPath: string };
      await waitUntilMissing(activePath, 12_000);
      const result = JSON.parse(await readFile(active.resultPath, "utf8")) as { status: string };
      expect(result.status).toBe("rolled-back");
      await expect(readFile(applicationExecutablePath, "utf8")).resolves.toBe("healthy-old-version");
      await expect(readFile(databasePath, "utf8")).resolves.toBe("pre-update-database");
    },
    20_000,
  );

  it.skipIf(process.platform !== "win32")(
    "supersedes an existing watchdog before re-arming recovery",
    async () => {
      const directory = await temporaryDirectory();
      const recoveryRoot = path.join(directory, "updates");
      const applicationDirectory = path.join(directory, "installed", "Agent Hub");
      const applicationBackupDirectory = path.join(recoveryRoot, "backups", "update-03", "application");
      const applicationExecutablePath = path.join(applicationDirectory, "Agent Hub.exe");
      const databaseRoot = path.join(directory, "user-data");
      const databasePath = path.join(databaseRoot, "server", "agent-hub.sqlite");
      const databaseBackupPath = path.join(recoveryRoot, "backups", "update-03", "server", "agent-hub.sqlite");
      const launches: string[] = [];
      const executor = new WindowsUpdateRecoveryExecutor(recoveryRoot, {
        restartExecutable: false,
        launch: async (input) => { launches.push(input.recoveryId); },
      });
      const recoveryPlan = plan({
        applicationDirectory,
        applicationBackupDirectory,
        applicationExecutablePath,
        databaseRoot,
        databasePath,
        databaseBackupPath,
        recoveryRoot,
      });

      await executor.arm(recoveryPlan);
      const activePath = path.join(recoveryRoot, "watchdog-active.json");
      const firstActive = JSON.parse(await readFile(activePath, "utf8")) as {
        recoveryId: string;
        healthMarkerPath: string;
      };

      await executor.arm(recoveryPlan, { replaceExisting: true });
      const secondActive = JSON.parse(await readFile(activePath, "utf8")) as {
        recoveryId: string;
      };
      const superseded = JSON.parse(await readFile(firstActive.healthMarkerPath, "utf8")) as {
        recoveryId: string;
        status: string;
      };

      expect(launches).toHaveLength(2);
      expect(secondActive.recoveryId).not.toBe(firstActive.recoveryId);
      expect(superseded).toMatchObject({
        recoveryId: firstActive.recoveryId,
        status: "superseded",
      });
    },
  );

  it.skipIf(process.platform !== "win32")(
    "restores the previous application and only the bound database after startup timeout",
    async () => {
      const directory = await temporaryDirectory();
      const recoveryRoot = path.join(directory, "updates");
      const applicationDirectory = path.join(directory, "installed", "Agent Hub");
      const applicationBackupDirectory = path.join(recoveryRoot, "backups", "update-03", "application");
      const applicationExecutablePath = path.join(applicationDirectory, "Agent Hub.exe");
      const databaseRoot = path.join(directory, "user-data");
      const databasePath = path.join(databaseRoot, "server", "agent-hub.sqlite");
      const databaseBackupPath = path.join(recoveryRoot, "backups", "update-03", "server", "agent-hub.sqlite");
      const untouchedUserFile = path.join(databaseRoot, "connections.json");
      const statePath = path.join(recoveryRoot, "state.json");

      await write(applicationExecutablePath, "broken-new-version");
      await write(path.join(applicationDirectory, "resources", "version.txt"), "0.3.0");
      await write(path.join(applicationBackupDirectory, "Agent Hub.exe"), "healthy-old-version");
      await write(path.join(applicationBackupDirectory, "resources", "version.txt"), "0.2.0");
      await write(databasePath, "migrated-database");
      await write(databaseBackupPath, "pre-update-database");
      await write(untouchedUserFile, "member-connections-must-not-change");
      await write(statePath, JSON.stringify({
        formatVersion: 1,
        pending: { fromVersion: "0.2.0", targetVersion: "0.3.0" },
      }));

      let scriptPath = "";
      let planPath = "";
      const executor = new WindowsUpdateRecoveryExecutor(recoveryRoot, {
        timeoutSeconds: 0,
        restartExecutable: false,
        launch: async (input) => {
          scriptPath = input.scriptPath;
          planPath = input.planPath;
        },
      });
      await executor.arm(plan({
        applicationDirectory,
        applicationBackupDirectory,
        applicationExecutablePath,
        databaseRoot,
        databasePath,
        databaseBackupPath,
        recoveryRoot,
      }));
      const watchdogPlan = JSON.parse(await readFile(planPath, "utf8")) as { resultPath: string };

      try {
        await execFileAsync("powershell.exe", [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-PlanPath",
          planPath,
        ]);
      } catch (error) {
        const result = await readFile(watchdogPlan.resultPath, "utf8").catch(() => "no watchdog result");
        const state = await readFile(statePath, "utf8").catch(() => "no recovery state");
        const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
        throw new Error(`Watchdog failed unexpectedly: ${stderr}\n${result}\n${state}`);
      }

      await expect(readFile(applicationExecutablePath, "utf8")).resolves.toBe("healthy-old-version");
      await expect(readFile(path.join(applicationDirectory, "resources", "version.txt"), "utf8"))
        .resolves.toBe("0.2.0");
      await expect(readFile(databasePath, "utf8")).resolves.toBe("pre-update-database");
      await expect(readFile(untouchedUserFile, "utf8"))
        .resolves.toBe("member-connections-must-not-change");
      await expect(stat(applicationBackupDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(watchdogPlan.resultPath, "utf8")).resolves.toContain("rolled-back");
      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      expect(state.pending).toBeNull();
      expect(state.lastResult).toMatchObject({ status: "failed", version: "0.3.0" });
    },
    20_000,
  );

  it.skipIf(process.platform !== "win32")(
    "disarms the matching watchdog when the new version reports healthy",
    async () => {
      const directory = await temporaryDirectory();
      const recoveryRoot = path.join(directory, "updates");
      const applicationDirectory = path.join(directory, "installed", "Agent Hub");
      const applicationBackupDirectory = path.join(recoveryRoot, "backups", "update-03", "application");
      const applicationExecutablePath = path.join(applicationDirectory, "Agent Hub.exe");
      const databaseRoot = path.join(directory, "user-data");
      const databasePath = path.join(databaseRoot, "server", "agent-hub.sqlite");
      const databaseBackupPath = path.join(recoveryRoot, "backups", "update-03", "server", "agent-hub.sqlite");
      await write(applicationExecutablePath, "new-version");
      await write(path.join(applicationBackupDirectory, "Agent Hub.exe"), "old-version");
      await write(databasePath, "new-database");
      await write(databaseBackupPath, "old-database");

      let planPath = "";
      const executor = new WindowsUpdateRecoveryExecutor(recoveryRoot, {
        launch: async (input) => { planPath = input.planPath; },
      });
      await executor.arm(plan({
        applicationDirectory,
        applicationBackupDirectory,
        applicationExecutablePath,
        databaseRoot,
        databasePath,
        databaseBackupPath,
        recoveryRoot,
      }));
      const watchdogPlan = JSON.parse(await readFile(planPath, "utf8")) as { healthMarkerPath: string };
      await executor.disarm("0.3.0");
      await expect(readFile(watchdogPlan.healthMarkerPath, "utf8")).resolves.toContain('"healthyVersion": "0.3.0"');
    },
  );

  it.skipIf(process.platform !== "win32")(
    "records rollback failure, reverses the application swap, and preserves recovery backups",
    async () => {
      const directory = await temporaryDirectory();
      const recoveryRoot = path.join(directory, "updates");
      const applicationDirectory = path.join(directory, "installed", "Agent Hub");
      const applicationBackupDirectory = path.join(recoveryRoot, "backups", "update-03", "application");
      const applicationExecutablePath = path.join(applicationDirectory, "Agent Hub.exe");
      const databaseRoot = path.join(directory, "user-data");
      const databasePath = path.join(databaseRoot, "server", "agent-hub.sqlite");
      const missingDatabaseBackupPath = path.join(recoveryRoot, "backups", "update-03", "server", "missing.sqlite");
      const statePath = path.join(recoveryRoot, "state.json");

      await write(applicationExecutablePath, "broken-new-version");
      await write(path.join(applicationDirectory, "resources", "version.txt"), "0.3.0");
      await write(path.join(applicationBackupDirectory, "Agent Hub.exe"), "healthy-old-version");
      await write(path.join(applicationBackupDirectory, "resources", "version.txt"), "0.2.0");
      await write(databasePath, "migrated-database");
      await write(statePath, JSON.stringify({
        formatVersion: 1,
        pending: { fromVersion: "0.2.0", targetVersion: "0.3.0" },
      }));

      let scriptPath = "";
      let planPath = "";
      const executor = new WindowsUpdateRecoveryExecutor(recoveryRoot, {
        timeoutSeconds: 0,
        restartExecutable: false,
        launch: async (input) => {
          scriptPath = input.scriptPath;
          planPath = input.planPath;
        },
      });
      await executor.arm(plan({
        applicationDirectory,
        applicationBackupDirectory,
        applicationExecutablePath,
        databaseRoot,
        databasePath,
        databaseBackupPath: missingDatabaseBackupPath,
        recoveryRoot,
      }));
      const watchdogPlan = JSON.parse(await readFile(planPath, "utf8")) as { resultPath: string };

      await expect(execFileAsync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-PlanPath",
        planPath,
      ])).rejects.toBeDefined();

      await expect(readFile(applicationExecutablePath, "utf8")).resolves.toBe("broken-new-version");
      await expect(readFile(path.join(applicationDirectory, "resources", "version.txt"), "utf8"))
        .resolves.toBe("0.3.0");
      await expect(readFile(databasePath, "utf8")).resolves.toBe("migrated-database");
      await expect(readFile(path.join(applicationBackupDirectory, "Agent Hub.exe"), "utf8"))
        .resolves.toBe("healthy-old-version");
      await expect(readFile(watchdogPlan.resultPath, "utf8")).resolves.toContain("rollback-failed");
      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      expect(state.pending).toMatchObject({ fromVersion: "0.2.0", targetVersion: "0.3.0" });
      expect(state.lastResult).toMatchObject({ status: "failed", version: "0.3.0" });
    },
    20_000,
  );
});

function plan(input: {
  applicationDirectory: string;
  applicationBackupDirectory: string;
  applicationExecutablePath: string;
  databaseRoot: string;
  databasePath: string;
  databaseBackupPath: string;
  recoveryRoot: string;
}): PendingRecoveryPlan {
  return {
    fromVersion: "0.2.0",
    targetVersion: "0.3.0",
    attemptedInstallerPath: path.join(input.recoveryRoot, "packages", "0.3.0", "AgentHub-Setup-0.3.0-x64.exe"),
    applicationDirectory: input.applicationDirectory,
    applicationBackupDirectory: input.applicationBackupDirectory,
    applicationExecutablePath: input.applicationExecutablePath,
    restoreRootDirectory: input.databaseRoot,
    restoreFiles: [{ backupPath: input.databaseBackupPath, restorePath: input.databasePath }],
    preparedAt: "2026-08-26T12:00:00.000Z",
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-watchdog-"));
  directories.push(directory);
  return directory;
}

async function write(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value);
}

async function waitUntilMissing(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(filePath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${filePath} to be removed.`);
}
