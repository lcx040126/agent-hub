import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ArmUpdateRecoveryOptions,
  DesktopUpdateRecoveryExecutor,
  PendingRecoveryPlan,
} from "./update-recovery.js";

const WATCHDOG_FORMAT_VERSION = 1;

interface ActiveWatchdog {
  formatVersion: 1;
  recoveryId: string;
  targetVersion: string;
  planPath: string;
  healthMarkerPath: string;
  readyMarkerPath: string;
  heartbeatMarkerPath: string;
  resultPath: string;
}

export interface WindowsWatchdogPlan extends PendingRecoveryPlan {
  formatVersion: 1;
  recoveryId: string;
  recoveryRootDirectory: string;
  statePath: string;
  activePath: string;
  healthMarkerPath: string;
  readyMarkerPath: string;
  heartbeatMarkerPath: string;
  resultPath: string;
  timeoutSeconds: number;
  restartExecutable: boolean;
}

export interface WindowsUpdateWatchdogOptions {
  timeoutSeconds?: number;
  restartExecutable?: boolean;
  handshakeTimeoutMs?: number;
  launch?: (input: WatchdogLaunchInput) => Promise<void>;
}

export interface WatchdogLaunchInput {
  scriptPath: string;
  planPath: string;
  readyMarkerPath: string;
  heartbeatMarkerPath: string;
  resultPath: string;
  recoveryId: string;
  fromVersion: string;
  targetVersion: string;
  requireHeartbeat: boolean;
  handshakeTimeoutMs: number;
}

export class WindowsUpdateRecoveryExecutor implements DesktopUpdateRecoveryExecutor {
  private readonly activePath: string;
  private readonly scriptPath: string;
  private readonly timeoutSeconds: number;
  private readonly restartExecutable: boolean;
  private readonly handshakeTimeoutMs: number;
  private readonly launch: (input: WatchdogLaunchInput) => Promise<void>;

  constructor(
    private readonly rootDirectory: string,
    options: WindowsUpdateWatchdogOptions = {},
  ) {
    this.activePath = path.join(rootDirectory, "watchdog-active.json");
    this.scriptPath = path.join(rootDirectory, "agent-hub-update-watchdog.ps1");
    this.timeoutSeconds = options.timeoutSeconds ?? 180;
    this.restartExecutable = options.restartExecutable ?? true;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 30_000;
    this.launch = options.launch ?? launchWatchdog;
  }

