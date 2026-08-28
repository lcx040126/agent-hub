import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentHubApp } from "../server/app.js";
import { AgentHubDatabase } from "../server/db.js";
import { FeatureMemoryStore } from "../server/feature-memory.js";
import { AgentHubService } from "../server/service.js";
import { ConnectionStore, type SecretProtector } from "../desktop/connection-store.js";
import { handleCodexHook, runCodexHook, type CodexHookInput, type RunCodexHookOptions } from "./codex-hook.js";
import { CodexHookStateStore } from "./hook-state.js";
import { IntegrationOperationTracker } from "./integration-operations.js";
import { PausePreparationQueue } from "./pause-preparation.js";
import { startRuntimePresence, type RuntimePresenceHandle } from "./runtime-presence.js";
import { startCodexSessionHeartbeatScheduler } from "./codex-session-heartbeat.js";
import { SessionEndQueueStore } from "./session-end-queue.js";
import { startSessionEndFinalizationWorker } from "./session-end-worker.js";
import { TurnCompletionQueueStore } from "./turn-completion-queue.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const databases: AgentHubDatabase[] = [];
const presences: RuntimePresenceHandle[] = [];

const protector: SecretProtector = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
  decryptString: (value) => {
    const text = value.toString("utf8");
    if (!text.startsWith("protected:")) throw new Error("Invalid test ciphertext.");
    return text.slice("protected:".length);
  },
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(presences.splice(0).map((presence) => presence.stop()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("Codex hook integration", () => {
  it("uses one connection resolution so a late match cannot bypass operation tracking", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-hook-resolution-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    const userDataPath = path.join(root, "user-data");
    await createRepository(repository);
    presences.push(await startRuntimePresence(path.join(userDataPath, "runtime-presence.json"), {
      heartbeatIntervalMs: 0,
    }));
    const store = new ConnectionStore(path.join(userDataPath, "connections.json"), protector);
    await store.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: repository,
    });
    const list = vi.spyOn(ConnectionStore.prototype, "list").mockResolvedValueOnce([]);
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(handleCodexHook({
      eventName: "SessionStart",
      userDataPath,
      protector,
      fetchImpl,
    }, {
      session_id: "late-match-session",
      cwd: repository,
      hook_event_name: "SessionStart",
    })).resolves.toBeUndefined();

    expect(list).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  }, 10_000);

  it("recovers a higher stopped activity epoch when the server reuses a Codex session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-hook-epoch-recovery-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    const userDataPath = path.join(root, "user-data");
    await createRepository(repository);
    presences.push(await startRuntimePresence(path.join(userDataPath, "runtime-presence.json"), {
      heartbeatIntervalMs: 0,
    }));
    const store = new ConnectionStore(path.join(userDataPath, "connections.json"), protector);
    await store.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: repository,
    });
    const stoppedAt = "2026-08-27T00:00:00.000Z";
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/sessions") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          codexSessionId: "reused-codex-session",
          activityEpoch: 0,
        });
        return jsonResponse({
          session: {
            id: "hub-reused",
            reused: true,
            currentTurnId: "turn-9",
            activityEpoch: 9,
            turnStoppedAt: stoppedAt,
          },
        });
      }
      if (pathname === "/api/snapshot") return jsonResponse({});
      if (pathname === "/api/features/query") return jsonResponse({ cards: [] });
      if (pathname.endsWith("/scan")) return jsonResponse({});
      throw new Error(`Unexpected request: ${pathname}`);
    });

    await handleCodexHook({
      eventName: "SessionStart",
      userDataPath,
      protector,
      fetchImpl,
    }, {
      session_id: "reused-codex-session",
      cwd: repository,
      hook_event_name: "SessionStart",
      source: "resume",
    });

    await expect(new CodexHookStateStore(userDataPath).load("reused-codex-session"))
      .resolves.toMatchObject({
        hubSessionId: "hub-reused",
        leaseAttributionComplete: false,
        activityEpoch: 9,
        currentTurnId: "turn-9",
        pendingCompletion: { phase: "stopped", activityEpoch: 9, recordedAt: stoppedAt },
    });
  }, 10_000);

  it("keeps a reused remote session fenced while its lease attribution is incomplete", async () => {
    const fixture = await createConnectedHookFixture("reused-lease-fence", "reused-lease-fence-session");
    const stateStore = new CodexHookStateStore(fixture.userDataPath);
    const baseCommit = (await outputGit(fixture.repository, ["rev-parse", "HEAD"])).trim();
    let failPrepare = false;
    let failWriteBlockedSync = false;
    const writeBlockedBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<typeof fetch>((request, init) => {
      const pathname = new URL(request instanceof Request ? request.url : String(request)).pathname;
      if (pathname.endsWith("/write-blocked") && typeof init?.body === "string") {
        writeBlockedBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      if (failWriteBlockedSync && pathname.endsWith("/write-blocked")) {
        throw new TypeError("write-blocked sync offline");
      }
      if (failPrepare && pathname === "/api/edits/prepare") {
        throw new TypeError("fetch failed");
      }
      return fetch(request, init);
    });
    const options = (eventName: RunCodexHookOptions["eventName"]) =>
      fixture.options(eventName, fetchImpl);
    const turnId = "reused-lease-fence-turn";

    await handleCodexHook(options("SessionStart"), fixture.input("SessionStart", {
      turn_id: turnId,
      source: "startup",
    }));
    const originalState = (await stateStore.load(fixture.sessionId))!;
    const remoteLease = fixture.service.claimLease({
      memberToken: fixture.room.memberToken,
      sessionId: originalState.hubSessionId,
      title: "Lease missing from local state",
      branch: "main",
      baseCommit,
      paths: ["src/value.ts"],
      mode: "write",
      autoClaim: true,
    });
    expect(remoteLease.acquired).toBe(true);
    if (!remoteLease.acquired) throw new Error("Expected the remote lease to be acquired.");

    const holderSession = fixture.service.openSession({
      memberToken: fixture.room.memberToken,
      codexSessionId: "reused-lease-older-holder",
      branch: "main",
      baseCommit,
    });
    const holder = fixture.service.claimLease({
      memberToken: fixture.room.memberToken,
      sessionId: holderSession.id,
      title: "Older holder after local state loss",
      branch: "main",
      baseCommit,
      paths: ["src/holder.ts"],
      mode: "write",
      autoClaim: true,
    });
    expect(holder.acquired).toBe(true);

    await stateStore.remove(fixture.sessionId);
    await handleCodexHook(options("SessionStart"), fixture.input("SessionStart", {
      turn_id: turnId,
      source: "resume",
    }));
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      hubSessionId: originalState.hubSessionId,
      leases: [],
      leaseAttributionComplete: false,
    });

    const pathlessWrite = await handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "Bash",
      tool_input: { command: "pnpm run build" },
    }));
    expect(pathlessWrite).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(JSON.stringify(pathlessWrite)).toContain("缺少该会话的完整租约状态");

    const verifiedCommand = "*** Begin Patch\n*** Update File: src/value.ts\n*** End Patch";
    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: { command: verifiedCommand },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      leaseAttributionComplete: false,
    });
    await handleCodexHook(options("PostToolUse"), fixture.input("PostToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: { command: verifiedCommand },
    }));

    failPrepare = true;
    const offlineExplicitWrite = await handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Update File: src/foo.ts\n*** End Patch",
      },
    }));
    expect(offlineExplicitWrite).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    failPrepare = false;

    failWriteBlockedSync = true;
    const waitingWrite = await handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Add File: src/holder.ts\n*** End Patch",
      },
    }));
    expect(waitingWrite).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(writeBlockedBodies.at(-1)).toMatchObject({ dirty: true, paths: ["src/holder.ts"] });
    expect(fixture.service.getDashboard(fixture.room.memberToken).leases).toEqual(
      expect.arrayContaining([expect.objectContaining({
        id: remoteLease.lease.id,
        sessionId: originalState.hubSessionId,
        status: "active",
        phase: "working",
      })]),
    );
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      leases: [],
      leaseAttributionComplete: false,
      passiveWriteBlock: { requestedPaths: ["src/holder.ts"] },
      writeBlockSyncPending: { dirty: true, paths: ["src/holder.ts"] },
    });

    failWriteBlockedSync = false;
    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: { command: verifiedCommand },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(fixture.service.getDashboard(fixture.room.memberToken).leases).toEqual(
      expect.arrayContaining([expect.objectContaining({
        id: remoteLease.lease.id,
        status: "active",
        phase: "blocked",
      })]),
    );
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      leaseAttributionComplete: false,
      writeBlockSyncPending: undefined,
    });
  }, 30_000);

  it("establishes the first real prompt turn once before the first write", async () => {
    const fixture = await createConnectedHookFixture("first-prompt", "first-prompt-session");
    const fetchImpl = vi.fn<typeof fetch>((request, init) => fetch(request, init));
    const options = (eventName: RunCodexHookOptions["eventName"]) =>
      fixture.options(eventName, fetchImpl);
    const stateStore = new CodexHookStateStore(fixture.userDataPath);

    await handleCodexHook(options("SessionStart"), fixture.input("SessionStart", {
      source: "startup",
    }));
    const initial = (await stateStore.load(fixture.sessionId))!;
    expect(initial).toMatchObject({ activityEpoch: 0 });
    expect(initial.currentTurnId).not.toBe("first-real-turn");

    const requestsBeforeMissingTurn = fetchImpl.mock.calls.length;
    await handleCodexHook(options("UserPromptSubmit"), fixture.input("UserPromptSubmit"));
    expect(fetchImpl).toHaveBeenCalledTimes(requestsBeforeMissingTurn);
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      activityEpoch: 0,
      currentTurnId: initial.currentTurnId,
    });

    await handleCodexHook(options("UserPromptSubmit"), fixture.input("UserPromptSubmit", {
      turn_id: "first-real-turn",
    }));
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      activityEpoch: 1,
      currentTurnId: "first-real-turn",
    });
    const requestsAfterFirstPrompt = fetchImpl.mock.calls.length;
    await handleCodexHook(options("UserPromptSubmit"), fixture.input("UserPromptSubmit", {
      turn_id: "first-real-turn",
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(requestsAfterFirstPrompt);

    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: "first-real-turn",
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Update File: src/value.ts\n@@\n-export const value = 1;\n+export const value = 2;\n*** End Patch",
      },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    expect(fixture.service.listRoomSessions(fixture.room.memberToken).sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({
        codexSessionId: fixture.sessionId,
        currentTurnId: "first-real-turn",
        activityEpoch: 1,
      })]),
    );
  }, 20_000);

  it("lets the first write recover when prompt turn registration is offline", async () => {
    const fixture = await createConnectedHookFixture("prompt-fallback", "prompt-fallback-session");
    let promptAttempts = 0;
    let prepareAttempts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (request, init) => {
      const pathname = new URL(request instanceof Request ? request.url : String(request)).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      const metadata = body.metadata as Record<string, unknown> | undefined;
      if (pathname === "/api/sessions" && metadata?.event === "UserPromptSubmit") {
        promptAttempts += 1;
        throw new TypeError("prompt registration offline");
      }
      if (pathname === "/api/edits/prepare") prepareAttempts += 1;
      return fetch(request, init);
    });
    const options = (eventName: RunCodexHookOptions["eventName"]) =>
      fixture.options(eventName, fetchImpl);
    const stateStore = new CodexHookStateStore(fixture.userDataPath);

    await handleCodexHook(options("SessionStart"), fixture.input("SessionStart", {
      source: "startup",
    }));
    const initialTurnId = (await stateStore.load(fixture.sessionId))?.currentTurnId;
    await handleCodexHook(options("UserPromptSubmit"), fixture.input("UserPromptSubmit", {
      turn_id: "fallback-real-turn",
    }));
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      activityEpoch: 0,
      currentTurnId: initialTurnId,
    });

    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: "fallback-real-turn",
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Update File: src/value.ts\n@@\n-export const value = 1;\n+export const value = 2;\n*** End Patch",
      },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    expect(promptAttempts).toBe(1);
    expect(prepareAttempts).toBe(2);
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      activityEpoch: 1,
      currentTurnId: "fallback-real-turn",
    });
  }, 20_000);

  it("denies the stale-epoch write when its authoritative retry goes offline", async () => {
    const fixture = await createConnectedHookFixture("prompt-retry-offline", "prompt-retry-offline-session");
    let prepareAttempts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (request, init) => {
      const pathname = new URL(request instanceof Request ? request.url : String(request)).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      const metadata = body.metadata as Record<string, unknown> | undefined;
      if (pathname === "/api/sessions" && metadata?.event === "UserPromptSubmit") {
        throw new TypeError("prompt registration offline");
      }
      if (pathname === "/api/edits/prepare") {
        prepareAttempts += 1;
        if (prepareAttempts === 2) {
          return new Response(JSON.stringify({
            error: "rate_limited",
            message: "Authoritative retry was rate limited.",
          }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return fetch(request, init);
    });
    const options = (eventName: RunCodexHookOptions["eventName"]) =>
      fixture.options(eventName, fetchImpl);

    await handleCodexHook(options("SessionStart"), fixture.input("SessionStart", {
      source: "startup",
    }));
    await handleCodexHook(options("UserPromptSubmit"), fixture.input("UserPromptSubmit", {
      turn_id: "retry-offline-real-turn",
    }));
    const hookInput = fixture.input("PreToolUse", {
      turn_id: "retry-offline-real-turn",
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Update File: src/value.ts\n*** End Patch",
      },
    });
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    await expect(runCodexHook({
      ...options("PreToolUse"),
      stdin: Readable.from([JSON.stringify(hookInput)]),
      stdout,
    })).resolves.toBe(0);
    const denied = JSON.parse(output) as Record<string, unknown>;
    expect(denied).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(JSON.stringify(denied)).toContain("权威恢复未能完整完成");
    expect(prepareAttempts).toBe(2);
  }, 20_000);

  it("denies through the real Hook entry when stale-epoch session recovery returns 503", async () => {
    const fixture = await createConnectedHookFixture("prompt-recovery-503", "prompt-recovery-503-session");
    const fetchImpl = vi.fn<typeof fetch>(async (request, init) => {
      const pathname = new URL(request instanceof Request ? request.url : String(request)).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      const metadata = body.metadata as Record<string, unknown> | undefined;
      if (pathname === "/api/sessions" && metadata?.event === "UserPromptSubmit") {
        throw new TypeError("prompt registration offline");
      }
      if (pathname === "/api/sessions" && metadata?.event === "stale_activity_epoch_recovery") {
        return new Response(JSON.stringify({
          error: "service_unavailable",
          message: "Session recovery is temporarily unavailable.",
        }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return fetch(request, init);
    });
    const options = (eventName: RunCodexHookOptions["eventName"]) =>
      fixture.options(eventName, fetchImpl);
    await handleCodexHook(options("SessionStart"), fixture.input("SessionStart", { source: "startup" }));
    await handleCodexHook(options("UserPromptSubmit"), fixture.input("UserPromptSubmit", {
      turn_id: "recovery-503-real-turn",
    }));

    const hookInput = fixture.input("PreToolUse", {
      turn_id: "recovery-503-real-turn",
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Update File: src/value.ts\n*** End Patch",
      },
    });
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    await expect(runCodexHook({
      ...options("PreToolUse"),
      stdin: Readable.from([JSON.stringify(hookInput)]),
      stdout,
    })).resolves.toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(output).toContain("权威恢复未能完整完成");
  }, 20_000);

  it("resumes pending completion for a new prompt without a second epoch advance", async () => {
    const fixture = await createConnectedHookFixture("prompt-resume", "prompt-resume-session");
    const requestPaths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (request, init) => {
      requestPaths.push(new URL(request instanceof Request ? request.url : String(request)).pathname);
      return fetch(request, init);
    });
    const options = (eventName: RunCodexHookOptions["eventName"]) =>
      fixture.options(eventName, fetchImpl);
    const stateStore = new CodexHookStateStore(fixture.userDataPath);

    await handleCodexHook(options("SessionStart"), fixture.input("SessionStart", {
      turn_id: "turn-before-stop",
      source: "startup",
    }));
    const state = (await stateStore.load(fixture.sessionId))!;
    fixture.service.stopSessionActivity({
      memberToken: fixture.room.memberToken,
      sessionId: state.hubSessionId,
      operationId: "prompt-resume-stop",
      turnId: "turn-before-stop",
      activityEpoch: 0,
    });
    const queue = new TurnCompletionQueueStore(fixture.userDataPath);
    await queue.enqueue({
      operationId: "prompt-resume-stop",
      turnId: "turn-before-stop",
      activityEpoch: 0,
      state,
    });
    state.pendingCompletion = {
      operationId: "prompt-resume-stop",
      turnId: "turn-before-stop",
      activityEpoch: 0,
      phase: "stopped",
      recordedAt: "2026-08-28T00:00:00.000Z",
    };
    await stateStore.save(state);
    requestPaths.length = 0;

    await handleCodexHook(options("UserPromptSubmit"), fixture.input("UserPromptSubmit", {
      turn_id: "turn-after-stop",
    }));
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      activityEpoch: 1,
      currentTurnId: "turn-after-stop",
      pendingCompletion: undefined,
    });
    await expect(queue.listForSession(fixture.sessionId)).resolves.toEqual([]);
    expect(requestPaths).toEqual([
      `/api/sessions/${encodeURIComponent(state.hubSessionId)}/resume`,
    ]);

    const requestCountAfterResume = fetchImpl.mock.calls.length;
    await handleCodexHook(options("UserPromptSubmit"), fixture.input("UserPromptSubmit", {
      turn_id: "turn-after-stop",
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(requestCountAfterResume);
    expect(fixture.service.listRoomSessions(fixture.room.memberToken).sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({
        id: state.hubSessionId,
        currentTurnId: "turn-after-stop",
        activityEpoch: 1,
        turnStoppedAt: null,
      })]),
    );
  }, 20_000);

  it("keeps an in-flight lease blocked and denies pathless writes after a same-member wait", async () => {
    const fixture = await createConnectedHookFixture("pending-write-block", "pending-write-block-session");
    const baseCommit = (await outputGit(fixture.repository, ["rev-parse", "HEAD"])).trim();
    const holderSession = fixture.service.openSession({
      memberToken: fixture.room.memberToken,
      codexSessionId: "older-holder-session",
      turnId: "older-holder-turn",
      activityEpoch: 0,
      branch: "main",
      baseCommit,
    });
    const holder = fixture.service.claimLease({
      memberToken: fixture.room.memberToken,
      sessionId: holderSession.id,
      title: "Older same-member holder",
      branch: "main",
      baseCommit,
      paths: ["src/holder.ts"],
      mode: "write",
      autoClaim: true,
    });
    expect(holder.acquired).toBe(true);

    const requestPaths: string[] = [];
    let failPrepare = false;
    const fetchImpl = vi.fn<typeof fetch>((request, init) => {
      const pathname = new URL(request instanceof Request ? request.url : String(request)).pathname;
      requestPaths.push(pathname);
      if (failPrepare && pathname === "/api/edits/prepare") throw new TypeError("fetch failed");
      return fetch(request, init);
    });
    const options = (eventName: RunCodexHookOptions["eventName"]) =>
      fixture.options(eventName, fetchImpl);
    const stateStore = new CodexHookStateStore(fixture.userDataPath);
    await handleCodexHook(options("SessionStart"), fixture.input("SessionStart", {
      turn_id: "pending-write-turn",
      source: "startup",
    }));

    const firstWrite = await handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: "pending-write-turn",
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Update File: src/value.ts\n*** End Patch",
      },
    }));
    expect(firstWrite).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    const pendingState = (await stateStore.load(fixture.sessionId))!;
    expect(pendingState).toMatchObject({ pendingWrite: { toolName: "apply_patch" } });
    expect(pendingState.leases).toHaveLength(1);

    const waitingWrite = await handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: "pending-write-turn",
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Add File: src/holder.ts\n*** End Patch",
      },
    }));
    expect(waitingWrite).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(JSON.stringify(waitingWrite)).toContain("正在等待");

    const blockedState = (await stateStore.load(fixture.sessionId))!;
    expect(blockedState.leases).toEqual([
      expect.objectContaining({
        id: pendingState.leases[0]!.id,
        coordinationState: "blocked",
      }),
    ]);
    expect(fixture.service.getDashboard(fixture.room.memberToken).leases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: pendingState.leases[0]!.id,
          sessionId: pendingState.hubSessionId,
          status: "active",
          phase: "blocked",
        }),
      ]),
    );
    blockedState.leases[0]!.expiresAt = new Date(Date.now() - 1_000).toISOString();
    await stateStore.save(blockedState);

    const prepareCallsBeforePathlessWrite = requestPaths.filter((requestPath) =>
      requestPath === "/api/edits/prepare").length;
    const pathlessWrite = await handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: "pending-write-turn",
      tool_name: "Bash",
      tool_input: { command: "pnpm run build" },
    }));
    expect(pathlessWrite).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(JSON.stringify(pathlessWrite)).toContain("正在等待 Alice 释放较早会话的写入范围");
    expect(requestPaths.filter((requestPath) => requestPath === "/api/edits/prepare"))
      .toHaveLength(prepareCallsBeforePathlessWrite);

    const blockedOnlyState = (await stateStore.load(fixture.sessionId))!;
    blockedOnlyState.passiveWriteBlock = undefined;
    await stateStore.save(blockedOnlyState);
    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: "pending-write-turn",
      tool_name: "Bash",
      tool_input: { command: "pnpm run build" },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    failPrepare = true;
    const offlineExplicitWrite = await handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: "pending-write-turn",
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Update File: src/value.ts\n*** End Patch",
      },
    }));
    expect(offlineExplicitWrite).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  }, 20_000);

  it("retries an unconfirmed write-blocked transition before any later explicit write", async () => {
    const fixture = await createConnectedHookFixture("blocked-sync-retry", "blocked-sync-retry-session");
    const baseCommit = (await outputGit(fixture.repository, ["rev-parse", "HEAD"])).trim();
    const holderSession = fixture.service.openSession({
      memberToken: fixture.room.memberToken,
      codexSessionId: "blocked-sync-holder",
      branch: "main",
      baseCommit,
    });
    const holder = fixture.service.claimLease({
      memberToken: fixture.room.memberToken,
      sessionId: holderSession.id,
      title: "Blocked sync holder",
      branch: "main",
      baseCommit,
      paths: ["src/holder.ts"],
      mode: "write",
      autoClaim: true,
    });
    expect(holder.acquired).toBe(true);

    let failBlockedSync = false;
    const requestPaths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>((request, init) => {
      const pathname = new URL(request instanceof Request ? request.url : String(request)).pathname;
      requestPaths.push(pathname);
      if (failBlockedSync && pathname.endsWith("/write-blocked")) {
        throw new TypeError("write-blocked sync offline");
      }
      return fetch(request, init);
    });
    const options = (eventName: RunCodexHookOptions["eventName"]) =>
      fixture.options(eventName, fetchImpl);
    const stateStore = new CodexHookStateStore(fixture.userDataPath);
    const turnId = "blocked-sync-retry-turn";
    await handleCodexHook(options("SessionStart"), fixture.input("SessionStart", {
      turn_id: turnId,
      source: "startup",
    }));

    const ownedCommand = "*** Begin Patch\n*** Update File: src/value.ts\n*** End Patch";
    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: { command: ownedCommand },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    const ownedState = (await stateStore.load(fixture.sessionId))!;
    expect(ownedState.leases).toHaveLength(1);

    failBlockedSync = true;
    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Add File: src/holder.ts\n*** End Patch",
      },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      leases: [expect.objectContaining({
        id: ownedState.leases[0]!.id,
        coordinationState: "blocked",
      })],
      writeBlockSyncPending: { dirty: true, paths: ["src/holder.ts"] },
    });
    expect(fixture.service.getDashboard(fixture.room.memberToken).leases).toEqual(
      expect.arrayContaining([expect.objectContaining({
        id: ownedState.leases[0]!.id,
        phase: "working",
      })]),
    );
    failBlockedSync = false;
    const preparesBeforeRetry = requestPaths.filter((pathname) => pathname === "/api/edits/prepare").length;
    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: { command: ownedCommand },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(requestPaths.filter((pathname) => pathname === "/api/edits/prepare"))
      .toHaveLength(preparesBeforeRetry);
    expect(fixture.service.getDashboard(fixture.room.memberToken).leases).toEqual(
      expect.arrayContaining([expect.objectContaining({
        id: ownedState.leases[0]!.id,
        status: "active",
        phase: "blocked",
      })]),
    );
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      writeBlockSyncPending: undefined,
    });
  }, 30_000);

  it("serializes PostToolUse behind a waiting PreToolUse fence and never prepares through pending sync", async () => {
    const fixture = await createConnectedHookFixture("post-fence-race", "post-fence-race-session");
    const baseCommit = (await outputGit(fixture.repository, ["rev-parse", "HEAD"])).trim();
    const holderSession = fixture.service.openSession({
      memberToken: fixture.room.memberToken,
      codexSessionId: "post-fence-holder",
      branch: "main",
      baseCommit,
    });
    const holder = fixture.service.claimLease({
      memberToken: fixture.room.memberToken,
      sessionId: holderSession.id,
      title: "Post fence holder",
      branch: "main",
      baseCommit,
      paths: ["src/holder.ts"],
      mode: "write",
      autoClaim: true,
    });
    expect(holder.acquired).toBe(true);

    let markSyncStarted!: () => void;
    const syncStarted = new Promise<void>((resolve) => { markSyncStarted = resolve; });
    let releaseFirstSync!: () => void;
    const firstSyncReleased = new Promise<void>((resolve) => { releaseFirstSync = resolve; });
    let writeBlockedCalls = 0;
    const requestPaths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (request, init) => {
      const pathname = new URL(request instanceof Request ? request.url : String(request)).pathname;
      requestPaths.push(pathname);
      if (pathname.endsWith("/write-blocked")) {
        writeBlockedCalls += 1;
        if (writeBlockedCalls === 1) {
          markSyncStarted();
          await firstSyncReleased;
        }
        throw new TypeError("write-blocked sync offline");
      }
      return fetch(request, init);
    });
    const options = (eventName: RunCodexHookOptions["eventName"]) =>
      fixture.options(eventName, fetchImpl);
    const stateStore = new CodexHookStateStore(fixture.userDataPath);
    const turnId = "post-fence-race-turn";
    await handleCodexHook(options("SessionStart"), fixture.input("SessionStart", {
      turn_id: turnId,
      source: "startup",
    }));

    const completedCommand = "*** Begin Patch\n*** Update File: src/value.ts\n*** End Patch";
    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: { command: completedCommand },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    await writeFile(path.join(fixture.repository, "src", "value.ts"), "export const value = 2;\n", "utf8");

    const waitingPre = handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Add File: src/holder.ts\n*** End Patch",
      },
    }));
    await syncStarted;
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      writeBlockSyncPending: { dirty: true, paths: ["src/holder.ts"] },
    });
    const prepareCountAtFence = requestPaths.filter((pathname) => pathname === "/api/edits/prepare").length;
    const completedPost = handleCodexHook(options("PostToolUse"), fixture.input("PostToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: { command: completedCommand },
    }));
    releaseFirstSync();

    await expect(waitingPre).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await expect(completedPost).resolves.toMatchObject({
      continue: false,
      hookSpecificOutput: { hookEventName: "PostToolUse" },
    });
    expect(requestPaths.filter((pathname) => pathname === "/api/edits/prepare"))
      .toHaveLength(prepareCountAtFence);
    expect(writeBlockedCalls).toBe(2);
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      attributedChangedPaths: ["src/value.ts"],
      pendingWrite: undefined,
      writeBlockSyncPending: { dirty: true, paths: ["src/holder.ts"] },
    });
  }, 30_000);

  it("clears stale local leases when a clean write-blocked retry returns an empty idempotent response", async () => {
    const fixture = await createConnectedHookFixture("clean-sync-idempotent", "clean-sync-idempotent-session");
    const baseCommit = (await outputGit(fixture.repository, ["rev-parse", "HEAD"])).trim();
    const holderSession = fixture.service.openSession({
      memberToken: fixture.room.memberToken,
      codexSessionId: "clean-sync-holder",
      branch: "main",
      baseCommit,
    });
    const holder = fixture.service.claimLease({
      memberToken: fixture.room.memberToken,
      sessionId: holderSession.id,
      title: "Clean sync holder",
      branch: "main",
      baseCommit,
      paths: ["src/holder.ts"],
      mode: "write",
      autoClaim: true,
    });
    expect(holder.acquired).toBe(true);

    let loseFirstWriteBlockedResponse = true;
    const fetchImpl = vi.fn<typeof fetch>(async (request, init) => {
      const pathname = new URL(request instanceof Request ? request.url : String(request)).pathname;
      if (loseFirstWriteBlockedResponse && pathname.endsWith("/write-blocked")) {
        loseFirstWriteBlockedResponse = false;
        await fetch(request, init);
        throw new TypeError("write-blocked response lost");
      }
      return fetch(request, init);
    });
    const options = (eventName: RunCodexHookOptions["eventName"]) =>
      fixture.options(eventName, fetchImpl);
    const stateStore = new CodexHookStateStore(fixture.userDataPath);
    const turnId = "clean-sync-idempotent-turn";
    await handleCodexHook(options("SessionStart"), fixture.input("SessionStart", {
      turn_id: turnId,
      source: "startup",
    }));

    const ownedCommand = "*** Begin Patch\n*** Update File: src/value.ts\n*** End Patch";
    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: { command: ownedCommand },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    await handleCodexHook(options("PostToolUse"), fixture.input("PostToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: { command: ownedCommand },
    }));
    const ownedLeaseId = (await stateStore.load(fixture.sessionId))!.leases[0]!.id;

    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Add File: src/holder.ts\n*** End Patch",
      },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      leases: [expect.objectContaining({ id: ownedLeaseId })],
      writeBlockSyncPending: { dirty: false, paths: ["src/holder.ts"] },
    });

    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "Bash",
      tool_input: { command: "pnpm run build" },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      leases: [],
      writeBlockSyncPending: undefined,
      passiveWriteBlock: { leaseId: holder.acquired ? holder.lease.id : "" },
    });
  }, 30_000);

  it("denies a pathless write while its only write-blocked synchronization marker is unconfirmed", async () => {
    const fixture = await createConnectedHookFixture("pathless-sync-fence", "pathless-sync-fence-session");
    const requestPaths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>((request, init) => {
      const pathname = new URL(request instanceof Request ? request.url : String(request)).pathname;
      requestPaths.push(pathname);
      if (pathname.endsWith("/write-blocked")) throw new TypeError("write-blocked sync offline");
      return fetch(request, init);
    });
    const options = (eventName: RunCodexHookOptions["eventName"]) =>
      fixture.options(eventName, fetchImpl);
    const stateStore = new CodexHookStateStore(fixture.userDataPath);
    await handleCodexHook(options("SessionStart"), fixture.input("SessionStart", {
      turn_id: "pathless-sync-turn",
      source: "startup",
    }));
    const state = (await stateStore.load(fixture.sessionId))!;
    state.leases = [];
    state.passiveWriteBlock = undefined;
    state.writeBlockSyncPending = {
      dirty: false,
      paths: ["src/unknown-sync.ts"],
      recordedAt: new Date().toISOString(),
    };
    await stateStore.save(state);
    const preparesBefore = requestPaths.filter((pathname) => pathname === "/api/edits/prepare").length;

    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: "pathless-sync-turn",
      tool_name: "Bash",
      tool_input: { command: "pnpm run build" },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(requestPaths.filter((pathname) => pathname === "/api/edits/prepare"))
      .toHaveLength(preparesBefore);
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      leases: [],
      passiveWriteBlock: undefined,
      writeBlockSyncPending: { dirty: false, paths: ["src/unknown-sync.ts"] },
    });
  }, 20_000);

  it("removes a locally cached lease when a clean same-member wait cancels it", async () => {
    const fixture = await createConnectedHookFixture("clean-write-block", "clean-write-block-session");
    const baseCommit = (await outputGit(fixture.repository, ["rev-parse", "HEAD"])).trim();
    const holderSession = fixture.service.openSession({
      memberToken: fixture.room.memberToken,
      codexSessionId: "clean-older-holder-session",
      branch: "main",
      baseCommit,
    });
    const holder = fixture.service.claimLease({
      memberToken: fixture.room.memberToken,
      sessionId: holderSession.id,
      title: "Older clean holder",
      branch: "main",
      baseCommit,
      paths: ["src/holder.ts"],
      mode: "write",
      autoClaim: true,
    });
    expect(holder.acquired).toBe(true);
    if (!holder.acquired) throw new Error("Expected the older clean holder lease to be acquired.");

    const options = (eventName: RunCodexHookOptions["eventName"]) => fixture.options(eventName);
    const stateStore = new CodexHookStateStore(fixture.userDataPath);
    await handleCodexHook(options("SessionStart"), fixture.input("SessionStart", {
      turn_id: "clean-write-turn",
      source: "startup",
    }));
    const command = "*** Begin Patch\n*** Update File: src/value.ts\n*** End Patch";
    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: "clean-write-turn",
      tool_name: "apply_patch",
      tool_input: { command },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    const claimedState = (await stateStore.load(fixture.sessionId))!;
    expect(claimedState.leases).toHaveLength(1);

    await handleCodexHook(options("PostToolUse"), fixture.input("PostToolUse", {
      turn_id: "clean-write-turn",
      tool_name: "apply_patch",
      tool_input: { command },
    }));
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      pendingWrite: undefined,
      attributedChangedPaths: [],
    });

    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: "clean-write-turn",
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Add File: src/holder.ts\n*** End Patch",
      },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      leases: [],
      passiveWriteBlock: {
        leaseId: holder.lease.id,
        sessionId: holderSession.id,
        memberName: "Alice",
        paths: ["src/holder.ts"],
      },
    });
    expect(fixture.service.getDashboard(fixture.room.memberToken).leases.map((lease) => lease.id))
      .not.toContain(claimedState.leases[0]!.id);

    const pathlessWrite = await handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: "clean-write-turn",
      tool_name: "Bash",
      tool_input: { command: "pnpm run build" },
    }));
    expect(pathlessWrite).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(JSON.stringify(pathlessWrite)).toContain("正在等待 Alice 释放较早会话的写入范围");
  }, 20_000);

  it("keeps a passive write fence after its cached expiry and clears it only after explicit reclaim", async () => {
    const fixture = await createConnectedHookFixture("passive-write-block", "passive-write-block-session");
    const baseCommit = (await outputGit(fixture.repository, ["rev-parse", "HEAD"])).trim();
    const holderSession = fixture.service.openSession({
      memberToken: fixture.room.memberToken,
      codexSessionId: "passive-holder-session",
      branch: "main",
      baseCommit,
    });
    const holder = fixture.service.claimLease({
      memberToken: fixture.room.memberToken,
      sessionId: holderSession.id,
      title: "Passive wait holder",
      branch: "main",
      baseCommit,
      paths: ["src/holder.ts"],
      mode: "write",
      autoClaim: true,
    });
    expect(holder.acquired).toBe(true);
    if (!holder.acquired) throw new Error("Expected the passive wait holder lease to be acquired.");

    let failPrepare = false;
    let failWriteBlockedSync = true;
    const fetchImpl = vi.fn<typeof fetch>((request, init) => {
      const pathname = new URL(request instanceof Request ? request.url : String(request)).pathname;
      if (failPrepare && pathname === "/api/edits/prepare") {
        throw new TypeError("fetch failed");
      }
      if (failWriteBlockedSync && pathname.endsWith("/write-blocked")) {
        throw new TypeError("write-blocked sync offline");
      }
      return fetch(request, init);
    });
    const options = (eventName: RunCodexHookOptions["eventName"]) =>
      fixture.options(eventName, fetchImpl);
    const stateStore = new CodexHookStateStore(fixture.userDataPath);
    await handleCodexHook(options("SessionStart"), fixture.input("SessionStart", {
      turn_id: "passive-write-turn",
      source: "startup",
    }));

    const waitingWrite = await handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: "passive-write-turn",
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Add File: src/holder.ts\n*** End Patch",
      },
    }));
    expect(waitingWrite).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    const waitingState = (await stateStore.load(fixture.sessionId))!;
    expect(waitingState).toMatchObject({
      leases: [],
      passiveWriteBlock: {
        leaseId: holder.lease.id,
        sessionId: holderSession.id,
        paths: ["src/holder.ts"],
        requestedPaths: ["src/holder.ts"],
      },
      writeBlockSyncPending: { dirty: false, paths: ["src/holder.ts"] },
    });

    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: "passive-write-turn",
      tool_name: "Bash",
      tool_input: { command: "pnpm run build" },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });

    failPrepare = true;
    const offlineExplicitRetry = await handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: "passive-write-turn",
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Add File: src/holder.ts\n*** End Patch",
      },
    }));
    expect(offlineExplicitRetry).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(JSON.stringify(offlineExplicitRetry)).toContain("尚未确认当前会话等待后的租约状态");
    failPrepare = false;

    waitingState.passiveWriteBlock!.expiresAt = new Date(Date.now() - 1_000).toISOString();
    await stateStore.save(waitingState);
    const expiredFencePathlessWrite = await handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: "passive-write-turn",
      tool_name: "Bash",
      tool_input: { command: "pnpm run build" },
    }));
    expect(expiredFencePathlessWrite).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      passiveWriteBlock: {
        leaseId: holder.lease.id,
        requestedPaths: ["src/holder.ts"],
      },
    });

    fixture.service.releaseLease({
      memberToken: fixture.room.memberToken,
      sessionId: holderSession.id,
      leaseId: holder.lease.id,
      status: "cancelled",
      summary: "Release expired passive wait fixture.",
    });
    failWriteBlockedSync = false;
    const reclaimed = await handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: "passive-write-turn",
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Add File: src/holder.ts\n*** End Patch",
      },
    }));
    expect(reclaimed).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    const reclaimedState = (await stateStore.load(fixture.sessionId))!;
    expect(reclaimedState.passiveWriteBlock).toBeUndefined();
    expect(reclaimedState.leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ paths: ["src/holder.ts"] }),
    ]));
  }, 20_000);

  it("keeps the complete requested fence when only one of multiple waiting paths is reclaimed", async () => {
    const fixture = await createConnectedHookFixture("multi-holder-fence", "multi-holder-fence-session");
    const baseCommit = (await outputGit(fixture.repository, ["rev-parse", "HEAD"])).trim();
    const holderFixtures: Array<{ sessionId: string; leaseId: string; path: string }> = [];
    for (const [index, heldPath] of ["src/holder-a.ts", "src/holder-b.ts"].entries()) {
      const holderSession = fixture.service.openSession({
        memberToken: fixture.room.memberToken,
        codexSessionId: `multi-holder-${index}`,
        branch: "main",
        baseCommit,
      });
      const holder = fixture.service.claimLease({
        memberToken: fixture.room.memberToken,
        sessionId: holderSession.id,
        title: `Multi holder ${index}`,
        branch: "main",
        baseCommit,
        paths: [heldPath],
        mode: "write",
        autoClaim: true,
      });
      expect(holder.acquired).toBe(true);
      if (!holder.acquired) throw new Error("Expected the multi-holder lease to be acquired.");
      holderFixtures.push({ sessionId: holderSession.id, leaseId: holder.lease.id, path: heldPath });
    }

    const options = (eventName: RunCodexHookOptions["eventName"]) => fixture.options(eventName);
    const stateStore = new CodexHookStateStore(fixture.userDataPath);
    const turnId = "multi-holder-fence-turn";
    await handleCodexHook(options("SessionStart"), fixture.input("SessionStart", {
      turn_id: turnId,
      source: "startup",
    }));
    const fullCommand = [
      "*** Begin Patch",
      "*** Add File: src/holder-a.ts",
      "*** Add File: src/holder-b.ts",
      "*** End Patch",
    ].join("\n");
    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: { command: fullCommand },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });

    const firstFence = (await stateStore.load(fixture.sessionId))!.passiveWriteBlock!;
    expect(firstFence.requestedPaths).toEqual(["src/holder-a.ts", "src/holder-b.ts"]);
    const firstHolder = holderFixtures.find((holder) => holder.leaseId === firstFence.leaseId)!;
    const remainingHolder = holderFixtures.find((holder) => holder.leaseId !== firstFence.leaseId)!;
    fixture.service.releaseLease({
      memberToken: fixture.room.memberToken,
      sessionId: firstHolder.sessionId,
      leaseId: firstHolder.leaseId,
      status: "cancelled",
      summary: "Release only the first holder.",
    });

    const partialCommand = `*** Begin Patch\n*** Add File: ${firstHolder.path}\n*** End Patch`;
    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: { command: partialCommand },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      passiveWriteBlock: {
        requestedPaths: ["src/holder-a.ts", "src/holder-b.ts"],
      },
    });
    await handleCodexHook(options("PostToolUse"), fixture.input("PostToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: { command: partialCommand },
    }));

    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "Bash",
      tool_input: { command: "pnpm run build" },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });

    fixture.service.releaseLease({
      memberToken: fixture.room.memberToken,
      sessionId: remainingHolder.sessionId,
      leaseId: remainingHolder.leaseId,
      status: "cancelled",
      summary: "Release the remaining holder before a complete recheck.",
    });
    await expect(handleCodexHook(options("PreToolUse"), fixture.input("PreToolUse", {
      turn_id: turnId,
      tool_name: "apply_patch",
      tool_input: { command: fullCommand },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    expect((await stateStore.load(fixture.sessionId))!.passiveWriteBlock).toBeUndefined();
  }, 30_000);

  it("returns Stop within budget and keeps incomplete local evidence when the session lock is busy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-stop-lock-budget-"));
    temporaryDirectories.push(root);
    const userDataPath = path.join(root, "user-data");
    const stateStore = new CodexHookStateStore(userDataPath);
    await stateStore.save({
      version: 1,
      codexSessionId: "locked-stop-session",
      connectionId: "locked-stop-connection",
      hubSessionId: "locked-stop-hub",
      repositoryPath: root,
      branch: "main",
      baseCommit: "0123456789abcdef",
      initialChangedPaths: [],
      initialChangedFingerprints: {},
      observedChangedPaths: ["src/value.ts"],
      observedChangedFingerprints: { "src/value.ts": "fingerprint" },
      attributedChangedPaths: ["src/value.ts"],
      activityEpoch: 3,
      currentTurnId: "turn-3",
      leases: [],
      openedAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    let signalEntered!: () => void;
    let releaseLock!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const held = stateStore.runExclusive("locked-stop-session", async () => {
      signalEntered();
      await release;
    });
    await entered;
    const startedAt = performance.now();

    await expect(handleCodexHook({
      eventName: "Stop",
      userDataPath,
    }, {
      session_id: "locked-stop-session",
      cwd: root,
      hook_event_name: "Stop",
      turn_id: "turn-3",
    })).resolves.toEqual({ continue: true });
    expect(performance.now() - startedAt).toBeLessThan(2_500);
    releaseLock();
    await held;

    const [job] = await new TurnCompletionQueueStore(userDataPath).listForSession("locked-stop-session");
    expect(job).toMatchObject({
      activityEpoch: 3,
      turnId: "turn-3",
      attributedPaths: ["src/value.ts"],
      attributedPathsTruncated: true,
      attributionComplete: false,
    });
    expect((await stateStore.load("locked-stop-session"))?.pendingCompletion).toBeUndefined();
    await expect(new IntegrationOperationTracker(userDataPath).drain("locked-stop-connection", {
      pollIntervalMs: 5,
      timeoutMs: 200,
    })).resolves.toBeUndefined();
  }, 5_000);

  it("keeps an in-flight hook registered until pause cleanup can choose its cutoff", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-hook-drain-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    const userDataPath = path.join(root, "user-data");
    await createRepository(repository);
    presences.push(await startRuntimePresence(path.join(userDataPath, "runtime-presence.json"), {
      heartbeatIntervalMs: 0,
    }));
    const store = new ConnectionStore(path.join(userDataPath, "connections.json"), protector);
    const connection = await store.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: repository,
    });
    let releaseSession: (() => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/sessions") {
        await new Promise<void>((resolve) => { releaseSession = resolve; });
        return jsonResponse({ session: { id: "late-session" } });
      }
      if (pathname.endsWith("/scan")) return jsonResponse({ scan: { id: "scan-a" } });
      if (pathname === "/api/snapshot") return jsonResponse({});
      if (pathname === "/api/features/query") return jsonResponse({ cards: [] });
      throw new Error(`Unexpected hook request: ${pathname}`);
    });
    const hook = handleCodexHook({
      eventName: "SessionStart",
      userDataPath,
      protector,
      fetchImpl,
    }, {
      session_id: "drained-session",
      cwd: repository,
      hook_event_name: "SessionStart",
    });
    await vi.waitFor(() => expect(releaseSession).toBeTypeOf("function"), { timeout: 10_000 });

    await store.pauseIntegration(connection.id);
    let drained = false;
    const drain = new IntegrationOperationTracker(userDataPath).drain(connection.id, { pollIntervalMs: 5 })
      .then(() => { drained = true; });
    await vi.waitFor(() => expect(drained).toBe(false));
    releaseSession?.();
    await expect(hook).resolves.toBeUndefined();
    await drain;
    expect(drained).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).pathname).toBe("/api/sessions");
  }, 20_000);

  it("does not affect repositories that have not joined a room", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-unconnected-"));
    temporaryDirectories.push(root);
    await expect(handleCodexHook({
      eventName: "PreToolUse",
      userDataPath: path.join(root, "user-data"),
      protector,
    }, {
      session_id: "unconnected-session",
      cwd: root,
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Add File: local.txt\n*** End Patch" },
    })).resolves.toBeUndefined();
  });

  it("is completely silent and makes no room request after a connection is paused", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-paused-hook-"));
    temporaryDirectories.push(root);
    const userDataPath = path.join(root, "user-data");
    const decryptString = vi.fn((value: Buffer) => value.toString("utf8"));
    const pausedProtector: SecretProtector = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, "utf8"),
      decryptString,
    };
    const store = new ConnectionStore(path.join(userDataPath, "connections.json"), pausedProtector);
    const connection = await store.save({
      serverUrl: "http://127.0.0.1:9",
      memberToken: "must-not-be-read",
      repositoryPath: root,
    });
    await store.pauseIntegration(connection.id);
    presences.push(await startRuntimePresence(path.join(userDataPath, "runtime-presence.json"), {
      heartbeatIntervalMs: 0,
    }));
    // A paused connection must not depend on operation-marker storage being
    // writable. A file at this path makes marker creation fail if attempted.
    await writeFile(path.join(userDataPath, "integration-operations"), "unavailable", "utf8");
    const fetchImpl = vi.fn<typeof fetch>();
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });

    await expect(runCodexHook({
      eventName: "PreToolUse",
      userDataPath,
      protector: pausedProtector,
      fetchImpl,
      stdin: Readable.from([JSON.stringify({
        session_id: "paused-session",
        cwd: root,
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: local.txt\n*** End Patch" },
      })]),
      stdout,
    })).resolves.toBe(0);

    expect(output).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(decryptString).not.toHaveBeenCalled();
  });

  it("allows writes with a yellow diagnostic and no room request while exit cleanup is pending", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-pending-hook-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    const userDataPath = path.join(root, "user-data");
    await createRepository(repository);
    presences.push(await startRuntimePresence(path.join(userDataPath, "runtime-presence.json"), {
      heartbeatIntervalMs: 0,
    }));
    const store = new ConnectionStore(path.join(userDataPath, "connections.json"), protector);
    const connection = await store.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: repository,
    });
    await new PausePreparationQueue({
      filePath: path.join(userDataPath, "pause-preparation.json"),
    }).enqueue({
      connectionId: connection.id,
      reason: "app-shutdown",
      requestId: "pending-hook-cleanup",
    });
    await writeFile(path.join(userDataPath, "integration-operations"), "unavailable", "utf8");
    const fetchImpl = vi.fn<typeof fetch>();
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });

    await expect(runCodexHook({
      eventName: "PreToolUse",
      userDataPath,
      protector,
      fetchImpl,
      stdin: Readable.from([JSON.stringify({
        session_id: "pending-cleanup-session",
        cwd: repository,
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: src/pending.ts\n*** End Patch" },
      })]),
      stdout,
    })).resolves.toBe(0);

    expect(JSON.parse(output)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "allow",
        additionalContext: expect.stringContaining("退出清理"),
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows a write with a visible diagnostic when the room network is offline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-offline-hook-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    const userDataPath = path.join(root, "user-data");
    await createRepository(repository);
    presences.push(await startRuntimePresence(path.join(userDataPath, "runtime-presence.json"), {
      heartbeatIntervalMs: 0,
    }));
    const store = new ConnectionStore(path.join(userDataPath, "connections.json"), protector);
    await store.save({
      serverUrl: "http://127.0.0.1:9",
      memberToken: "offline-member",
      repositoryPath: repository,
    });
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });

    await runCodexHook({
      eventName: "PreToolUse",
      userDataPath,
      protector,
      fetchImpl: vi.fn(async () => { throw new TypeError("fetch failed"); }),
      stdin: Readable.from([JSON.stringify({
        session_id: "offline-session",
        cwd: repository,
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: src/offline.ts\n*** End Patch" },
      })]),
      stdout,
    });

    expect(JSON.parse(output)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "allow",
        additionalContext: expect.stringContaining("本次操作不会因网络故障被阻止"),
      },
    });
  }, 10_000);

  it("denies a new write until resume is confirmed and preserves a following Stop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-resume-unconfirmed-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    const userDataPath = path.join(root, "user-data");
    await createRepository(repository);
    presences.push(await startRuntimePresence(path.join(userDataPath, "runtime-presence.json"), {
      heartbeatIntervalMs: 0,
    }));
    const connectionStore = new ConnectionStore(path.join(userDataPath, "connections.json"), protector);
    const connection = await connectionStore.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: repository,
    });
    const baseCommit = (await outputGit(repository, ["rev-parse", "HEAD"])).trim();
    const stateStore = new CodexHookStateStore(userDataPath);
    await stateStore.save({
      version: 1,
      codexSessionId: "resume-unconfirmed-session",
      connectionId: connection.id,
      hubSessionId: "hub-resume-unconfirmed",
      repositoryPath: repository,
      branch: "main",
      baseCommit,
      initialChangedPaths: [],
      initialChangedFingerprints: {},
      observedChangedPaths: [],
      observedChangedFingerprints: {},
      activityEpoch: 0,
      currentTurnId: "turn-old",
      pendingCompletion: {
        operationId: "old-stop-operation",
        turnId: "turn-old",
        activityEpoch: 0,
        phase: "stopped",
        recordedAt: "2026-08-27T00:00:00.000Z",
      },
      leases: [],
      openedAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new TypeError("fetch failed"); });
    const sharedOptions = { userDataPath, protector, fetchImpl };
    const pre = await handleCodexHook({
      ...sharedOptions,
      eventName: "PreToolUse",
    }, {
      session_id: "resume-unconfirmed-session",
      cwd: repository,
      hook_event_name: "PreToolUse",
      turn_id: "turn-new",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: src/value.ts\n*** End Patch" },
    });
    expect(pre).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    const resuming = (await stateStore.load("resume-unconfirmed-session"))!;
    expect(resuming.pendingCompletion).toMatchObject({
      phase: "resuming",
      turnId: "turn-new",
      activityEpoch: 1,
    });
    const resumeOperationId = resuming.pendingCompletion!.operationId;

    await expect(handleCodexHook({
      ...sharedOptions,
      eventName: "Stop",
    }, {
      session_id: "resume-unconfirmed-session",
      cwd: repository,
      hook_event_name: "Stop",
      turn_id: "turn-new",
    })).resolves.toEqual({ continue: true });
    const [job] = await new TurnCompletionQueueStore(userDataPath).listForSession(
      "resume-unconfirmed-session",
    );
    expect(job).toMatchObject({ turnId: "turn-new", activityEpoch: 1 });
    expect(job?.operationId).not.toBe(resumeOperationId);
    await expect(stateStore.load("resume-unconfirmed-session")).resolves.toMatchObject({
      pendingCompletion: {
        phase: "awaiting_commit",
        operationId: job?.operationId,
        activityEpoch: 1,
      },
    });
  }, 10_000);

  it("lets a new PreToolUse epoch supersede an in-flight Stop without stale state overwrite", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-stop-pre-race-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    const userDataPath = path.join(root, "user-data");
    await createRepository(repository);
    presences.push(await startRuntimePresence(path.join(userDataPath, "runtime-presence.json"), {
      heartbeatIntervalMs: 0,
    }));
    const connectionStore = new ConnectionStore(path.join(userDataPath, "connections.json"), protector);
    const connection = await connectionStore.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: repository,
    });
    const baseCommit = (await outputGit(repository, ["rev-parse", "HEAD"])).trim();
    const stateStore = new CodexHookStateStore(userDataPath);
    await stateStore.save({
      version: 1,
      codexSessionId: "stop-pre-race-session",
      connectionId: connection.id,
      hubSessionId: "hub-stop-pre-race",
      repositoryPath: repository,
      branch: "main",
      baseCommit,
      initialChangedPaths: [],
      initialChangedFingerprints: {},
      observedChangedPaths: [],
      observedChangedFingerprints: {},
      activityEpoch: 0,
      currentTurnId: "turn-old",
      leases: [],
      openedAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    let signalStopEntered!: () => void;
    let releaseStop!: () => void;
    const stopEntered = new Promise<void>((resolve) => { signalStopEntered = resolve; });
    const stopRelease = new Promise<void>((resolve) => { releaseStop = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (request) => {
      const pathname = new URL(String(request)).pathname;
      if (pathname.endsWith("/stop")) {
        signalStopEntered();
        await stopRelease;
        return jsonResponse({ result: "awaiting_commit" });
      }
      if (pathname.endsWith("/resume")) {
        releaseStop();
        return jsonResponse({ result: "resumed" });
      }
      if (pathname === "/api/edits/prepare") {
        return jsonResponse({
          check: {
            allowed: true,
            blockers: [],
            warnings: [],
            coveredPaths: ["src/value.ts"],
            uncoveredPaths: [],
          },
        });
      }
      if (pathname.endsWith("/completion/check")) return jsonResponse({ result: "superseded" });
      throw new Error(`Unexpected concurrent Hook request: ${pathname}`);
    });
    const sharedOptions = { userDataPath, protector, fetchImpl };
    const stop = handleCodexHook({ ...sharedOptions, eventName: "Stop" }, {
      session_id: "stop-pre-race-session",
      cwd: repository,
      hook_event_name: "Stop",
      turn_id: "turn-old",
    });
    await stopEntered;

    const pre = await handleCodexHook({ ...sharedOptions, eventName: "PreToolUse" }, {
      session_id: "stop-pre-race-session",
      cwd: repository,
      hook_event_name: "PreToolUse",
      turn_id: "turn-new",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: src/value.ts\n*** End Patch" },
    });
    await expect(stop).resolves.toEqual({ continue: true });
    expect(pre).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
    await expect(stateStore.load("stop-pre-race-session")).resolves.toMatchObject({
      activityEpoch: 1,
      currentTurnId: "turn-new",
      pendingWrite: { toolName: "apply_patch" },
    });
    expect((await stateStore.load("stop-pre-race-session"))?.pendingCompletion).toBeUndefined();
    await expect(new TurnCompletionQueueStore(userDataPath).listForSession(
      "stop-pre-race-session",
    )).resolves.toEqual([]);
  }, 10_000);

  it("keeps an in-flight Stop job when SessionStart replaces its Hub generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-stop-generation-race-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    const userDataPath = path.join(root, "user-data");
    await createRepository(repository);
    presences.push(await startRuntimePresence(path.join(userDataPath, "runtime-presence.json"), {
      heartbeatIntervalMs: 0,
    }));
    const connectionStore = new ConnectionStore(path.join(userDataPath, "connections.json"), protector);
    const connection = await connectionStore.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: repository,
    });
    const baseCommit = (await outputGit(repository, ["rev-parse", "HEAD"])).trim();
    const stateStore = new CodexHookStateStore(userDataPath);
    await stateStore.save({
      version: 1,
      codexSessionId: "stop-generation-race-session",
      connectionId: connection.id,
      hubSessionId: "hub-stop-generation-old",
      finalizationId: "finalization-stop-generation-old",
      repositoryPath: repository,
      branch: "main",
      baseCommit,
      initialChangedPaths: [],
      initialChangedFingerprints: {},
      observedChangedPaths: [],
      observedChangedFingerprints: {},
      activityEpoch: 0,
      currentTurnId: "turn-old",
      leases: [],
      openedAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    let signalStopEntered!: () => void;
    let releaseStop!: () => void;
    const stopEntered = new Promise<void>((resolve) => { signalStopEntered = resolve; });
    const stopRelease = new Promise<void>((resolve) => { releaseStop = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (request) => {
      const pathname = new URL(String(request)).pathname;
      if (!pathname.endsWith("/stop")) throw new Error(`Unexpected Stop generation request: ${pathname}`);
      signalStopEntered();
      await stopRelease;
      // 缺少权威租约清单会让旧 job 保持 pending，供后台在原 Hub generation 上继续检查。
      return jsonResponse({ result: "awaiting_commit" });
    });
    const stop = handleCodexHook({ userDataPath, protector, fetchImpl, eventName: "Stop" }, {
      session_id: "stop-generation-race-session",
      cwd: repository,
      hook_event_name: "Stop",
      turn_id: "turn-old",
    });
    await stopEntered;

    const queuedBeforeReopen = (await new TurnCompletionQueueStore(userDataPath).list())[0]!;
    const oldPendingState = (await stateStore.load("stop-generation-race-session"))!;
    await stateStore.runExclusive("stop-generation-race-session", async () => {
      await stateStore.save({
        ...oldPendingState,
        hubSessionId: "hub-stop-generation-reopened",
        finalizationId: "finalization-stop-generation-reopened",
        currentTurnId: "turn-reopened",
        pendingCompletion: undefined,
        leases: [],
        openedAt: "2026-08-27T00:00:01.000Z",
      });
    });
    releaseStop();

    await expect(stop).resolves.toEqual({ continue: true });
    await expect(stateStore.load("stop-generation-race-session")).resolves.toMatchObject({
      hubSessionId: "hub-stop-generation-reopened",
      finalizationId: "finalization-stop-generation-reopened",
      pendingCompletion: undefined,
    });
    await expect(new TurnCompletionQueueStore(userDataPath).list()).resolves.toEqual([
      expect.objectContaining({
        operationId: queuedBeforeReopen.operationId,
        hubSessionId: "hub-stop-generation-old",
        attempts: 1,
      }),
    ]);
  }, 10_000);

  it("makes an in-flight PreToolUse adopt a later Stop fence before allowing the write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-pre-stop-race-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    const userDataPath = path.join(root, "user-data");
    await createRepository(repository);
    presences.push(await startRuntimePresence(path.join(userDataPath, "runtime-presence.json"), {
      heartbeatIntervalMs: 0,
    }));
    const connectionStore = new ConnectionStore(path.join(userDataPath, "connections.json"), protector);
    const connection = await connectionStore.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: repository,
    });
    const baseCommit = (await outputGit(repository, ["rev-parse", "HEAD"])).trim();
    const stateStore = new CodexHookStateStore(userDataPath);
    await stateStore.save({
      version: 1,
      codexSessionId: "pre-stop-race-session",
      connectionId: connection.id,
      hubSessionId: "hub-pre-stop-race",
      repositoryPath: repository,
      branch: "main",
      baseCommit,
      initialChangedPaths: [],
      initialChangedFingerprints: {},
      observedChangedPaths: [],
      observedChangedFingerprints: {},
      activityEpoch: 0,
      currentTurnId: "turn-old",
      leases: [],
      openedAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    let signalPrepareEntered!: () => void;
    let releasePrepare!: () => void;
    const prepareEntered = new Promise<void>((resolve) => { signalPrepareEntered = resolve; });
    const prepareRelease = new Promise<void>((resolve) => { releasePrepare = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (request) => {
      const pathname = new URL(String(request)).pathname;
      if (pathname === "/api/edits/prepare") {
        signalPrepareEntered();
        await prepareRelease;
        return jsonResponse({
          check: {
            allowed: true,
            blockers: [],
            warnings: [],
            coveredPaths: ["src/value.ts"],
            uncoveredPaths: [],
          },
        });
      }
      if (pathname.endsWith("/stop")) throw new TypeError("network offline");
      throw new Error(`Unexpected reverse-race Hook request: ${pathname}`);
    });
    const sharedOptions = { userDataPath, protector, fetchImpl };
    const pre = handleCodexHook({ ...sharedOptions, eventName: "PreToolUse" }, {
      session_id: "pre-stop-race-session",
      cwd: repository,
      hook_event_name: "PreToolUse",
      turn_id: "turn-new",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: src/value.ts\n*** End Patch" },
    });
    await prepareEntered;

    const stop = handleCodexHook({ ...sharedOptions, eventName: "Stop" }, {
      session_id: "pre-stop-race-session",
      cwd: repository,
      hook_event_name: "Stop",
      turn_id: "turn-new",
    });
    await vi.waitFor(async () => {
      await expect(new TurnCompletionQueueStore(userDataPath).listForSession(
        "pre-stop-race-session",
      )).resolves.toHaveLength(1);
    });
    releasePrepare();

    await expect(pre).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await expect(stop).resolves.toEqual({ continue: true });
    const [job] = await new TurnCompletionQueueStore(userDataPath).listForSession(
      "pre-stop-race-session",
    );
    expect(job).toMatchObject({ turnId: "turn-new", activityEpoch: 0 });
    await expect(stateStore.load("pre-stop-race-session")).resolves.toMatchObject({
      currentTurnId: "turn-new",
      pendingCompletion: {
        operationId: job?.operationId,
        phase: "awaiting_commit",
      },
    });
    expect((await stateStore.load("pre-stop-race-session"))?.pendingWrite).toBeUndefined();
  }, 10_000);

  it("silently removes inactive SessionEnd state and remains idempotent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-inactive-end-"));
    temporaryDirectories.push(root);
    const userDataPath = path.join(root, "user-data");
    const stateStore = new CodexHookStateStore(userDataPath);
    await stateStore.save({
      version: 1,
      codexSessionId: "inactive-session",
      connectionId: "connection-a",
      hubSessionId: "hub-session-a",
      repositoryPath: root,
      branch: "main",
      baseCommit: "0123456789abcdef",
      initialChangedPaths: [],
      initialChangedFingerprints: {},
      observedChangedPaths: [],
      observedChangedFingerprints: {},
      leases: [],
      openedAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    const completionQueue = new TurnCompletionQueueStore(userDataPath);
    await completionQueue.enqueue({
      operationId: "completion-before-session-end",
      turnId: "turn-before-end",
      activityEpoch: 0,
      state: (await stateStore.load("inactive-session"))!,
    });
    const options: RunCodexHookOptions = {
      eventName: "SessionEnd",
      userDataPath,
      protector,
      fetchImpl: vi.fn(),
    };
    const input: CodexHookInput = {
      session_id: "inactive-session",
      cwd: root,
      hook_event_name: "SessionEnd",
    };

    await expect(handleCodexHook(options, input)).resolves.toBeUndefined();
    await expect(handleCodexHook(options, input)).resolves.toBeUndefined();
    await expect(stateStore.load(input.session_id)).resolves.toBeUndefined();
    await expect(new SessionEndQueueStore(userDataPath).list()).resolves.toHaveLength(1);
    await expect(completionQueue.list()).resolves.toHaveLength(1);
    expect(options.fetchImpl).not.toHaveBeenCalled();
  });

  it("does not resurrect SessionEnd state when an in-flight heartbeat returns afterward", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-session-end-heartbeat-"));
    temporaryDirectories.push(root);
    const userDataPath = path.join(root, "user-data");
    const stateStore = new CodexHookStateStore(userDataPath);
    const now = new Date().toISOString();
    await stateStore.save({
      version: 1,
      codexSessionId: "session-end-heartbeat-session",
      connectionId: "session-end-heartbeat-connection",
      hubSessionId: "session-end-heartbeat-hub",
      repositoryPath: root,
      branch: "main",
      baseCommit: "0123456789abcdef",
      initialChangedPaths: [],
      initialChangedFingerprints: {},
      observedChangedPaths: [],
      observedChangedFingerprints: {},
      leases: [{
        id: "session-end-heartbeat-lease",
        paths: ["src/value.ts"],
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        coordinationState: "working",
      }],
      openedAt: now,
      updatedAt: now,
    });
    let markHeartbeatResponded!: () => void;
    const heartbeatResponded = new Promise<void>((resolve) => { markHeartbeatResponded = resolve; });
    let releaseHeartbeat!: () => void;
    const heartbeatReleased = new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      markHeartbeatResponded();
      await heartbeatReleased;
      return jsonResponse({
        session: { id: "session-end-heartbeat-hub" },
        renewedLeases: [{
          id: "session-end-heartbeat-lease",
          expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
        }],
      });
    });
    const heartbeatStore = {
      get: vi.fn(async () => ({
        id: "session-end-heartbeat-connection",
        serverUrl: "http://127.0.0.1:4173",
        repositoryPath: root,
        createdAt: now,
        updatedAt: now,
      })),
      readMemberToken: vi.fn(async () => "member-token"),
    };
    const scheduler = startCodexSessionHeartbeatScheduler({
      userDataPath,
      store: heartbeatStore,
      fetchImpl,
      intervalMs: 60_000,
    });
    const scan = scheduler.scanNow();
    await heartbeatResponded;

    const startedAt = performance.now();
    await handleCodexHook({
      eventName: "SessionEnd",
      userDataPath,
      protector,
      fetchImpl,
    }, {
      session_id: "session-end-heartbeat-session",
      cwd: root,
      hook_event_name: "SessionEnd",
      reason: "other",
    });
    expect(performance.now() - startedAt).toBeLessThan(2_500);
    await expect(new SessionEndQueueStore(userDataPath).list()).resolves.toHaveLength(1);

    releaseHeartbeat();
    await scan;
    await scheduler.stop();

    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(stateStore.load("session-end-heartbeat-session")).resolves.toBeUndefined();
    await expect(new SessionEndQueueStore(userDataPath).list()).resolves.toHaveLength(1);
  }, 10_000);

  it("persists SessionEnd before returning within the three-second host budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-fast-session-end-"));
    temporaryDirectories.push(root);
    const userDataPath = path.join(root, "user-data");
    presences.push(await startRuntimePresence(path.join(userDataPath, "runtime-presence.json"), {
      heartbeatIntervalMs: 0,
    }));
    const store = new ConnectionStore(path.join(userDataPath, "connections.json"), protector);
    const connection = await store.save({
      serverUrl: "http://127.0.0.1:4317",
      memberToken: "member-token",
      repositoryPath: root,
    });
    const stateStore = new CodexHookStateStore(userDataPath);
    await stateStore.save({
      version: 1,
      codexSessionId: "fast-end-session",
      connectionId: connection.id,
      hubSessionId: "hub-fast-end",
      repositoryPath: root,
      branch: "main",
      baseCommit: "0123456789abcdef",
      initialChangedPaths: [],
      initialChangedFingerprints: {},
      observedChangedPaths: [],
      observedChangedFingerprints: {},
      attributedChangedPaths: ["src/value.ts"],
      leases: [],
      openedAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const decryptString = vi.fn(() => {
      throw new Error("SessionEnd must not decrypt the room token on the host lifecycle path.");
    });
    const startedAt = performance.now();

    await handleCodexHook({
      eventName: "SessionEnd",
      userDataPath,
      protector: { ...protector, decryptString },
      fetchImpl,
    }, {
      session_id: "fast-end-session",
      cwd: root,
      hook_event_name: "SessionEnd",
    });

    expect(performance.now() - startedAt).toBeLessThan(2_500);
    await expect(new SessionEndQueueStore(userDataPath).list()).resolves.toHaveLength(1);
    await expect(stateStore.load("fast-end-session")).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(decryptString).not.toHaveBeenCalled();
  }, 5_000);

  it("keeps a durable SessionEnd tombstone within budget when the queue merge lock is busy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-contended-session-end-"));
    temporaryDirectories.push(root);
    const userDataPath = path.join(root, "user-data");
    const stateStore = new CodexHookStateStore(userDataPath);
    const finalizationId = "contended-finalization";
    await stateStore.save({
      version: 1,
      codexSessionId: "contended-end-session",
      connectionId: "contended-connection",
      hubSessionId: "contended-hub-session",
      finalizationId,
      repositoryPath: root,
      branch: "main",
      baseCommit: "0123456789abcdef",
      initialChangedPaths: [],
      initialChangedFingerprints: {},
      observedChangedPaths: [],
      observedChangedFingerprints: {},
      attributedChangedPaths: ["src/value.ts"],
      leases: [],
      openedAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    const queue = new SessionEndQueueStore(userDataPath);
    await mkdir(queue.directory, { recursive: true });
    await writeFile(path.join(queue.directory, `${finalizationId}.lock`), `${JSON.stringify({
      version: 1,
      pid: process.pid,
      token: "held-by-live-hook-test",
      startedAt: new Date().toISOString(),
    })}\n`, "utf8");
    const startedAt = performance.now();

    await expect(runCodexHook({
      eventName: "SessionEnd",
      userDataPath,
      protector,
      stdin: Readable.from([JSON.stringify({
        session_id: "contended-end-session",
        cwd: root,
        hook_event_name: "SessionEnd",
        reason: "other",
      })]),
      stdout: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    })).resolves.toBe(0);

    expect(performance.now() - startedAt).toBeLessThan(2_500);
    await expect(queue.load(finalizationId)).resolves.toMatchObject({
      finalizationId,
      codexSessionId: "contended-end-session",
      attributedPaths: ["src/value.ts"],
    });
    // merge 未获锁时保留原 state，后台 worker 解锁后仍能单调合并最终证据。
    await expect(stateStore.load("contended-end-session")).resolves.toBeDefined();
  }, 5_000);

  it("merges state completed after the SessionEnd lock budget before finalization", async () => {
    const fixture = await createConnectedHookFixture("late-session-end-evidence", "late-end-session");
    const stateStore = new CodexHookStateStore(fixture.userDataPath);
    const queue = new SessionEndQueueStore(fixture.userDataPath);
    await handleCodexHook(
      fixture.options("SessionStart"),
      fixture.input("SessionStart", { source: "startup" }),
    );
    const initial = (await stateStore.load(fixture.sessionId))!;
    initial.attributedChangedPaths = ["src/value.ts"];
    await stateStore.save(initial);

    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => { markLocked = resolve; });
    let releaseLock!: () => void;
    const lockReleased = new Promise<void>((resolve) => { releaseLock = resolve; });
    const held = stateStore.runExclusive(fixture.sessionId, async () => {
      const current = (await stateStore.load(fixture.sessionId))!;
      markLocked();
      await lockReleased;
      const claimed = fixture.service.claimLease({
        memberToken: fixture.room.memberToken,
        sessionId: current.hubSessionId,
        title: "Late SessionEnd evidence",
        paths: ["src/late.ts"],
        kind: "automatic",
      });
      if (!claimed.acquired) throw new Error("Expected the late evidence lease to be acquired.");
      current.attributedChangedPaths = ["src/value.ts", "src/late.ts"];
      current.leases = [{
        id: claimed.lease.id,
        paths: claimed.lease.paths.map((leasePath) => leasePath.path),
        expiresAt: claimed.lease.expiresAt,
        coordinationState: "working",
      }];
      await stateStore.save(current);
    });
    await locked;

    const startedAt = performance.now();
    await handleCodexHook(
      fixture.options("SessionEnd"),
      fixture.input("SessionEnd", { reason: "other" }),
    );
    expect(performance.now() - startedAt).toBeLessThan(2_500);
    expect((await queue.list())[0]?.attributedPaths).toEqual(["src/value.ts"]);

    releaseLock();
    await held;
    let markRemoteStarted!: () => void;
    const remoteStarted = new Promise<void>((resolve) => { markRemoteStarted = resolve; });
    let releaseRemote!: () => void;
    const remoteReleased = new Promise<void>((resolve) => { releaseRemote = resolve; });
    let blockedFirstStart = false;
    const fetchImpl = vi.fn<typeof fetch>(async (request, init) => {
      const pathname = new URL(request instanceof Request ? request.url : String(request)).pathname;
      if (!blockedFirstStart && pathname.endsWith("/finalize/start")) {
        blockedFirstStart = true;
        markRemoteStarted();
        await remoteReleased;
      }
      return fetch(request, init);
    });
    const store = new ConnectionStore(
      path.join(fixture.userDataPath, "connections.json"),
      protector,
    );
    const finalizer = startSessionEndFinalizationWorker({
      userDataPath: fixture.userDataPath,
      store,
      fetchImpl,
      intervalMs: 60_000,
    });
    const scan = finalizer.scanNow();
    await remoteStarted;

    await expect(queue.list()).resolves.toEqual([
      expect.objectContaining({
        attributedPaths: ["src/value.ts", "src/late.ts"],
        leases: [expect.objectContaining({ paths: ["src/late.ts"] })],
      }),
    ]);
    await expect(stateStore.load(fixture.sessionId)).resolves.toBeUndefined();

    releaseRemote();
    await scan;
    await finalizer.stop();
    await expect(queue.list()).resolves.toEqual([]);
  }, 20_000);

  it("reopens one Codex task as a new Hub generation without old jobs blocking it", async () => {
    const fixture = await createConnectedHookFixture("reopen-generation", "reopen-generation-session");
    const stateStore = new CodexHookStateStore(fixture.userDataPath);
    const completionQueue = new TurnCompletionQueueStore(fixture.userDataPath);
    const sessionEndQueue = new SessionEndQueueStore(fixture.userDataPath);
    await handleCodexHook(
      fixture.options("SessionStart"),
      fixture.input("SessionStart", { source: "startup", turn_id: "turn-old" }),
    );
    const oldState = (await stateStore.load(fixture.sessionId))!;
    await completionQueue.enqueue({
      operationId: "old-generation-completion",
      turnId: "turn-old",
      activityEpoch: oldState.activityEpoch ?? 0,
      state: oldState,
    });

    await handleCodexHook(
      fixture.options("SessionEnd"),
      fixture.input("SessionEnd", { reason: "other" }),
    );
    await expect(stateStore.load(fixture.sessionId)).resolves.toBeUndefined();
    await expect(sessionEndQueue.list()).resolves.toHaveLength(1);

    await handleCodexHook(
      fixture.options("SessionStart"),
      fixture.input("SessionStart", { source: "resume", turn_id: "turn-new" }),
    );
    const reopened = (await stateStore.load(fixture.sessionId))!;
    expect(reopened.hubSessionId).not.toBe(oldState.hubSessionId);
    expect(reopened.finalizationId).not.toBe(oldState.finalizationId);
    expect(fixture.service.listRoomSessions(fixture.room.memberToken).sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: oldState.hubSessionId, status: "finalizing" }),
        expect.objectContaining({ id: reopened.hubSessionId, status: "active" }),
      ]),
    );

    const store = new ConnectionStore(
      path.join(fixture.userDataPath, "connections.json"),
      protector,
    );
    const heartbeatFetch = vi.fn<typeof fetch>((request, init) => fetch(request, init));
    const scheduler = startCodexSessionHeartbeatScheduler({
      userDataPath: fixture.userDataPath,
      store,
      fetchImpl: heartbeatFetch,
      intervalMs: 60_000,
    });
    await scheduler.scanNow();
    await scheduler.stop();
    expect(heartbeatFetch.mock.calls.some(([request]) =>
      new URL(request instanceof Request ? request.url : String(request)).pathname
        === `/api/sessions/${reopened.hubSessionId}/heartbeat`)).toBe(true);

    await expect(handleCodexHook(
      fixture.options("PreToolUse"),
      fixture.input("PreToolUse", {
        turn_id: "turn-new",
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: src/reopened.ts\n*** End Patch" },
      }),
    )).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });

    const finalizer = startSessionEndFinalizationWorker({
      userDataPath: fixture.userDataPath,
      store,
      intervalMs: 60_000,
    });
    await finalizer.scanNow();
    await finalizer.stop();
    await expect(stateStore.load(fixture.sessionId)).resolves.toMatchObject({
      hubSessionId: reopened.hubSessionId,
      finalizationId: reopened.finalizationId,
    });
    await expect(sessionEndQueue.list()).resolves.toEqual([]);
    await expect(completionQueue.list()).resolves.toEqual([
      expect.objectContaining({
        operationId: "old-generation-completion",
        hubSessionId: oldState.hubSessionId,
      }),
    ]);
  }, 30_000);

  it("does not treat an unrelated finalize endpoint 404 as a completed old generation", async () => {
    const fixture = await createConnectedHookFixture("reopen-finalize-404", "reopen-finalize-404-session");
    const stateStore = new CodexHookStateStore(fixture.userDataPath);
    const sessionEndQueue = new SessionEndQueueStore(fixture.userDataPath);
    await handleCodexHook(
      fixture.options("SessionStart"),
      fixture.input("SessionStart", { source: "startup", turn_id: "turn-old" }),
    );
    const oldState = (await stateStore.load(fixture.sessionId))!;
    await handleCodexHook(
      fixture.options("SessionEnd"),
      fixture.input("SessionEnd", { reason: "other" }),
    );

    const fetchImpl = vi.fn<typeof fetch>((request, init) => {
      const pathname = new URL(request instanceof Request ? request.url : String(request)).pathname;
      if (pathname === `/api/sessions/${oldState.hubSessionId}/finalize/start`) {
        return Promise.resolve(new Response(JSON.stringify({
          error: "not_found",
          message: "Endpoint not found.",
        }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }));
      }
      return fetch(request, init);
    });
    await expect(handleCodexHook(
      fixture.options("SessionStart", fetchImpl),
      fixture.input("SessionStart", { source: "resume", turn_id: "turn-new" }),
    )).rejects.toMatchObject({ status: 404, code: "not_found" });

    await expect(stateStore.load(fixture.sessionId)).resolves.toBeUndefined();
    await expect(sessionEndQueue.list()).resolves.toHaveLength(1);
    expect(fixture.service.listRoomSessions(fixture.room.memberToken).sessions).toEqual([
      expect.objectContaining({ id: oldState.hubSessionId, status: "active" }),
    ]);
  }, 20_000);

  it("keeps initial dirty paths attributed but marks their completion evidence incomplete", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-hook-initial-dirty-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    const userDataPath = path.join(root, "user-data");
    await createRepository(repository);
    await writeFile(path.join(repository, "src", "value.ts"), "export const value = 10;\n", "utf8");
    await writeFile(path.join(repository, "src", "preexisting.ts"), "export const temp = true;\n", "utf8");
    presences.push(await startRuntimePresence(path.join(userDataPath, "runtime-presence.json"), {
      heartbeatIntervalMs: 0,
    }));

    const database = new AgentHubDatabase({ path: path.join(root, "agent-hub.sqlite") });
    databases.push(database);
    const service = new AgentHubService(database);
    const room = service.createRoom({
      name: "Initial dirty room",
      projectName: "Initial dirty project",
      repository: "https://example.test/team/initial-dirty.git",
      defaultBranch: "main",
      hostName: "Alice",
      hostAgent: "Codex",
    });
    const server = createAgentHubApp({ database, service }).listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const connectionStore = new ConnectionStore(path.join(userDataPath, "connections.json"), protector);
    await connectionStore.save({
      serverUrl: `http://127.0.0.1:${port}`,
      memberToken: room.memberToken,
      repositoryPath: repository,
    });
    const sessionId = "initial-dirty-session";
    const hookInput = (
      eventName: CodexHookInput["hook_event_name"],
      extra: Partial<CodexHookInput> = {},
    ): CodexHookInput => ({
      session_id: sessionId,
      cwd: repository,
      hook_event_name: eventName,
      turn_id: "initial-dirty-turn",
      ...extra,
    });
    const hookOptions = (eventName: RunCodexHookOptions["eventName"]): RunCodexHookOptions => ({
      eventName,
      userDataPath,
      protector,
    });
    const command = [
      "*** Begin Patch",
      "*** Update File: src/value.ts",
      "*** Delete File: src/preexisting.ts",
      "*** End Patch",
    ].join("\n");

    await handleCodexHook(hookOptions("SessionStart"), hookInput("SessionStart"));
    await expect(handleCodexHook(hookOptions("PreToolUse"), hookInput("PreToolUse", {
      tool_name: "apply_patch",
      tool_input: { command },
    }))).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    await runGit(repository, ["restore", "--", "src/value.ts"]);
    await rm(path.join(repository, "src", "preexisting.ts"));
    await handleCodexHook(hookOptions("PostToolUse"), hookInput("PostToolUse", {
      tool_name: "apply_patch",
      tool_input: { command },
    }));

    const stateStore = new CodexHookStateStore(userDataPath);
    const state = (await stateStore.load(sessionId))!;
    expect(state.attributedChangedPaths).toEqual(expect.arrayContaining([
      "src/value.ts",
      "src/preexisting.ts",
    ]));
    expect(state.attributedPathEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/value.ts", baseEntry: null }),
      expect.objectContaining({ path: "src/preexisting.ts", baseEntry: null, attributedEntry: "missing" }),
    ]));

    await handleCodexHook(hookOptions("Stop"), hookInput("Stop"));
    const jobs = await new TurnCompletionQueueStore(userDataPath).listForSession(sessionId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      attributionComplete: false,
      baselineEvidence: expect.arrayContaining([
        expect.objectContaining({ path: "src/value.ts", baseEntry: null }),
        expect.objectContaining({ path: "src/preexisting.ts", baseEntry: null }),
      ]),
    });
  }, 20_000);

  it("opens shared context, attributes Agent writes, ignores external changes, and blocks another member's Unity scope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-hook-flow-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    const userDataPath = path.join(root, "user-data");
    await createRepository(repository);
    presences.push(await startRuntimePresence(path.join(userDataPath, "runtime-presence.json"), {
      heartbeatIntervalMs: 0,
    }));

    const database = new AgentHubDatabase({ path: path.join(root, "agent-hub.sqlite") });
    databases.push(database);
    const service = new AgentHubService(database);
    const room = service.createRoom({
      name: "Hook integration room",
      projectName: "Hook project",
      repository: "https://example.test/team/project.git",
      defaultBranch: "main",
      hostName: "Alice",
      hostAgent: "Codex",
    });
    const app = createAgentHubApp({ database, service });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const store = new ConnectionStore(path.join(userDataPath, "connections.json"), protector);
    await store.save({
      serverUrl: `http://127.0.0.1:${port}`,
      memberToken: room.memberToken,
      repositoryPath: repository,
      roomId: room.room.id,
      roomName: room.room.name,
      memberName: room.member.displayName,
    });

    const options = (eventName: RunCodexHookOptions["eventName"]): RunCodexHookOptions => ({
      eventName,
      userDataPath,
      protector,
    });
    const input = (
      eventName: CodexHookInput["hook_event_name"],
      extra: Partial<CodexHookInput> = {},
    ): CodexHookInput => ({
      session_id: "codex-session-a",
      cwd: repository,
      hook_event_name: eventName,
      ...extra,
    });

    await writeFile(path.join(repository, "src", "value.ts"), "export const value = 10;\n", "utf8");
    const sessionStart = await handleCodexHook(
      options("SessionStart"),
      input("SessionStart", { source: "startup" }),
    );
    expect(sessionStart).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
      },
    });
    expect(JSON.stringify(sessionStart)).toContain("Hook integration room");
    const hookSession = service.getDashboard(room.memberToken).sessions.find(
      (session) => session.agentName === "Codex" && session.status === "active",
    );
    expect(hookSession).toBeDefined();
    expect(JSON.stringify(sessionStart)).toContain(`sessionId=${hookSession?.id}`);

    const oversizedPatch = [
      "*** Begin Patch",
      ...Array.from({ length: 101 }, (_, index) => `*** Add File: src/bulk-${index}.ts`),
      "*** End Patch",
    ].join("\n");
    const oversizedWrite = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: oversizedPatch },
      }),
    );
    expect(oversizedWrite).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(JSON.stringify(oversizedWrite)).toContain("单次最多协调 100 个明确写入路径");

    const baselineCommit = (await outputGit(repository, ["rev-parse", "HEAD"])).trim();
    const memorySession = service.openSession({
      memberToken: room.memberToken,
      agentName: "Codex memory fixture",
      repository: room.room.repository,
      branch: "main",
      baseCommit: baselineCommit,
      task: "Record pre-existing protected behavior",
    });
    const featureStore = new FeatureMemoryStore(database);
    const featureActor = {
      roomId: room.room.id,
      memberId: room.member.id,
      memberName: room.member.displayName,
      defaultBranch: room.room.defaultBranch,
    };
    const protectedRevision = featureStore.submitRevision(featureActor, {
      ...memorySession,
      promotionEvidenceVerified: true,
    }, {
      memberToken: room.memberToken,
      sessionId: memorySession.id,
      featureKey: "protected-behavior",
      name: "Protected behavior",
      systemId: "protected",
      relation: "add",
      objective: "Keep the established protected behavior.",
      changeSummary: "Initial verified behavior.",
      contractChanges: [{
        operation: "add",
        key: "protected.behavior",
        behavior: "The protected behavior remains compatible.",
      }],
      targets: [{ kind: "path", path: "src/protected.ts", role: "implementation" }],
      finalCommit: baselineCommit,
      completed: true,
      verifications: [{
        testKey: "protected-regression",
        result: "passed",
        summary: "Protected behavior regression passed.",
      }],
    });
    expect(protectedRevision.status).toBe("current");
    const symbolRevision = featureStore.submitRevision(featureActor, {
      ...memorySession,
      promotionEvidenceVerified: true,
    }, {
      memberToken: room.memberToken,
      sessionId: memorySession.id,
      featureKey: "foo-bar-behavior",
      name: "Foo bar behavior",
      systemId: "foo",
      relation: "add",
      objective: "Keep Foo.bar compatible while allowing unrelated Foo members.",
      changeSummary: "Recorded the verified Foo.bar behavior.",
      contractChanges: [{
        operation: "add",
        key: "foo.bar.behavior",
        behavior: "Foo.bar returns its established value.",
      }],
      targets: [{ kind: "symbol", path: "src/foo.ts", symbol: "Foo.bar", role: "contract" }],
      finalCommit: baselineCommit,
      completed: true,
      verifications: [{
        testKey: "foo-bar-regression",
        result: "passed",
        summary: "Foo.bar regression passed.",
      }],
    });
    expect(symbolRevision.status).toBe("current");

    const addBazCommand = [
      "*** Begin Patch",
      "*** Update File: src/foo.ts",
      "@@",
      " export class Foo {",
      "+  baz() { return 2; }",
      " }",
      "*** End Patch",
    ].join("\n");
    const addBaz = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: addBazCommand },
      }),
    );
    expect(addBaz).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });

    const updateBarCommand = [
      "*** Begin Patch",
      "*** Update File: src/foo.ts",
      "@@",
      " export class Foo {",
      "-  bar() { return 1; }",
      "+  bar() { return 2; }",
      " }",
      "*** End Patch",
    ].join("\n");
    const updateBar = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: updateBarCommand },
      }),
    );
    expect(updateBar).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(JSON.stringify(updateBar)).toContain("Foo.bar");

    const resumedSession = await handleCodexHook(
      options("SessionStart"),
      input("SessionStart", { source: "resume" }),
    );
    expect(JSON.stringify(resumedSession)).toContain("长期功能记忆：Protected behavior [protected]");
    expect(JSON.stringify(resumedSession)).toContain("The protected behavior remains compatible.");
    const protectedCommand = [
      "*** Begin Patch",
      "*** Update File: src/protected.ts",
      "@@",
      "-export function protectedBehavior() { return 1; }",
      "+export function protectedBehavior() { return 2; }",
      "*** End Patch",
    ].join("\n");
    const protectedBlock = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: protectedCommand },
      }),
    );
    expect(protectedBlock).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    const confirmationId = JSON.stringify(protectedBlock).match(/confirmationId=([0-9a-f-]{36})/i)?.[1];
    expect(confirmationId).toBeTruthy();
    expect(JSON.stringify(protectedBlock)).toContain(`sessionId=${hookSession?.id}`);

    service.resolveFeatureConfirmation({
      memberToken: room.memberToken,
      sessionId: hookSession!.id,
      confirmationId: confirmationId!,
      decision: "approved",
      reason: "The current member explicitly approved this scoped change.",
    });
    const protectedRetry = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: protectedCommand },
      }),
    );
    expect(protectedRetry).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });

    const preEdit = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Update File: src/value.ts\n*** End Patch" },
      }),
    );
    expect(
      (preEdit?.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision,
      JSON.stringify(preEdit),
    ).toBe("allow");
    expect(preEdit).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
    expect(service.getDashboard(room.memberToken).leases).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "active" })]),
    );

    await writeFile(path.join(repository, "src", "value.ts"), "export const value = 2;\n", "utf8");
    const postEdit = await handleCodexHook(
      options("PostToolUse"),
      input("PostToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Update File: src/value.ts\n*** End Patch" },
      }),
    );
    expect(postEdit).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
      },
    });
    expect(JSON.stringify(postEdit)).toContain("src/value.ts");

    const bob = service.joinRoom({
      roomToken: room.roomToken,
      displayName: "Bob",
      agent: "Codex",
    });
    const bobLease = service.claimLease({
      memberToken: bob.memberToken,
      title: "Edit the main scene",
      paths: ["Assets/Scenes/Main.unity"],
      mode: "write",
    });
    expect(bobLease.acquired).toBe(true);

    const blocked = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Update File: Assets/Scenes/Main.unity\n*** End Patch" },
      }),
    );
    expect(blocked).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
    expect(JSON.stringify(blocked)).toContain("Bob");

    const preGenerator = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: src/generated.ts\n*** End Patch" },
      }),
    );
    expect(preGenerator).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
    await writeFile(path.join(repository, "src", "generated.ts"), "export const generated = true;\n", "utf8");
    await writeFile(path.join(repository, "Assets", "Scenes", "Unexpected.unity"), "%YAML 1.1\n", "utf8");

    const attributedOnly = await handleCodexHook(
      options("PostToolUse"),
      input("PostToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: src/generated.ts\n*** End Patch" },
      }),
    );
    expect(attributedOnly).toMatchObject({
      hookSpecificOutput: { hookEventName: "PostToolUse" },
    });
    expect(JSON.stringify(attributedOnly)).toContain("src/generated.ts");
    expect(JSON.stringify(attributedOnly)).not.toContain("Assets/Scenes/Unexpected.unity");

    const nextWrite = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: src/after-quarantine.ts\n*** End Patch" },
      }),
    );
    expect(nextWrite).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
    expect(service.getDashboard(room.memberToken).records).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "risk" })]),
    );

    await handleCodexHook(options("SessionEnd"), input("SessionEnd", { reason: "other" }));
    expect(service.listRoomSessions(room.memberToken).sessions.find(
      (session) => session.id === hookSession?.id,
    )?.status).toBe("active");
    const finalizer = startSessionEndFinalizationWorker({
      userDataPath,
      store,
      intervalMs: 60_000,
    });
    await finalizer.scanNow();
    await finalizer.stop();
    expect(service.listRoomSessions(room.memberToken).sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "closed" })]),
    );
    const automaticMemory = featureStore.query(featureActor, {
      memberToken: room.memberToken,
      level: "detail",
      paths: ["src/value.ts"],
      statuses: ["draft", "candidate", "current", "conflict", "superseded", "deprecated"],
      limit: 20,
    }).details.find((revision) =>
      revision.sourceSessionId === hookSession!.id
      && revision.targets.some((target) => target.path === "src/value.ts"));
    expect(automaticMemory).toBeDefined();
    expect(automaticMemory?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "symbol", path: "src/value.ts", symbol: "value" }),
    ]));
    expect(automaticMemory?.targets).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "path", path: "src/value.ts" }),
    ]));
  }, 30_000);
});

