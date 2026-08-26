import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { installHeadlessLauncher } from "./headless-launcher.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe.runIf(process.platform === "win32")("headless launcher integration", () => {
  it("runs Electron as Node and preserves redirected stdin/stdout", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-launcher-"));
    temporaryDirectories.push(directory);
    const launcherPath = path.join(directory, "agent-hub-headless.ps1");
    const electron = fileURLToPath(new URL("../../node_modules/electron/dist/electron.exe", import.meta.url));
    const fixture = fileURLToPath(new URL("../../test-fixtures/stdin-echo.cjs", import.meta.url));
    await installHeadlessLauncher({
      launcherPath,
      electronExecutable: electron,
      runnerPath: fixture,
      userDataPath: directory,
    });

    const result = spawnSync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
      "--probe",
    ], {
      input: "hook-json-from-codex",
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      nodeMode: "1",
      input: "hook-json-from-codex",
      arguments: ["--user-data", directory, "--probe"],
    });
  }, 30_000);
});
