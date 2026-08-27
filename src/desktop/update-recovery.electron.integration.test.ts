import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopUpdateManifest } from "./update-manifest.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe.runIf(process.platform === "win32")("desktop update recovery Electron integration", () => {
  it("backs up a physical ASAR with identical bytes and persists the pending plan", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-update-recovery-electron-"));
    temporaryDirectories.push(directory);

    const applicationDirectory = path.join(directory, "installed", "Agent Hub");
    const applicationExecutablePath = path.join(applicationDirectory, "Agent Hub.exe");
    const sourceAsarPath = path.join(applicationDirectory, "resources", "app.asar");
    const installerPath = path.join(directory, "AgentHub-Setup-0.3.0-x64.exe");
    const recoveryRoot = path.join(directory, "updates");
    const installerContents = "installer-03";
    const electronDefaultAsar = path.resolve(
      path.dirname(electronExecutable()),
      "resources",
      "default_app.asar",
    );

    await mkdir(path.dirname(sourceAsarPath), { recursive: true });
    await writeFile(applicationExecutablePath, "application-02");
    await copyFile(electronDefaultAsar, sourceAsarPath);
    await writeFile(installerPath, installerContents);

    const manifest = updateManifest(installerContents);
    const childScript = `
      const { FileDesktopUpdateRecovery } = await import(process.env.AGENT_HUB_TEST_RECOVERY_MODULE);
      const recovery = new FileDesktopUpdateRecovery(process.env.AGENT_HUB_TEST_RECOVERY_ROOT);
      const prepared = await recovery.prepare({
        currentVersion: "0.2.0",
        manifest: JSON.parse(process.env.AGENT_HUB_TEST_MANIFEST),
        manifestSha256: "5".repeat(64),
        installerPath: process.env.AGENT_HUB_TEST_INSTALLER,
        applicationDirectory: process.env.AGENT_HUB_TEST_APPLICATION,
        applicationExecutablePath: process.env.AGENT_HUB_TEST_EXECUTABLE,
      });
      const pending = await recovery.getPendingRecoveryPlan();
      process.stdout.write("AGENT_HUB_RECOVERY_RESULT=" + JSON.stringify({ prepared, pending }) + "\\n");
    `;
    const childScriptPath = path.join(directory, "recovery-probe.mjs");
    await writeFile(childScriptPath, childScript);
    const result = spawnSync(electronExecutable(), [
      "--import",
      tsxLoaderUrl(),
      childScriptPath,
    ], {
      cwd: path.resolve(import.meta.dirname, "..", ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        AGENT_HUB_TEST_RECOVERY_MODULE: pathToFileURL(
          path.join(import.meta.dirname, "update-recovery.ts"),
        ).href,
        AGENT_HUB_TEST_RECOVERY_ROOT: recoveryRoot,
        AGENT_HUB_TEST_MANIFEST: JSON.stringify(manifest),
        AGENT_HUB_TEST_INSTALLER: installerPath,
        AGENT_HUB_TEST_APPLICATION: applicationDirectory,
        AGENT_HUB_TEST_EXECUTABLE: applicationExecutablePath,
      },
      timeout: 30_000,
      windowsHide: true,
    });

    const diagnostic = [result.stdout, result.stderr].filter(Boolean).join("\n");
    expect(result.error, diagnostic).toBeUndefined();
    expect(result.status, diagnostic).toBe(0);

    const resultLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("AGENT_HUB_RECOVERY_RESULT="));
    expect(resultLine, diagnostic).toBeDefined();
    const recoveryResult = JSON.parse(resultLine!.slice("AGENT_HUB_RECOVERY_RESULT=".length)) as {
      prepared: { applicationBackupDirectory?: string };
      pending?: {
        targetVersion: string;
        applicationDirectory?: string;
        applicationBackupDirectory?: string;
      };
    };

    expect(recoveryResult.pending).toMatchObject({
      targetVersion: "0.3.0",
      applicationDirectory,
      applicationBackupDirectory: recoveryResult.prepared.applicationBackupDirectory,
    });
    const copiedAsarPath = path.join(
      recoveryResult.prepared.applicationBackupDirectory!,
      "resources",
      "app.asar",
    );
    await expect(stat(copiedAsarPath)).resolves.toMatchObject({
      size: (await stat(sourceAsarPath)).size,
    });
    expect((await stat(copiedAsarPath)).isFile()).toBe(true);
    await expect(sha256(copiedAsarPath)).resolves.toBe(await sha256(sourceAsarPath));
  }, 40_000);
});

function electronExecutable(): string {
  return path.resolve(import.meta.dirname, "..", "..", "node_modules", "electron", "dist", "electron.exe");
}

function tsxLoaderUrl(): string {
  return pathToFileURL(path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "node_modules",
    "tsx",
    "dist",
    "loader.mjs",
  )).href;
}

function updateManifest(installerContents: string): DesktopUpdateManifest {
  return {
    formatVersion: 1,
    product: "agent-hub",
    channel: "stable",
    repository: "lcx040126/agent-hub",
    version: "0.3.0",
    publishedAt: "2026-08-27T12:00:00.000Z",
    protocolVersion: 1,
    minimumSourceProtocolVersion: 1,
    schemaVersion: 3,
    minimumSourceSchemaVersion: 2,
    asset: {
      fileName: "AgentHub-Setup-0.3.0-x64.exe",
      url: "https://github.com/lcx040126/agent-hub/releases/download/v0.3.0/AgentHub-Setup-0.3.0-x64.exe",
      sizeBytes: Buffer.byteLength(installerContents),
      sha256: createHash("sha256").update(installerContents).digest("hex"),
    },
  };
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}