async function createConnectedHookFixture(prefix: string, sessionId: string) {
  const root = await mkdtemp(path.join(tmpdir(), `agent-hub-${prefix}-`));
  temporaryDirectories.push(root);
  const repository = path.join(root, "repository");
  const userDataPath = path.join(root, "user-data");
  await createRepository(repository);
  presences.push(await startRuntimePresence(path.join(userDataPath, "runtime-presence.json"), {
    heartbeatIntervalMs: 0,
  }));
  const database = new AgentHubDatabase({ path: path.join(root, "agent-hub.sqlite") });
  databases.push(database);
  const service = new AgentHubService(database);
  const room = service.createRoom({
    name: `${prefix} room`,
    projectName: `${prefix} project`,
    repository: `https://example.test/team/${prefix}.git`,
    defaultBranch: "main",
    hostName: "Alice",
    hostAgent: "Codex",
  });
  const server = createAgentHubApp({ database, service }).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new ConnectionStore(path.join(userDataPath, "connections.json"), protector).save({
    serverUrl: `http://127.0.0.1:${port}`,
    memberToken: room.memberToken,
    repositoryPath: repository,
    roomId: room.room.id,
    roomName: room.room.name,
    memberName: room.member.displayName,
  });

  return {
    repository,
    userDataPath,
    sessionId,
    service,
    room,
    options: (
      eventName: RunCodexHookOptions["eventName"],
      fetchImpl?: typeof fetch,
    ): RunCodexHookOptions => ({
      eventName,
      userDataPath,
      protector,
      fetchImpl,
    }),
    input: (
      eventName: CodexHookInput["hook_event_name"],
      extra: Partial<CodexHookInput> = {},
    ): CodexHookInput => ({
      session_id: sessionId,
      cwd: repository,
      hook_event_name: eventName,
      ...extra,
    }),
  };
}

async function createRepository(repository: string): Promise<void> {
  await mkdir(path.join(repository, "src"), { recursive: true });
  await mkdir(path.join(repository, "Assets", "Scenes"), { recursive: true });
  await writeFile(path.join(repository, "src", "value.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(repository, "src", "protected.ts"), "export function protectedBehavior() { return 1; }\n", "utf8");
  await writeFile(path.join(repository, "src", "foo.ts"), "export class Foo {\n  bar() { return 1; }\n}\n", "utf8");
  await writeFile(path.join(repository, "Assets", "Scenes", "Main.unity"), "%YAML 1.1\n", "utf8");
  await runGit(repository, ["init"]);
  await runGit(repository, ["config", "core.fsmonitor", "false"]);
  await runGit(repository, ["config", "user.email", "agent-hub@example.test"]);
  await runGit(repository, ["config", "user.name", "Agent Hub Test"]);
  await runGit(repository, ["add", "."]);
  await runGit(repository, ["commit", "-m", "Initial commit"]);
  await runGit(repository, ["branch", "-M", "main"]);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, windowsHide: true });
}

async function outputGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    windowsHide: true,
    encoding: "utf8",
  });
  return result.stdout;
}