  async arm(
    recovery: PendingRecoveryPlan,
    options: ArmUpdateRecoveryOptions = {},
  ): Promise<void> {
    if (process.platform !== "win32") {
      throw new Error("Agent Hub update recovery requires Windows.");
    }
    const applicationDirectory = requiredPath(recovery.applicationDirectory, "application directory");
    const applicationBackupDirectory = requiredPath(
      recovery.applicationBackupDirectory,
      "application backup",
    );
    const applicationExecutablePath = requiredPath(
      recovery.applicationExecutablePath,
      "application executable",
    );
    const restoreRootDirectory = requiredPath(recovery.restoreRootDirectory, "data directory");
    const recoveryId = randomUUID();
    const planPath = path.join(this.rootDirectory, `watchdog-plan-${recoveryId}.json`);
    const healthMarkerPath = path.join(this.rootDirectory, `watchdog-healthy-${recoveryId}.json`);
    const readyMarkerPath = path.join(this.rootDirectory, `watchdog-ready-${recoveryId}.json`);
    const heartbeatMarkerPath = path.join(this.rootDirectory, `watchdog-heartbeat-${recoveryId}.json`);
    const resultPath = path.join(this.rootDirectory, `watchdog-result-${recoveryId}.json`);
    const plan: WindowsWatchdogPlan = {
      ...recovery,
      applicationDirectory,
      applicationBackupDirectory,
      applicationExecutablePath,
      restoreRootDirectory,
      formatVersion: WATCHDOG_FORMAT_VERSION,
      recoveryId,
      recoveryRootDirectory: path.resolve(this.rootDirectory),
      statePath: path.join(this.rootDirectory, "state.json"),
      activePath: this.activePath,
      healthMarkerPath,
      readyMarkerPath,
      heartbeatMarkerPath,
      resultPath,
      timeoutSeconds: boundedTimeout(options.timeoutSeconds ?? this.timeoutSeconds),
      restartExecutable: this.restartExecutable,
    };
    validatePlanPaths(plan);

    await mkdir(this.rootDirectory, { recursive: true });
    if (options.replaceExisting) await this.supersedeActiveWatchdog();
    await Promise.all([
      rm(healthMarkerPath, { force: true }),
      rm(readyMarkerPath, { force: true }),
      rm(heartbeatMarkerPath, { force: true }),
      rm(resultPath, { force: true }),
    ]);
    await atomicWrite(this.scriptPath, WINDOWS_UPDATE_WATCHDOG_SCRIPT);
    await atomicWrite(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    const active: ActiveWatchdog = {
      formatVersion: WATCHDOG_FORMAT_VERSION,
      recoveryId,
      targetVersion: recovery.targetVersion,
      planPath,
      healthMarkerPath,
      readyMarkerPath,
      heartbeatMarkerPath,
      resultPath,
    };
    await atomicWrite(this.activePath, `${JSON.stringify(active, null, 2)}\n`);
    try {
      await this.launch({
        scriptPath: this.scriptPath,
        planPath,
        readyMarkerPath,
        heartbeatMarkerPath,
        resultPath,
        recoveryId,
        fromVersion: recovery.fromVersion,
        targetVersion: recovery.targetVersion,
        requireHeartbeat: plan.timeoutSeconds > 0,
        handshakeTimeoutMs: boundedHandshakeTimeout(this.handshakeTimeoutMs),
      });
    } catch (error) {
      await this.removeActiveIfMatches(recoveryId);
      await Promise.all([
        rm(planPath, { force: true }),
        rm(healthMarkerPath, { force: true }),
        rm(readyMarkerPath, { force: true }),
        rm(heartbeatMarkerPath, { force: true }),
      ]);
      throw error;
    }
  }

  async disarm(healthyVersion: string): Promise<void> {
    let active: ActiveWatchdog;
    try {
      active = parseActiveWatchdog(JSON.parse(await readFile(this.activePath, "utf8")));
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    if (active.targetVersion !== healthyVersion) return;
    await atomicWrite(active.healthMarkerPath, `${JSON.stringify({
      formatVersion: WATCHDOG_FORMAT_VERSION,
      recoveryId: active.recoveryId,
      healthyVersion,
      reportedAt: new Date().toISOString(),
    }, null, 2)}\n`);
  }

  private async supersedeActiveWatchdog(): Promise<void> {
    const active = await this.readActiveWatchdog();
    if (!active) return;
    validateActivePaths(active, this.rootDirectory);
    await atomicWrite(active.healthMarkerPath, `${JSON.stringify({
      formatVersion: WATCHDOG_FORMAT_VERSION,
      recoveryId: active.recoveryId,
      status: "superseded",
      reportedAt: new Date().toISOString(),
    }, null, 2)}\n`);
  }

  private async readActiveWatchdog(): Promise<ActiveWatchdog | undefined> {
    try {
      return parseActiveWatchdog(JSON.parse(await readFile(this.activePath, "utf8")));
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  private async removeActiveIfMatches(recoveryId: string): Promise<void> {
    const active = await this.readActiveWatchdog();
    if (active?.recoveryId === recoveryId) await rm(this.activePath, { force: true });
  }
}

async function launchWatchdog(input: WatchdogLaunchInput): Promise<void> {
  const child = spawn(
    "cmd.exe",
    [
      "/d",
      "/s",
      "/c",
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      input.scriptPath,
      "-PlanPath",
      input.planPath,
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  try {
    await waitForWatchdogHandshake(child, input);
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  } catch (error) {
    await terminateWatchdogTree(child);
    throw error;
  }
}

async function terminateWatchdogTree(child: ChildProcess): Promise<void> {
  if (!child.pid) {
    if (!child.killed) child.kill();
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve();
    };
    killer.once("error", () => {
      if (!child.killed) child.kill();
      finish();
    });
    killer.once("exit", finish);
    timeout = setTimeout(() => {
      if (!killer.killed) killer.kill();
      if (!child.killed) child.kill();
      finish();
    }, 2_000);
  });
}

async function waitForWatchdogHandshake(
  child: ChildProcess,
  input: WatchdogLaunchInput,
): Promise<void> {
  let spawnError: Error | undefined;
  let exitDescription: string | undefined;
  let diagnosticOutput = "";
  let markerDiagnostic = "ready marker missing";
  let heartbeatDiagnostic = input.requireHeartbeat
    ? "heartbeat marker not checked"
    : "heartbeat not required";
  const collectDiagnostic = (chunk: Buffer | string) => {
    if (diagnosticOutput.length < 4_000) diagnosticOutput += chunk.toString();
  };
  child.stdout?.on("data", collectDiagnostic);
  child.stderr?.on("data", collectDiagnostic);
  child.once("error", (error) => { spawnError = error; });
  child.once("exit", (code, signal) => {
    exitDescription = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
  });
  const deadline = Date.now() + input.handshakeTimeoutMs;
  while (true) {
    if (spawnError) throw spawnError;
    const ready = await readMarker(input.readyMarkerPath, parseReadyMarker);
    const readyMatches = Boolean(
      ready
      && ready.recoveryId === input.recoveryId
      && ready.fromVersion === input.fromVersion
      && ready.targetVersion === input.targetVersion
    );
    markerDiagnostic = ready
      ? `ready marker recovery=${ready.recoveryId}, pid=${ready.pid}, child=${child.pid ?? "unknown"}`
      : "ready marker missing";
    if (readyMatches) {
      if (!input.requireHeartbeat) return;
      const heartbeat = await readMarker(input.heartbeatMarkerPath, parseHeartbeatMarker);
      heartbeatDiagnostic = heartbeat
        ? `heartbeat recovery=${heartbeat.recoveryId}, pid=${heartbeat.pid}, sequence=${heartbeat.sequence}`
        : "heartbeat marker missing";
      if (
        heartbeat
        && heartbeat.recoveryId === input.recoveryId
        && heartbeat.pid === ready!.pid
        && heartbeat.sequence >= 1
      ) {
        return;
      }
    } else if (ready) {
      heartbeatDiagnostic = "heartbeat not checked because the ready marker did not match";
    }
    const result = await readMarker(input.resultPath, parseWatchdogResultMarker);
    if (result) {
      const detail = diagnosticOutput.trim();
      throw new Error(
        `The Agent Hub update watchdog failed before it was ready (${result.status}; ${markerDiagnostic}; ${heartbeatDiagnostic}).${result.error ? ` ${result.error}` : ""}${detail ? ` ${detail}` : ""}`,
      );
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await delay(Math.min(50, remainingMs));
  }
  if (exitDescription) {
    const detail = diagnosticOutput.trim();
    throw new Error(
      `The Agent Hub update watchdog exited before it was ready (${exitDescription}; ${markerDiagnostic}; ${heartbeatDiagnostic}).${detail ? ` ${detail}` : ""}`,
    );
  }
  const detail = diagnosticOutput.trim();
  const childDiagnostic = child.pid
    ? `child pid ${child.pid} still running`
    : "child pid unavailable";
  throw new Error(
    `The Agent Hub update watchdog did not become ready within ${input.handshakeTimeoutMs} ms (${childDiagnostic}; ${markerDiagnostic}; ${heartbeatDiagnostic}).${detail ? ` ${detail}` : ""}`,
  );
}

interface ReadyMarker {
  formatVersion: 1;
  recoveryId: string;
  fromVersion: string;
  targetVersion: string;
  pid: number;
  readyAt: string;
}

interface HeartbeatMarker {
  formatVersion: 1;
  recoveryId: string;
  pid: number;
  sequence: number;
  reportedAt: string;
}

interface WatchdogResultMarker {
  status: string;
  error?: string;
}

async function readMarker<T>(
  markerPath: string,
  parse: (value: unknown) => T,
): Promise<T | undefined> {
  try {
    return parse(JSON.parse(await readFile(markerPath, "utf8")));
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function parseReadyMarker(value: unknown): ReadyMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Agent Hub update watchdog ready marker is invalid.");
  }
  const input = value as Partial<ReadyMarker>;
  if (
    input.formatVersion !== WATCHDOG_FORMAT_VERSION
    || typeof input.recoveryId !== "string"
    || typeof input.fromVersion !== "string"
    || typeof input.targetVersion !== "string"
    || !Number.isSafeInteger(input.pid)
    || (input.pid ?? 0) < 1
    || typeof input.readyAt !== "string"
  ) {
    throw new Error("The Agent Hub update watchdog ready marker is invalid.");
  }
  return input as ReadyMarker;
}

function parseHeartbeatMarker(value: unknown): HeartbeatMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Agent Hub update watchdog heartbeat marker is invalid.");
  }
  const input = value as Partial<HeartbeatMarker>;
  if (
    input.formatVersion !== WATCHDOG_FORMAT_VERSION
    || typeof input.recoveryId !== "string"
    || !Number.isSafeInteger(input.pid)
    || (input.pid ?? 0) < 1
    || !Number.isSafeInteger(input.sequence)
    || (input.sequence ?? -1) < 0
    || typeof input.reportedAt !== "string"
  ) {
    throw new Error("The Agent Hub update watchdog heartbeat marker is invalid.");
  }
  return input as HeartbeatMarker;
}

function parseWatchdogResultMarker(value: unknown): WatchdogResultMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Agent Hub update watchdog result is invalid.");
  }
  const input = value as Partial<WatchdogResultMarker>;
  if (typeof input.status !== "string" || (input.error !== undefined && typeof input.error !== "string")) {
    throw new Error("The Agent Hub update watchdog result is invalid.");
  }
  return input as WatchdogResultMarker;
}

function validatePlanPaths(plan: WindowsWatchdogPlan): void {
  const recoveryRoot = nonRootPath(plan.recoveryRootDirectory, "recovery root");
  assertInside(plan.statePath, recoveryRoot, "recovery state");
  assertInside(plan.activePath, recoveryRoot, "active watchdog state");
  assertInside(plan.healthMarkerPath, recoveryRoot, "health marker");
  assertInside(plan.readyMarkerPath, recoveryRoot, "ready marker");
  assertInside(plan.heartbeatMarkerPath, recoveryRoot, "heartbeat marker");
  assertInside(plan.resultPath, recoveryRoot, "watchdog result");
  assertInside(plan.applicationBackupDirectory!, recoveryRoot, "application backup");
  const applicationDirectory = nonRootPath(plan.applicationDirectory!, "application directory");
  assertInside(plan.applicationExecutablePath!, applicationDirectory, "application executable");
  const restoreRoot = nonRootPath(plan.restoreRootDirectory!, "data directory");
  for (const file of plan.restoreFiles) {
    assertInside(file.backupPath, recoveryRoot, "data backup");
    assertInside(file.restorePath, restoreRoot, "data restore target");
  }
}

function validateActivePaths(active: ActiveWatchdog, rootDirectory: string): void {
  const recoveryRoot = nonRootPath(rootDirectory, "recovery root");
  assertInside(active.planPath, recoveryRoot, "watchdog plan");
  assertInside(active.healthMarkerPath, recoveryRoot, "health marker");
  assertInside(active.readyMarkerPath, recoveryRoot, "ready marker");
  assertInside(active.heartbeatMarkerPath, recoveryRoot, "heartbeat marker");
  assertInside(active.resultPath, recoveryRoot, "watchdog result");
}

function parseActiveWatchdog(value: unknown): ActiveWatchdog {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Agent Hub update watchdog state is invalid.");
  }
  const input = value as Partial<ActiveWatchdog>;
  if (
    input.formatVersion !== WATCHDOG_FORMAT_VERSION
    || typeof input.recoveryId !== "string"
    || typeof input.targetVersion !== "string"
    || typeof input.planPath !== "string"
    || typeof input.healthMarkerPath !== "string"
    || typeof input.readyMarkerPath !== "string"
    || typeof input.heartbeatMarkerPath !== "string"
    || typeof input.resultPath !== "string"
  ) {
    throw new Error("The Agent Hub update watchdog state is invalid.");
  }
  return input as ActiveWatchdog;
}

