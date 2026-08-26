import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface InstallHeadlessLauncherOptions {
  launcherPath: string;
  electronExecutable: string;
  runnerPath: string;
  userDataPath: string;
}

export async function installHeadlessLauncher(
  options: InstallHeadlessLauncherOptions,
): Promise<string> {
  const launcherPath = path.resolve(options.launcherPath);
  const script = renderHeadlessLauncher(options);
  await mkdir(path.dirname(launcherPath), { recursive: true, mode: 0o700 });
  const temporary = `${launcherPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, script, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, launcherPath);
    await chmod(launcherPath, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return launcherPath;
}

export function renderHeadlessLauncher(options: InstallHeadlessLauncherOptions): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$env:ELECTRON_RUN_AS_NODE = '1'",
    `& '${quotePowerShell(options.electronExecutable)}' '${quotePowerShell(options.runnerPath)}' '--user-data' '${quotePowerShell(options.userDataPath)}' @args`,
    "exit $LASTEXITCODE",
    "",
  ].join("\n");
}

function quotePowerShell(value: string): string {
  if (!value.trim()) throw new Error("Agent Hub launcher paths cannot be empty.");
  return path.resolve(value).replaceAll("'", "''");
}
