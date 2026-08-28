import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { EventEmitter } from "node:events";

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_ARCHIVE_COUNT = 3;
const DEFAULT_STARTUP_BUFFER_LIMIT = 100;

export type DesktopLogLevel = "info" | "warn" | "error";

export interface DesktopLoggerInitializeOptions {
  userDataPath: string;
  maxFileBytes?: number;
  archiveCount?: number;
  startupBufferLimit?: number;
}

export interface DesktopDiagnosticLogger {
  initialize(options: DesktopLoggerInitializeOptions): Promise<void>;
  info(source: string, message: string, error?: unknown): void;
  warn(source: string, message: string, error?: unknown): void;
  error(source: string, message: string, error?: unknown): void;
  flush(): Promise<void>;
  installProcessStreamGuards(streams?: ProcessStreams): void;
}

interface ProcessStreams {
  stdout?: Pick<EventEmitter, "on"> | null;
  stderr?: Pick<EventEmitter, "on"> | null;
}

interface DesktopLogRecord {
  timestamp: string;
  level: DesktopLogLevel;
  source: string;
  message: string;
  error?: {
    name?: string;
    code?: string;
    message?: string;
    stack?: string;
  };
}

export function createDesktopDiagnosticLogger(): DesktopDiagnosticLogger {
  let logPath: string | null = null;
  let currentSize = 0;
  let maxFileBytes = DEFAULT_MAX_FILE_BYTES;
  let archiveCount = DEFAULT_ARCHIVE_COUNT;
  let startupBufferLimit = DEFAULT_STARTUP_BUFFER_LIMIT;
  let startupBuffer: DesktopLogRecord[] = [];
  let initialization: Promise<void> | null = null;
  let writeQueue: Promise<void> = Promise.resolve();
  const guardedStreams = new WeakSet<object>();

  const enqueue = (record: DesktopLogRecord) => {
    if (!logPath) {
      startupBuffer.push(record);
      if (startupBuffer.length > startupBufferLimit) startupBuffer.shift();
      return;
    }
    const target = logPath;
    writeQueue = writeQueue.then(async () => {
      const serialized = serializeRecord(record, maxFileBytes);
      if (!serialized) return;
      const lineBytes = Buffer.byteLength(serialized, "utf8");
      if (currentSize + lineBytes > maxFileBytes) {
        if (!(await rotateLogs(target, archiveCount))) return;
        currentSize = 0;
      }
      await appendFile(target, serialized, { encoding: "utf8" });
      currentSize += lineBytes;
    }).catch(() => undefined);
  };

  const log = (level: DesktopLogLevel, source: string, message: string, cause?: unknown) => {
    try {
      enqueue(createRecord(level, source, message, cause));
    } catch {
      // 诊断链路不能反向影响桌面业务，也不能尝试递归记录自身故障。
    }
  };

  const logger: DesktopDiagnosticLogger = {
    initialize(options) {
      if (initialization) return initialization;
      initialization = (async () => {
        try {
          maxFileBytes = positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
          archiveCount = positiveInteger(options.archiveCount, DEFAULT_ARCHIVE_COUNT);
          startupBufferLimit = positiveInteger(options.startupBufferLimit, DEFAULT_STARTUP_BUFFER_LIMIT);
          const directory = path.join(options.userDataPath, "logs");
          const target = path.join(directory, "desktop.log");
          await mkdir(directory, { recursive: true });
          const existing = await stat(target).catch(() => null);
          currentSize = existing?.isFile() ? existing.size : 0;
          logPath = target;
          if (currentSize > maxFileBytes) {
            if (await rotateLogs(target, archiveCount)) currentSize = 0;
          }
          const buffered = startupBuffer;
          startupBuffer = [];
          for (const record of buffered) enqueue(record);
          await logger.flush();
        } catch {
          logPath = null;
          startupBuffer = [];
        }
      })();
      return initialization;
    },
    info(source, message, cause) {
      log("info", source, message, cause);
    },
    warn(source, message, cause) {
      log("warn", source, message, cause);
    },
    error(source, message, cause) {
      log("error", source, message, cause);
    },
    async flush() {
      try {
        await writeQueue;
      } catch {
        // 写入队列已经吞掉单次失败；这里继续保证 flush 永不抛出。
      }
    },
    installProcessStreamGuards(streams = { stdout: process.stdout, stderr: process.stderr }) {
      const install = (
        name: "stdout" | "stderr",
        stream: Pick<EventEmitter, "on"> | null | undefined,
      ) => {
        if (!stream) return;
        const identity = stream as object;
        if (guardedStreams.has(identity)) return;
        guardedStreams.add(identity);
        stream.on("error", (cause: unknown) => {
          logger.warn(`process.${name}`, "Process output stream reported an error.", cause);
        });
      };
      for (const [name, stream] of [
        ["stdout", streams.stdout],
        ["stderr", streams.stderr],
      ] as const) {
        try {
          install(name, stream);
        } catch {
          // 单个流安装失败时仍继续保护另一个流，且不能阻断 Electron 启动。
        }
      }
    },
  };
  return logger;
}