function requiredPath(value: string | undefined, name: string): string {
  if (!value) throw new Error(`The Agent Hub update recovery ${name} is missing.`);
  return path.resolve(value);
}

function nonRootPath(value: string, name: string): string {
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`The Agent Hub update ${name} is unsafe.`);
  }
  return resolved;
}

function assertInside(candidate: string, rootDirectory: string, name: string): void {
  const relative = path.relative(path.resolve(rootDirectory), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`The Agent Hub update ${name} is outside its managed directory.`);
  }
}

function boundedTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 900) {
    throw new Error("The Agent Hub update watchdog timeout is invalid.");
  }
  return value;
}

function boundedHandshakeTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 250 || value > 60_000) {
    throw new Error("The Agent Hub update watchdog handshake timeout is invalid.");
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export const WINDOWS_UPDATE_WATCHDOG_SCRIPT = String.raw`param(
  [Parameter(Mandatory = $true)]
  [string]$PlanPath
)

$ErrorActionPreference = "Stop"

function Resolve-NonRootPath([string]$Value, [string]$Name) {
  $resolved = [System.IO.Path]::GetFullPath($Value)
  if ($resolved -eq [System.IO.Path]::GetPathRoot($resolved)) { throw "Unsafe $Name path." }
  return $resolved
}

function Assert-ChildPath([string]$Candidate, [string]$Root, [string]$Name) {
  $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
  $rootPath = (Resolve-NonRootPath $Root "root").TrimEnd('\') + '\'
  if (-not $candidatePath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Name is outside its managed directory."
  }
  return $candidatePath
}

function Write-JsonAtomic([string]$Destination, $Value) {
  $temporary = "$Destination.$([System.Guid]::NewGuid().ToString('N')).tmp"
  $json = ($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine
  [System.IO.File]::WriteAllText($temporary, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Destination -Force
}

function Test-MatchingActivePlan([string]$ActivePath, $Plan) {
  try {
    if (-not $ActivePath -or -not (Test-Path -LiteralPath $ActivePath -PathType Leaf)) { return $false }
    $active = Get-Content -LiteralPath $ActivePath -Raw -Encoding UTF8 | ConvertFrom-Json
    return $active.formatVersion -eq 1 -and $active.recoveryId -eq $Plan.recoveryId
  } catch {
    return $false
  }
}

function Record-Failure([string]$StatePath, [string]$ActivePath, [string]$ResultPath, $Plan, [string]$Message) {
  try {
    if ((Test-MatchingActivePlan $ActivePath $Plan) -and $StatePath -and (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
      $state = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
      $state | Add-Member -MemberType NoteProperty -Name lastResult -Value ([pscustomobject]@{
        status = "failed"
        version = $Plan.targetVersion
        at = [DateTime]::UtcNow.ToString("o")
        error = $Message
      }) -Force
      Write-JsonAtomic $StatePath $state
    }
  } catch {}
  try {
    if ($ResultPath) {
      Write-JsonAtomic $ResultPath ([pscustomobject]@{
        status = "rollback-failed"
        fromVersion = $Plan.targetVersion
        restoredVersion = $Plan.fromVersion
        at = [DateTime]::UtcNow.ToString("o")
        error = $Message
      })
    }
  } catch {}
}

$plan = $null
$planPathResolved = $null
$activePath = $null
$statePath = $null
$resultPath = $null
$readyMarker = $null
$heartbeatMarker = $null
$applicationDirectory = $null
$applicationExecutable = $null
$applicationBackup = $null
$stagingDirectory = $null
$failedDirectory = $null
$relativeExecutable = $null
$dataRollbackRecords = @()
$applicationSwapped = $false
$shouldRestart = $false
$exitCode = 0

try {
  $plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($plan.formatVersion -ne 1) { throw "Unsupported Agent Hub watchdog plan." }

  $recoveryRoot = Resolve-NonRootPath $plan.recoveryRootDirectory "recovery root"
  $planPathResolved = Assert-ChildPath $PlanPath $recoveryRoot "watchdog plan"
  $healthMarker = Assert-ChildPath $plan.healthMarkerPath $recoveryRoot "health marker"
  $readyMarker = Assert-ChildPath $plan.readyMarkerPath $recoveryRoot "ready marker"
  $heartbeatMarker = Assert-ChildPath $plan.heartbeatMarkerPath $recoveryRoot "heartbeat marker"
  $activePath = Assert-ChildPath $plan.activePath $recoveryRoot "active state"
  $statePath = Assert-ChildPath $plan.statePath $recoveryRoot "recovery state"
  $resultPath = Assert-ChildPath $plan.resultPath $recoveryRoot "watchdog result"
  $applicationBackup = Assert-ChildPath $plan.applicationBackupDirectory $recoveryRoot "application backup"
  $pendingBackup = if ($plan.backupDirectory) { Assert-ChildPath $plan.backupDirectory $recoveryRoot "pending backup" } else { $null }
  $attemptedInstaller = Assert-ChildPath $plan.attemptedInstallerPath $recoveryRoot "attempted installer"
  $applicationDirectory = Resolve-NonRootPath $plan.applicationDirectory "application directory"
  $applicationExecutable = Assert-ChildPath $plan.applicationExecutablePath $applicationDirectory "application executable"
  $restoreRoot = Resolve-NonRootPath $plan.restoreRootDirectory "data directory"

  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw "The update recovery state is missing." }
  if (-not (Test-Path -LiteralPath $applicationBackup -PathType Container)) { throw "The application backup is missing." }
  $relativeExecutable = $applicationExecutable.Substring($applicationDirectory.Length).TrimStart('\')
  $backupExecutable = Join-Path $applicationBackup $relativeExecutable
  if (-not (Test-Path -LiteralPath $backupExecutable -PathType Leaf)) {
    throw "The application backup executable is missing."
  }
  foreach ($restoreFile in @($plan.restoreFiles)) {
    $backupPath = Assert-ChildPath $restoreFile.backupPath $recoveryRoot "data backup"
    [void](Assert-ChildPath $restoreFile.restorePath $restoreRoot "data restore target")
    if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) { throw "The update data backup is missing." }
  }

  Write-JsonAtomic $readyMarker ([pscustomobject]@{
    formatVersion = 1
    recoveryId = $plan.recoveryId
    fromVersion = $plan.fromVersion
    targetVersion = $plan.targetVersion
    pid = $PID
    readyAt = [DateTime]::UtcNow.ToString("o")
  })

  $healthConfirmed = $false
  $heartbeatSequence = 0
  $deadline = [DateTime]::UtcNow.AddSeconds([int]$plan.timeoutSeconds)
  do {
    Write-JsonAtomic $heartbeatMarker ([pscustomobject]@{
      formatVersion = 1
      recoveryId = $plan.recoveryId
      pid = $PID
      sequence = $heartbeatSequence
      reportedAt = [DateTime]::UtcNow.ToString("o")
    })
    $heartbeatSequence++
    if (Test-Path -LiteralPath $healthMarker -PathType Leaf) {
      $health = Get-Content -LiteralPath $healthMarker -Raw -Encoding UTF8 | ConvertFrom-Json
      $matchingHealth = $health.formatVersion -eq 1 -and $health.recoveryId -eq $plan.recoveryId
      $confirmedTarget = $matchingHealth -and $health.healthyVersion -eq $plan.targetVersion
      $superseded = $matchingHealth -and $health.status -eq "superseded"
      if ($confirmedTarget -or $superseded) {
        $healthConfirmed = $true
        break
      }
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)

  if (-not $healthConfirmed) {
    $recoveryState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $pendingStillMatches = $recoveryState.pending -and $recoveryState.pending.targetVersion -eq $plan.targetVersion
    if (-not $pendingStillMatches) { $healthConfirmed = $true }
  }

  if (-not $healthConfirmed) {
    $matchingProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.Equals($applicationExecutable, [System.StringComparison]::OrdinalIgnoreCase)
    }
    foreach ($process in $matchingProcesses) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 800

    $applicationParent = [System.IO.Path]::GetDirectoryName($applicationDirectory)
    $applicationName = [System.IO.Path]::GetFileName($applicationDirectory.TrimEnd('\'))
    $stagingDirectory = Join-Path $applicationParent "$applicationName.agent-hub-restore-$($plan.recoveryId)"
    $failedDirectory = Join-Path $applicationParent "$applicationName.agent-hub-failed-$($plan.recoveryId)"
    if (Test-Path -LiteralPath $stagingDirectory) { Remove-Item -LiteralPath $stagingDirectory -Recurse -Force }
    if (Test-Path -LiteralPath $failedDirectory) { Remove-Item -LiteralPath $failedDirectory -Recurse -Force }
    New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null
    Get-ChildItem -LiteralPath $applicationBackup -Force | Copy-Item -Destination $stagingDirectory -Recurse -Force

    $stagedExecutable = Join-Path $stagingDirectory $relativeExecutable
    if (-not (Test-Path -LiteralPath $stagedExecutable -PathType Leaf)) {
      throw "The restored Agent Hub executable is missing."
    }

    $movedCurrentApplication = $false
    try {
      if (Test-Path -LiteralPath $applicationDirectory) {
        Move-Item -LiteralPath $applicationDirectory -Destination $failedDirectory
        $movedCurrentApplication = $true
      }
      Move-Item -LiteralPath $stagingDirectory -Destination $applicationDirectory
      $applicationSwapped = $true
    } catch {
      if ($movedCurrentApplication -and -not (Test-Path -LiteralPath $applicationDirectory)) {
        Move-Item -LiteralPath $failedDirectory -Destination $applicationDirectory -ErrorAction SilentlyContinue
      }
      throw
    }

    $dataRollbackRoot = Join-Path $recoveryRoot "watchdog-data-rollback-$($plan.recoveryId)"
    New-Item -ItemType Directory -Path $dataRollbackRoot -Force | Out-Null
    $restoreIndex = 0
    foreach ($restoreFile in @($plan.restoreFiles)) {
      $backupPath = Assert-ChildPath $restoreFile.backupPath $recoveryRoot "data backup"
      $restorePath = Assert-ChildPath $restoreFile.restorePath $restoreRoot "data restore target"
      if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) { throw "The update data backup is missing." }
      $restoreParent = [System.IO.Path]::GetDirectoryName($restorePath)
      New-Item -ItemType Directory -Path $restoreParent -Force | Out-Null

      $originalBackup = Join-Path $dataRollbackRoot "$restoreIndex.original"
      $walBackup = Join-Path $dataRollbackRoot "$restoreIndex.wal"
      $shmBackup = Join-Path $dataRollbackRoot "$restoreIndex.shm"
      $hadOriginal = Test-Path -LiteralPath $restorePath -PathType Leaf
      $hadWal = Test-Path -LiteralPath "$restorePath-wal" -PathType Leaf
      $hadShm = Test-Path -LiteralPath "$restorePath-shm" -PathType Leaf
      if ($hadOriginal) { Copy-Item -LiteralPath $restorePath -Destination $originalBackup -Force }
      if ($hadWal) { Copy-Item -LiteralPath "$restorePath-wal" -Destination $walBackup -Force }
      if ($hadShm) { Copy-Item -LiteralPath "$restorePath-shm" -Destination $shmBackup -Force }
      $dataRollbackRecords += [pscustomobject]@{
        restorePath = $restorePath
        originalBackup = $originalBackup
        walBackup = $walBackup
        shmBackup = $shmBackup
        hadOriginal = $hadOriginal
        hadWal = $hadWal
        hadShm = $hadShm
      }

      $temporaryRestore = "$restorePath.$([System.Guid]::NewGuid().ToString('N')).restore"
      Copy-Item -LiteralPath $backupPath -Destination $temporaryRestore -Force
      Remove-Item -LiteralPath "$restorePath-wal" -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath "$restorePath-shm" -Force -ErrorAction SilentlyContinue
      if ($hadOriginal) {
        $replaceBackup = "$originalBackup.replace"
        [System.IO.File]::Replace($temporaryRestore, $restorePath, $replaceBackup, $true)
        Remove-Item -LiteralPath $replaceBackup -Force -ErrorAction SilentlyContinue
      } else {
        Move-Item -LiteralPath $temporaryRestore -Destination $restorePath
      }
      $restoreIndex++
    }

    $failureMessage = "Agent Hub $($plan.targetVersion) did not report a healthy startup within $($plan.timeoutSeconds) seconds. Version $($plan.fromVersion) and its pre-update database were restored."
    $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $state | Add-Member -MemberType NoteProperty -Name pending -Value $null -Force
    $state | Add-Member -MemberType NoteProperty -Name lastResult -Value ([pscustomobject]@{
      status = "failed"
      version = $plan.targetVersion
      at = [DateTime]::UtcNow.ToString("o")
      error = $failureMessage
    }) -Force
    Write-JsonAtomic $statePath $state
    Write-JsonAtomic $resultPath ([pscustomobject]@{
      status = "rolled-back"
      fromVersion = $plan.targetVersion
      restoredVersion = $plan.fromVersion
      at = [DateTime]::UtcNow.ToString("o")
    })

    Remove-Item -LiteralPath $dataRollbackRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $failedDirectory -Recurse -Force -ErrorAction SilentlyContinue
    if ($pendingBackup) {
      Remove-Item -LiteralPath $pendingBackup -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      Remove-Item -LiteralPath $applicationBackup -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $attemptedInstaller -Force -ErrorAction SilentlyContinue
    $shouldRestart = $true
  }
} catch {
  $exitCode = 1
  $rollbackErrors = @($_.Exception.Message)

  for ($index = $dataRollbackRecords.Count - 1; $index -ge 0; $index--) {
    $record = $dataRollbackRecords[$index]
    try {
      Remove-Item -LiteralPath "$($record.restorePath)-wal" -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath "$($record.restorePath)-shm" -Force -ErrorAction SilentlyContinue
      if ($record.hadOriginal -and (Test-Path -LiteralPath $record.originalBackup -PathType Leaf)) {
        Copy-Item -LiteralPath $record.originalBackup -Destination $record.restorePath -Force
      } elseif (-not $record.hadOriginal) {
        Remove-Item -LiteralPath $record.restorePath -Force -ErrorAction SilentlyContinue
      }
      if ($record.hadWal -and (Test-Path -LiteralPath $record.walBackup -PathType Leaf)) {
        Copy-Item -LiteralPath $record.walBackup -Destination "$($record.restorePath)-wal" -Force
      }
      if ($record.hadShm -and (Test-Path -LiteralPath $record.shmBackup -PathType Leaf)) {
        Copy-Item -LiteralPath $record.shmBackup -Destination "$($record.restorePath)-shm" -Force
      }
    } catch {
      $rollbackErrors += "Data restore reversal failed: $($_.Exception.Message)"
    }
  }

  if ($applicationSwapped -and $failedDirectory -and (Test-Path -LiteralPath $failedDirectory)) {
    $reversalStaging = "$stagingDirectory.reversal"
    try {
      if (Test-Path -LiteralPath $reversalStaging) { Remove-Item -LiteralPath $reversalStaging -Recurse -Force }
      Move-Item -LiteralPath $applicationDirectory -Destination $reversalStaging
      try {
        Move-Item -LiteralPath $failedDirectory -Destination $applicationDirectory
        Remove-Item -LiteralPath $reversalStaging -Recurse -Force -ErrorAction SilentlyContinue
        $applicationSwapped = $false
      } catch {
        if (-not (Test-Path -LiteralPath $applicationDirectory) -and (Test-Path -LiteralPath $reversalStaging)) {
          Move-Item -LiteralPath $reversalStaging -Destination $applicationDirectory -ErrorAction SilentlyContinue
        }
        throw
      }
    } catch {
      $rollbackErrors += "Application directory reversal failed: $($_.Exception.Message)"
    }
  }

  $message = "Agent Hub automatic rollback failed. " + ($rollbackErrors -join " ")
  if ($plan) { Record-Failure $statePath $activePath $resultPath $plan $message }
  $shouldRestart = $true
} finally {
  if ($activePath -and $plan -and (Test-MatchingActivePlan $activePath $plan)) {
    Remove-Item -LiteralPath $activePath -Force -ErrorAction SilentlyContinue
  }
  if ($planPathResolved) { Remove-Item -LiteralPath $planPathResolved -Force -ErrorAction SilentlyContinue }
  if ($heartbeatMarker) { Remove-Item -LiteralPath $heartbeatMarker -Force -ErrorAction SilentlyContinue }

  if ($shouldRestart -and $plan -and $plan.restartExecutable) {
    $restartCandidates = @($applicationExecutable)
    if ($relativeExecutable -and $failedDirectory) { $restartCandidates += (Join-Path $failedDirectory $relativeExecutable) }
    if ($relativeExecutable -and $stagingDirectory) { $restartCandidates += (Join-Path $stagingDirectory $relativeExecutable) }
    if ($relativeExecutable -and $applicationBackup) { $restartCandidates += (Join-Path $applicationBackup $relativeExecutable) }
    foreach ($candidate in $restartCandidates) {
      if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        try { Start-Process -FilePath $candidate; break } catch {}
      }
    }
  }
}

if ($exitCode -ne 0) { exit $exitCode }
`;
