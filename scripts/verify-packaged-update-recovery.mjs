import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(scriptPath), "..");
const applicationDirectory = path.resolve(
  process.argv[2] ?? path.join(workspaceRoot, "release", "win-unpacked"),
);

if (process.versions.electron) {
  await verifyRecoveryBackup(applicationDirectory);
} else {
  if (process.platform !== "win32") {
    throw new Error("The packaged update recovery probe requires a Windows Agent Hub package.");
  }
  await runWithPackagedElectron(applicationDirectory);
}

async function runWithPackagedElectron(sourceDirectory) {
  const executablePath = path.join(sourceDirectory, "Agent Hub.exe");
  await new Promise((resolve, reject) => {
    const child = spawn(executablePath, [scriptPath, sourceDirectory], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
      },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Packaged update recovery probe failed (${signal ?? `exit ${code ?? "unknown"}`}).`));
    });
  });
}

async function verifyRecoveryBackup(sourceDirectory) {
  const originalFs = process.getBuiltinModule("original-fs");
  if (!originalFs?.promises?.cp) {
    throw new Error("Electron original-fs is unavailable for the packaged recovery probe.");
  }

  const packageJson = JSON.parse(await readFile(path.join(workspaceRoot, "package.json"), "utf8"));
  const recoveryModuleUrl = pathToFileURL(path.join(workspaceRoot, "dist", "desktop", "update-recovery.js")).href;
  const healthModuleUrl = pathToFileURL(path.join(workspaceRoot, "dist", "desktop", "startup-health.js")).href;
  const [{ FileDesktopUpdateRecovery }, { runHeadlessHealthProbe }] = await Promise.all([
    import(recoveryModuleUrl),
    import(healthModuleUrl),
  ]);

  const probeRoot = await originalFs.promises.mkdtemp(path.join(tmpdir(), "agent-hub-packaged-recovery-"));
  const installerContents = Buffer.from(`Agent Hub ${packageJson.version} recovery probe`);
  const installerPath = path.join(probeRoot, `AgentHub-Setup-${packageJson.version}-x64.exe`);
  const recoveryRoot = path.join(probeRoot, "updates");
  const recovery = new FileDesktopUpdateRecovery(recoveryRoot);

  try {
    await writeFile(installerPath, installerContents);
    const prepared = await recovery.prepare({
      currentVersion: "0.0.0",
      manifest: {
        formatVersion: 1,
        product: "agent-hub",
        channel: "stable",
        repository: "lcx040126/agent-hub",
        version: packageJson.version,
        publishedAt: new Date(0).toISOString(),
        protocolVersion: packageJson.agentHub.protocolVersion,
        minimumSourceProtocolVersion: packageJson.agentHub.minimumSourceProtocolVersion,
        schemaVersion: packageJson.agentHub.schemaVersion,
        minimumSourceSchemaVersion: packageJson.agentHub.minimumSourceSchemaVersion,
        asset: {
          fileName: path.basename(installerPath),
          url: `https://github.com/lcx040126/agent-hub/releases/download/v${packageJson.version}/${path.basename(installerPath)}`,
          sizeBytes: installerContents.length,
          sha256: createHash("sha256").update(installerContents).digest("hex"),
        },
      },
      manifestSha256: "a".repeat(64),
      installerPath,
      applicationDirectory: sourceDirectory,
      applicationExecutablePath: path.join(sourceDirectory, "Agent Hub.exe"),
      restoreRootDirectory: probeRoot,
    });

    const sourceAsar = path.join(sourceDirectory, "resources", "app.asar");
    const backupAsar = path.join(prepared.applicationBackupDirectory, "resources", "app.asar");
    const [sourceDetails, backupDetails, sourceSha256, backupSha256] = await Promise.all([
      originalFs.promises.stat(sourceAsar),
      originalFs.promises.stat(backupAsar),
      sha256(originalFs, sourceAsar),
      sha256(originalFs, backupAsar),
    ]);
    if (!sourceDetails.isFile() || !backupDetails.isFile()) {
      throw new Error("The packaged recovery probe did not preserve app.asar as a physical file.");
    }
    if (sourceDetails.size !== backupDetails.size || sourceSha256 !== backupSha256) {
      throw new Error("The packaged recovery probe produced a non-identical app.asar backup.");
    }

    const backupExecutable = path.join(prepared.applicationBackupDirectory, "Agent Hub.exe");
    const health = await runHeadlessHealthProbe({
      electronExecutable: backupExecutable,
      headlessRunnerPath: path.join(
        prepared.applicationBackupDirectory,
        "resources",
        "app.asar",
        "dist",
        "companion",
        "headless-runner.js",
      ),
      timeoutMs: 30_000,
    });
    if (
      !health
      || typeof health !== "object"
      || health.status !== "ok"
      || health.version !== packageJson.version
      || health.mcpBridge !== "ok"
      || health.codexHook !== "ok"
    ) {
      throw new Error("The packaged recovery backup did not pass the Agent Hub headless health probe.");
    }

    process.stdout.write(`${JSON.stringify({
      status: "ok",
      version: packageJson.version,
      appAsarBytes: backupDetails.size,
      appAsarSha256: backupSha256,
      backupHealth: health.status,
    })}\n`);
  } finally {
    await recovery.abandonPending().catch(() => undefined);
    await originalFs.promises.rm(probeRoot, { recursive: true, force: true });
  }
}

async function sha256(files, filePath) {
  const digest = createHash("sha256");
  for await (const chunk of files.createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}
