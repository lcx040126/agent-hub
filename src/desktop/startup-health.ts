import { execFile } from "node:child_process";
import {
  AGENT_HUB_PROTOCOL_VERSION,
  AGENT_HUB_SCHEMA_VERSION,
  AGENT_HUB_VERSION,
} from "../shared/version.js";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const MAX_PROBE_OUTPUT_BYTES = 128 * 1024;

export interface StartupHealthReport {
  service: {
    status: "ok";
    version: string;
    protocolVersion: number;
    schemaVersion: number;
    database: "ok";
  };
  localIntegration: {
    status: "ok";
    version: string;
    mcpBridge: "ok";
    codexHook: "ok";
  };
}

export interface VerifyStartupHealthOptions {
  localServerUrl: string;
  electronExecutable: string;
  headlessRunnerPath: string;
  loadRenderer(): Promise<void>;
  markHealthy(): Promise<void>;
  fetchImpl?: typeof fetch;
  runHeadlessProbe?: () => Promise<unknown>;
  serviceTimeoutMs?: number;
  headlessTimeoutMs?: number;
  expectedVersion?: string;
  expectedProtocolVersion?: number;
  expectedSchemaVersion?: number;
}

export async function verifyStartupHealthAndMark(
  options: VerifyStartupHealthOptions,
): Promise<StartupHealthReport> {
  const expectedVersion = options.expectedVersion ?? AGENT_HUB_VERSION;
  const expectedProtocolVersion = options.expectedProtocolVersion ?? AGENT_HUB_PROTOCOL_VERSION;
  const expectedSchemaVersion = options.expectedSchemaVersion ?? AGENT_HUB_SCHEMA_VERSION;

  // loadURL 成功是界面侧边界；界面尚未加载时不能接受新版本。
  await options.loadRenderer();
  const service = await probeRoomService({
    localServerUrl: options.localServerUrl,
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.serviceTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    expectedVersion,
    expectedProtocolVersion,
    expectedSchemaVersion,
  });
  const rawLocalIntegration = options.runHeadlessProbe
    ? await options.runHeadlessProbe()
    : await runHeadlessHealthProbe({
        electronExecutable: options.electronExecutable,
        headlessRunnerPath: options.headlessRunnerPath,
        timeoutMs: options.headlessTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      });
  const localIntegration = requireLocalIntegrationHealth(rawLocalIntegration, expectedVersion);

  // 必须放在最后：该调用会清除待回退状态并解除 watchdog。
  await options.markHealthy();
  return { service, localIntegration };
}

interface RoomServiceProbeOptions {
  localServerUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  expectedVersion: string;
  expectedProtocolVersion: number;
  expectedSchemaVersion: number;
}

async function probeRoomService(options: RoomServiceProbeOptions): Promise<StartupHealthReport["service"]> {
  let response: Response;
  try {
    response = await options.fetchImpl(new URL("/api/health", options.localServerUrl), {
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new Error(`Agent Hub room service health probe failed: ${errorMessage(error)}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`Agent Hub room service health probe returned HTTP ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error("Agent Hub room service health probe returned invalid JSON.", { cause: error });
  }
  if (!isRecord(payload)) throw new Error("Agent Hub room service health probe returned no object.");
  if (payload.status !== "ok" || payload.service !== "agent-hub") {
    throw new Error("Agent Hub room service did not report a healthy service identity.");
  }
  if (payload.version !== options.expectedVersion) {
    throw new Error(
      `Agent Hub room service version mismatch: expected ${options.expectedVersion}, received ${String(payload.version)}.`,
    );
  }
  if (payload.protocolVersion !== options.expectedProtocolVersion) {
    throw new Error("Agent Hub room service protocol version does not match the desktop client.");
  }
  if (payload.schemaVersion !== options.expectedSchemaVersion) {
    throw new Error("Agent Hub room service schema version does not match the desktop client.");
  }
  if (
    !isRecord(payload.database)
    || payload.database.status !== "ok"
    || payload.database.schemaVersion !== options.expectedSchemaVersion
  ) {
    throw new Error("Agent Hub room service database health check did not pass.");
  }

  return {
    status: "ok",
    version: options.expectedVersion,
    protocolVersion: options.expectedProtocolVersion,
    schemaVersion: options.expectedSchemaVersion,
    database: "ok",
  };
}

interface RunHeadlessHealthProbeOptions {
  electronExecutable: string;
  headlessRunnerPath: string;
  timeoutMs: number;
}

export function runHeadlessHealthProbe(options: RunHeadlessHealthProbeOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      options.electronExecutable,
      [options.headlessRunnerPath, "--health-probe"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          NODE_ENV: "production",
        },
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        timeout: options.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(`Agent Hub local integration health probe failed: ${detail}`, { cause: error }));
          return;
        }
        const output = stdout.trim();
        if (!output) {
          reject(new Error("Agent Hub local integration health probe returned no result."));
          return;
        }
        try {
          resolve(JSON.parse(output));
        } catch (parseError) {
          reject(new Error("Agent Hub local integration health probe returned invalid JSON.", {
            cause: parseError,
          }));
        }
      },
    );
  });
}

function requireLocalIntegrationHealth(
  payload: unknown,
  expectedVersion: string,
): StartupHealthReport["localIntegration"] {
  if (!isRecord(payload)) throw new Error("Agent Hub local integration health probe returned no object.");
  if (payload.status !== "ok" || payload.version !== expectedVersion) {
    throw new Error("Agent Hub local integration health probe reported the wrong version or status.");
  }
  if (payload.mcpBridge !== "ok") {
    throw new Error("Agent Hub MCP bridge health check did not pass.");
  }
  if (payload.codexHook !== "ok") {
    throw new Error("Agent Hub Codex Hook health check did not pass.");
  }
  return {
    status: "ok",
    version: expectedVersion,
    mcpBridge: "ok",
    codexHook: "ok",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
