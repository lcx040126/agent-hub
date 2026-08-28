import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopDiagnosticLogger } from "./desktop-logger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("desktop diagnostic logger", () => {
  it("flushes startup records and serializes concurrent JSONL writes", async () => {
    const userDataPath = await temporaryDirectory();
    const logger = createDesktopDiagnosticLogger();
    logger.info("startup", "Buffered before initialization.");
    logger.warn("startup", "Second buffered record.");

    await logger.initialize({ userDataPath });
    for (let index = 0; index < 40; index += 1) {
      logger.info("concurrent", `Record ${index}`);
    }
    await logger.flush();

    const records = await readRecords(userDataPath, "desktop.log");
    expect(records).toHaveLength(42);
    expect(records[0]).toMatchObject({
      level: "info",
      source: "startup",
      message: "Buffered before initialization.",
    });
    expect(records.map((record) => record.message).slice(2)).toEqual(
      Array.from({ length: 40 }, (_, index) => `Record ${index}`),
    );
  });

  it("rotates at the configured limit and retains only three archives", async () => {
    const userDataPath = await temporaryDirectory();
    const logger = createDesktopDiagnosticLogger();
    await logger.initialize({ userDataPath, maxFileBytes: 512, archiveCount: 3 });

    for (let index = 0; index < 30; index += 1) {
      logger.warn("rotation", `${index}: ${"x".repeat(180)}`);
    }
    await logger.flush();

    const directory = logDirectory(userDataPath);
    for (const name of ["desktop.log", "desktop.log.1", "desktop.log.2", "desktop.log.3"]) {
      expect((await stat(path.join(directory, name))).size).toBeLessThanOrEqual(512);
    }
    await expect(stat(path.join(directory, "desktop.log.4"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("silently degrades when its log directory cannot be created", async () => {
    const directory = await temporaryDirectory();
    const invalidUserDataPath = path.join(directory, "not-a-directory");
    await writeFile(invalidUserDataPath, "file blocks directory creation", "utf8");
    const logger = createDesktopDiagnosticLogger();

    await expect(logger.initialize({ userDataPath: invalidUserDataPath })).resolves.toBeUndefined();
    expect(() => logger.error("filesystem", "Writing should remain best effort.", new Error("disk")))
      .not.toThrow();
    await expect(logger.flush()).resolves.toBeUndefined();
  });

  it("records only approved error fields and redacts common credential forms", async () => {
    const userDataPath = await temporaryDirectory();
    const logger = createDesktopDiagnosticLogger();
    await logger.initialize({ userDataPath });
    const cause = Object.assign(
      new Error("Authorization=Bearer secret-bearer token=secret-token"),
      {
        code: "EAUTH",
        token: "secret-property-token",
        headers: { authorization: "secret-header" },
        environment: { AGENT_HUB_TOKEN: "secret-environment" },
        scanBody: "secret-scan-body",
      },
    );

    logger.error("security", "password=secret-password", cause);
    await logger.flush();

    const text = await readFile(path.join(logDirectory(userDataPath), "desktop.log"), "utf8");
    for (const secret of [
      "secret-bearer",
      "secret-token",
      "secret-property-token",
      "secret-header",
      "secret-environment",
      "secret-scan-body",
      "secret-password",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(JSON.parse(text.trim())).toMatchObject({
      level: "error",
      source: "security",
      error: { name: "Error", code: "EAUTH" },
    });
  });

  it("absorbs stdout and stderr errors before initialization and keeps logging afterward", async () => {
    const userDataPath = await temporaryDirectory();
    const logger = createDesktopDiagnosticLogger();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    logger.installProcessStreamGuards({ stdout, stderr });
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

    expect(() => stdout.emit("error", epipe)).not.toThrow();
    await logger.initialize({ userDataPath });
    expect(() => stderr.emit("error", Object.assign(new Error("stream closed"), { code: "ECLOSED" })))
      .not.toThrow();
    logger.info("desktop.lifecycle", "Still running after stream errors.");
    await logger.flush();

    const records = await readRecords(userDataPath, "desktop.log");
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "process.stdout", error: expect.objectContaining({ code: "EPIPE" }) }),
      expect.objectContaining({ source: "process.stderr", error: expect.objectContaining({ code: "ECLOSED" }) }),
      expect.objectContaining({ message: "Still running after stream errors." }),
    ]));
  });

  it("still guards stderr when a GUI process has no stdout stream", async () => {
    const userDataPath = await temporaryDirectory();
    const logger = createDesktopDiagnosticLogger();
    const stderr = new EventEmitter();
    logger.installProcessStreamGuards({ stdout: null, stderr });
    expect(() => stderr.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })))
      .not.toThrow();

    await logger.initialize({ userDataPath });
    const records = await readRecords(userDataPath, "desktop.log");
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "process.stderr", error: expect.objectContaining({ code: "EPIPE" }) }),
    ]));
  });
});

interface ParsedRecord {
  message: string;
  [key: string]: unknown;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-desktop-log-"));
  temporaryDirectories.push(directory);
  return directory;
}

function logDirectory(userDataPath: string): string {
  return path.join(userDataPath, "logs");
}

async function readRecords(userDataPath: string, name: string): Promise<ParsedRecord[]> {
  const text = await readFile(path.join(logDirectory(userDataPath), name), "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as ParsedRecord);
}
