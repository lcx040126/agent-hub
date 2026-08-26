import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

export interface ServiceSupervisorOptions {
  executable: string;
  scriptPath: string;
  port: number;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  startupTimeoutMs?: number;
}

export interface ServiceSupervisor {
  readonly port: number;
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  restartWithScript(scriptPath: string): Promise<void>;
}

export function createServiceSupervisor(options: ServiceSupervisorOptions): ServiceSupervisor {
  const fetchImpl = options.fetchImpl ?? fetch;
  const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
  let child: ChildProcess | null = null;
  let activeScriptPath = options.scriptPath;
  let stopping = false;
  const url = `http://127.0.0.1:${options.port}`;

  const start = async () => {
    if (child && child.exitCode === null) return;
    stopping = false;
    child = spawn(options.executable, [activeScriptPath], {
      env: {
        ...process.env,
        ...options.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        PORT: String(options.port),
        AGENT_HUB_DATA_DIR: options.dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("data", (chunk) => process.stdout.write(`[agent-hub-service] ${chunk}`));
    child.stderr?.on("data", (chunk) => process.stderr.write(`[agent-hub-service] ${chunk}`));
    child.once("exit", () => {
      if (!stopping) child = null;
    });
    await waitForHealth(fetchImpl, url, startupTimeoutMs);
  };

  const stop = async () => {
    const current = child;
    if (!current || current.exitCode !== null) return;
    stopping = true;
    current.kill();
    await Promise.race([
      once(current, "exit").then(() => undefined),
      new Promise<void>((resolve) => setTimeout(() => { current.kill("SIGKILL"); resolve(); }, 5_000)),
    ]);
    child = null;
  };

  return {
    port: options.port,
    url,
    start,
    stop,
    async restart() {
      await stop();
      await start();
    },
    async restartWithScript(scriptPath: string) {
      if (!scriptPath.trim()) throw new Error("An update script path is required.");
      const previousScriptPath = activeScriptPath;
      activeScriptPath = scriptPath;
      await stop();
      try {
        await start();
      } catch (error) {
        await stop();
        activeScriptPath = previousScriptPath;
        await start().catch(() => undefined);
        throw error;
      }
    },
  };
}

async function waitForHealth(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "service did not respond";
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Agent Hub service failed health check: ${lastError}`);
}