function createRecord(
  level: DesktopLogLevel,
  source: string,
  message: string,
  cause?: unknown,
): DesktopLogRecord {
  const record: DesktopLogRecord = {
    timestamp: new Date().toISOString(),
    level,
    source: safeText(source, 160),
    message: safeText(message, 4_096),
  };
  const error = errorRecord(cause);
  if (error) record.error = error;
  return record;
}

function errorRecord(cause: unknown): DesktopLogRecord["error"] | undefined {
  if (!cause || (typeof cause !== "object" && typeof cause !== "string")) return undefined;
  if (typeof cause === "string") return { message: safeText(cause, 4_096) };
  const value = cause as Record<string, unknown>;
  const result: NonNullable<DesktopLogRecord["error"]> = {};
  if (typeof value.name === "string") result.name = safeText(value.name, 160);
  if (typeof value.code === "string" || typeof value.code === "number") {
    result.code = safeText(String(value.code), 160);
  }
  if (typeof value.message === "string") result.message = safeText(value.message, 4_096);
  if (typeof value.stack === "string") result.stack = safeText(value.stack, 16_384);
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeText(value: string, maxLength: number): string {
  return redactSensitiveText(value).slice(0, maxLength);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:authorization|token|password|secret|api[_-]?key)\s*[=:]\s*["']?)[^\s,"';}]+/gi,
      "$1[REDACTED]",
    );
}

function serializeRecord(record: DesktopLogRecord, maxFileBytes: number): string | null {
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized, "utf8") <= maxFileBytes) return serialized;
  const minimal = `${JSON.stringify({
    timestamp: record.timestamp,
    level: record.level,
    source: record.source,
    message: "Log entry exceeded the configured file size limit.",
  })}\n`;
  return Buffer.byteLength(minimal, "utf8") <= maxFileBytes ? minimal : null;
}

async function rotateLogs(logPath: string, archiveCount: number): Promise<boolean> {
  try {
    await rm(`${logPath}.${archiveCount}`, { force: true });
    for (let index = archiveCount - 1; index >= 1; index -= 1) {
      await renameIfPresent(`${logPath}.${index}`, `${logPath}.${index + 1}`);
    }
    await renameIfPresent(logPath, `${logPath}.1`);
    return true;
  } catch {
    return false;
  }
}

async function renameIfPresent(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

const defaultLogger = createDesktopDiagnosticLogger();

export const initialize = defaultLogger.initialize.bind(defaultLogger);
export const info = defaultLogger.info.bind(defaultLogger);
export const warn = defaultLogger.warn.bind(defaultLogger);
export const error = defaultLogger.error.bind(defaultLogger);
export const flush = defaultLogger.flush.bind(defaultLogger);
export const installProcessStreamGuards = defaultLogger.installProcessStreamGuards.bind(defaultLogger);
