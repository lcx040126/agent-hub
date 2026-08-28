import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStore } from "../desktop/connection-store.js";
import type { CodexHookSessionState } from "./hook-state.js";
import { SessionEndQueueStore } from "./session-end-queue.js";
import { startSessionEndFinalizationWorker } from "./session-end-worker.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("session-end finalization worker", () => {
  it.each([409, 429, 503])("does not count repeated HTTP %i failures as exhausted local evidence", async (status) => {
    const userDataPath = await temporaryDirectory("agent-hub-session-end-http-");
    const queue = new SessionEndQueueStore(userDataPath);
    let now = new Date("2026-08-27T00:00:00.000Z");
    const job = await queue.enqueue(sessionState(userDataPath), undefined, now);
    await writeFile(path.join(queue.directory, "broken.json"), "{not-json", "utf8");
    const requestPaths: string[] = [];
    const errors: Error[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (request) => {
      requestPaths.push(new URL(request instanceof Request ? request.url : String(request)).pathname);
      return jsonResponse(status, {
        error: status === 409 ? "finalization_conflict" : "server_unavailable",
        message: "retry later",
      });
    });
    const worker = startSessionEndFinalizationWorker({
      userDataPath,
      store: connectionLookup(),
      fetchImpl,
      intervalMs: 60_000,
      now: () => now,
      onError: (error) => errors.push(error),
    });

    await worker.scanNow();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      now = new Date(now.getTime() + 10 * 60_000);
      await worker.scanNow();
    }
    await worker.stop();

    await expect(queue.load(job.finalizationId)).resolves.toMatchObject({
      attempts: 6,
      localEvidenceAttempts: 0,
      lastError: "retry later",
    });
    expect(requestPaths).toHaveLength(6);
    expect(requestPaths.every((pathname) => pathname.endsWith("/finalize/start"))).toBe(true);
    expect(errors.some((error) => error.message.includes("broken.json"))).toBe(true);
  });

  it("does not count an unknown transport TypeError as local evidence", async () => {
    const userDataPath = await temporaryDirectory("agent-hub-session-end-type-error-");
    const queue = new SessionEndQueueStore(userDataPath);
    let now = new Date("2026-08-27T00:00:00.000Z");
    const job = await queue.enqueue(sessionState(userDataPath), undefined, now);
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("terminated");
    });
    const worker = startSessionEndFinalizationWorker({
      userDataPath,
      store: connectionLookup(),
      fetchImpl,
      intervalMs: 60_000,
      now: () => now,
    });

    await worker.scanNow();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      now = new Date(now.getTime() + 10 * 60_000);
      await worker.scanNow();
    }
    await worker.stop();

    await expect(queue.load(job.finalizationId)).resolves.toMatchObject({
      attempts: 6,
      localEvidenceAttempts: 0,
      lastError: "terminated",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("does not count credential lookup failures as local evidence", async () => {
    const userDataPath = await temporaryDirectory("agent-hub-session-end-credential-");
    const queue = new SessionEndQueueStore(userDataPath);
    const now = new Date("2026-08-27T00:00:00.000Z");
    const job = await queue.enqueue(sessionState(userDataPath), undefined, now);
    const lookup = connectionLookup();
    lookup.readMemberToken = vi.fn(async () => {
      throw new Error("Windows secure storage is unavailable.");
    }) as ConnectionStore["readMemberToken"];
    const worker = startSessionEndFinalizationWorker({
      userDataPath,
      store: lookup,
      intervalMs: 60_000,
      now: () => now,
    });

    await worker.scanNow();
    await worker.stop();

    await expect(queue.load(job.finalizationId)).resolves.toMatchObject({
      attempts: 1,
      localEvidenceAttempts: 0,
      lastError: "Windows secure storage is unavailable.",
    });
  });

  it("retains the job when a feature snapshot endpoint returns a non-session 404", async () => {
    const userDataPath = await temporaryDirectory("agent-hub-session-end-snapshot-404-");
    const repositoryPath = path.join(userDataPath, "repository");
    const baseCommit = await createRepository(repositoryPath);
    const state = sessionState(repositoryPath);
    state.baseCommit = baseCommit;
    state.attributedChangedPaths = ["src/value.ts"];
    const queue = new SessionEndQueueStore(userDataPath);
    const now = new Date("2026-08-27T00:00:00.000Z");
    const job = await queue.enqueue(state, undefined, now);
    const requestPaths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (request) => {
      const pathname = new URL(request instanceof Request ? request.url : String(request)).pathname;
      requestPaths.push(pathname);
      if (pathname.endsWith("/finalize/start")) {
        return jsonResponse(200, { session: { id: job.hubSessionId } });
      }
      if (pathname === "/api/snapshot") {
        return jsonResponse(404, { error: "not_found", message: "Snapshot endpoint unavailable." });
      }
      throw new Error(`Unexpected finalization request: ${pathname}`);
    });
    const worker = startSessionEndFinalizationWorker({
      userDataPath,
      store: connectionLookup(),
      fetchImpl,
      intervalMs: 60_000,
      now: () => now,
    });

    await worker.scanNow();
    await worker.stop();

    await expect(queue.load(job.finalizationId)).resolves.toMatchObject({
      attempts: 1,
      localEvidenceAttempts: 0,
      lastError: "Snapshot endpoint unavailable.",
    });
    expect(requestPaths).toContain("/api/snapshot");
  });

  it("removes only an explicit session_not_found terminal response", async () => {
    const userDataPath = await temporaryDirectory("agent-hub-session-end-not-found-");
    const queue = new SessionEndQueueStore(userDataPath);
    const now = new Date("2026-08-27T00:00:00.000Z");
    await queue.enqueue(sessionState(userDataPath), undefined, now);
    const worker = startSessionEndFinalizationWorker({
      userDataPath,
      store: connectionLookup(),
      fetchImpl: async () => jsonResponse(404, {
        error: "session_not_found",
        message: "Session not found.",
      }),
      intervalMs: 60_000,
      now: () => now,
    });

    await worker.scanNow();
    await worker.stop();

    await expect(queue.list()).resolves.toEqual([]);
  });

  it("falls back only after five independent local evidence failures", async () => {
    const userDataPath = await temporaryDirectory("agent-hub-session-end-local-");
    const queue = new SessionEndQueueStore(userDataPath);
    let now = new Date("2026-08-27T00:00:00.000Z");
    const job = await queue.enqueue(sessionState(userDataPath), undefined, now);
    const requestPaths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (request) => {
      requestPaths.push(new URL(request instanceof Request ? request.url : String(request)).pathname);
      return jsonResponse(200, { session: { id: job.hubSessionId } });
    });
    const worker = startSessionEndFinalizationWorker({
      userDataPath,
      store: connectionLookup(),
      fetchImpl,
      gitExecutable: path.join(userDataPath, "missing-git"),
      intervalMs: 60_000,
      now: () => now,
    });

    await worker.scanNow();
    for (let attempt = 1; attempt < 4; attempt += 1) {
      now = new Date(now.getTime() + 10 * 60_000);
      await worker.scanNow();
    }
    await expect(queue.load(job.finalizationId)).resolves.toMatchObject({
      attempts: 4,
      localEvidenceAttempts: 4,
    });
    expect(requestPaths.filter((pathname) => pathname.endsWith("/finalize/complete"))).toHaveLength(0);

    now = new Date(now.getTime() + 10 * 60_000);
    await worker.scanNow();
    await worker.stop();

    await expect(queue.list()).resolves.toEqual([]);
    expect(requestPaths.filter((pathname) => pathname.endsWith("/finalize/complete"))).toHaveLength(1);
  });
});

function sessionState(repositoryPath: string): CodexHookSessionState {
  return {
    version: 1,
    codexSessionId: "worker-codex-session",
    connectionId: "worker-connection",
    hubSessionId: "worker-hub-session",
    finalizationId: "worker-finalization",
    repositoryPath,
    branch: "main",
    baseCommit: "0123456789abcdef",
    initialChangedPaths: [],
    initialChangedFingerprints: {},
    observedChangedPaths: [],
    observedChangedFingerprints: {},
    attributedChangedPaths: [],
    leases: [],
    openedAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

function connectionLookup(): Pick<ConnectionStore, "get" | "readMemberToken"> {
  return {
    get: vi.fn(async () => ({ serverUrl: "http://127.0.0.1:4173" })) as ConnectionStore["get"],
    readMemberToken: vi.fn(async () => "member-token") as ConnectionStore["readMemberToken"],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createRepository(repositoryPath: string): Promise<string> {
  await mkdir(path.join(repositoryPath, "src"), { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.name", "Agent Hub Test"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.email", "agent-hub@example.invalid"], { cwd: repositoryPath });
  await writeFile(path.join(repositoryPath, "src", "value.ts"), "export const value = 1;\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repositoryPath });
  return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })).stdout.trim();
}
