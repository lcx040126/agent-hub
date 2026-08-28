import { spawn, type ChildProcess } from "node:child_process";

export interface ServiceSupervisorOptions {
  executable: string;
  scriptPath: string;
  port: number;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  spawnImpl?: typeof spawn;
  onOutput: (stream: "stdout" | "stderr", output: string) => void;
}

export interface ServiceSupervisor {
  readonly port: number;
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

export function createServiceSupervisor(options: ServiceSupervisorOptions): ServiceSupervisor {
  const fetchImpl = options.fetchImpl ?? fetch;
  const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  const spawnImpl = options.spawnImpl ?? spawn;
  let child: ChildProcess | null = null;
  let operationQueue: Promise<void> = Promise.resolve();
  const url = `http://127.0.0.1:${options.port}`;

  const stopChild = async (current: ChildProcess) => {
    if (current.exitCode !== null || current.signalCode !== null) {
      if (child === current) child = null;
      return;
    }
    current.kill();
    if (!(await waitForChildExit(current, stopTimeoutMs))) {
      current.kill("SIGKILL");
      if (!(await waitForChildExit(current, stopTimeoutMs))) {
        throw new Error("Agent Hub service did not exit after it was force-stopped.");
      }
    }
    if (child === current) child = null;
  };

  const startInternal = async () => {
    if (child && child.exitCode === null && child.signalCode === null) return;
    const current = spawnImpl(options.executable, [options.scriptPath], {
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
    child = current;
    forwardOutput(current.stdout, "stdout", options.onOutput);
    forwardOutput(current.stderr, "stderr", options.onOutput);
    current.once("exit", () => {
      if (child === current) child = null;
    });
    try {
      await waitForHealth(fetchImpl, url, startupTimeoutMs);
    } catch (healthError) {
      try {
        await stopChild(current);
      } catch (cleanupError) {
        throw new AggregateError(
          [healthError, cleanupError],
          "Agent Hub service failed health check and could not be stopped.",
        );
      }
      throw healthError;
    }
  };

  const stopInternal = async () => {
    const current = child;
    if (!current) return;
    await stopChild(current);
  };

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = operationQueue.then(operation);
    operationQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    port: options.port,
    url,
    start: () => serialize(startInternal),
    stop: () => serialize(stopInternal),
    restart: () => serialize(async () => {
      await stopInternal();
      await startInternal();
    }),
  };
}

function forwardOutput(
  stream: NodeJS.ReadableStream | null,
  source: "stdout" | "stderr",
  onOutput: ServiceSupervisorOptions["onOutput"],
): void {
  if (!stream) return;
  const deliver = (output: string) => {
    try {
      onOutput(source, output);
    } catch {
      // 子进程监管不能被诊断回调反向中断。
    }
  };
  stream.on("data", (chunk: Buffer | string) => deliver(String(chunk)));
  stream.on("error", (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    deliver(`Agent Hub service ${source} stream error: ${message}`);
  });
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
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
