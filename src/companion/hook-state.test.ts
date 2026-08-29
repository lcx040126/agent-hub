import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyHookProtectionMode,
  CodexHookStateLockTimeoutError,
  CodexHookStateStore,
  type CodexHookSessionState,
} from "./hook-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("CodexHookStateStore", () => {
  it("persists coordination IDs and paths without storing a member token", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-hook-state-"));
    temporaryDirectories.push(directory);
    const store = new CodexHookStateStore(directory);
    const now = new Date().toISOString();
    const state: CodexHookSessionState = {
      version: 1,
      codexSessionId: "thread/with unsafe file characters",
      connectionId: "connection-1",
      hubSessionId: "hub-session-1",
      repositoryPath: directory,
      branch: "feature/test",
      baseCommit: "0123456789abcdef",
      initialChangedPaths: ["src/existing.ts"],
      initialChangedFingerprints: { "src/existing.ts": "initial-fingerprint" },
      observedChangedPaths: ["src/existing.ts"],
      observedChangedFingerprints: { "src/existing.ts": "observed-fingerprint" },
      attributedChangedPaths: ["src/new.ts"],
      attributedPathsTruncated: true,
      leases: [{
        id: "lease-1",
        paths: ["src/new.ts"],
        expiresAt: now,
        coordinationState: "blocked",
      }],
      leaseAttributionComplete: false,
      passiveWriteBlock: {
        leaseId: "holder-lease-1",
        sessionId: "holder-session-1",
        memberName: "Alice",
        paths: ["src/held.ts"],
        requestedPaths: ["src/held.ts", "src/also-held.ts"],
        expiresAt: now,
      },
      writeBlockSyncPending: {
        dirty: true,
        paths: ["src/held.ts", "src/also-held.ts"],
        recordedAt: now,
      },
      pendingWrite: {
        proposalHash: "a".repeat(64),
        toolName: "apply_patch",
        invocationId: "11111111-1111-4111-8111-111111111111",
        proposedEdits: [{ path: "src/new.ts", precision: "symbol", symbols: ["createItem"], operation: "update" }],
        attributedSideEffects: false,
        pathDiagnostics: ["dynamic path was not statically provable"],
        ignoredPaths: ["C:/outside/test.log"],
        baselineChangedPaths: ["src/existing.ts"],
        baselineChangedFingerprints: { "src/existing.ts": "observed-fingerprint" },
        recordedAt: now,
      },
      externalChangeDiagnostics: [{ paths: ["Assets/Scene.unity"], detectedAt: now }],
      loadedFeatureVersions: { "inventory-move": "revision-2" },
      lastHeartbeatAt: now,
      quarantine: {
        reason: "A generated file was outside the lease.",
        paths: ["src/generated.ts"],
        detectedAt: now,
      },
      openedAt: now,
      updatedAt: now,
    };

    await store.save(state);
    await expect(store.load(state.codexSessionId)).resolves.toMatchObject({
      connectionId: "connection-1",
      leases: [{ id: "lease-1", paths: ["src/new.ts"], coordinationState: "blocked" }],
      attributedChangedPaths: ["src/new.ts"],
      attributedPathsTruncated: true,
      leaseAttributionComplete: false,
      passiveWriteBlock: {
        leaseId: "holder-lease-1",
        sessionId: "holder-session-1",
        paths: ["src/held.ts"],
        requestedPaths: ["src/held.ts", "src/also-held.ts"],
      },
      writeBlockSyncPending: {
        dirty: true,
        paths: ["src/held.ts", "src/also-held.ts"],
      },
      pendingWrite: {
        invocationId: "11111111-1111-4111-8111-111111111111",
        proposedEdits: [{ symbols: ["createItem"] }],
        pathDiagnostics: ["dynamic path was not statically provable"],
        ignoredPaths: ["C:/outside/test.log"],
      },
      externalChangeDiagnostics: [{ paths: ["Assets/Scene.unity"] }],
      loadedFeatureVersions: { "inventory-move": "revision-2" },
      quarantine: { paths: ["src/generated.ts"] },
    });
    const files = await import("node:fs/promises").then((fs) => fs.readdir(store.directory));
    expect(files).toHaveLength(1);
    const raw = await readFile(path.join(store.directory, files[0]!), "utf8");
    expect(raw).not.toContain("memberToken");
    expect(raw).not.toContain("secret");

    await store.remove(state.codexSessionId);
    await expect(store.load(state.codexSessionId)).resolves.toBeUndefined();
  });

  it("clears local write fences in monitor mode while preserving attribution and diagnostics", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-hook-monitor-state-"));
    temporaryDirectories.push(directory);
    const store = new CodexHookStateStore(directory);
    const state = stateForConnection(directory, "codex-monitor", "connection-monitor", "hub-monitor");
    const detectedAt = "2026-08-28T01:02:03.000Z";
    state.attributedChangedPaths = ["src/owned.ts"];
    state.leaseAttributionComplete = false;
    state.quarantine = { reason: "branch changed", paths: ["src/branch.ts"], detectedAt };
    state.passiveWriteBlock = {
      leaseId: "older-lease",
      memberName: "Alice",
      paths: ["src/wait.ts"],
      requestedPaths: ["src/wait.ts"],
      expiresAt: "2026-08-28T01:12:03.000Z",
    };
    state.writeBlockSyncPending = {
      dirty: true,
      paths: ["src/sync.ts"],
      recordedAt: detectedAt,
    };
    state.leases = [{
      id: "blocked-auto",
      paths: ["src/lease.ts"],
      expiresAt: "2026-08-28T01:12:03.000Z",
      coordinationState: "blocked",
    }];

    const transition = applyHookProtectionMode(state, false, detectedAt);
    expect(transition.changed).toBe(true);
    expect(transition.warnings).toHaveLength(4);
    await store.save(state);

    await expect(store.load(state.codexSessionId)).resolves.toMatchObject({
      blockingProtectionEnabled: false,
      attributedChangedPaths: ["src/owned.ts"],
      leaseAttributionComplete: false,
      leases: [{ id: "blocked-auto", paths: ["src/lease.ts"] }],
      advisoryDiagnostics: [
        { source: "quarantine", reason: "branch changed", paths: ["src/branch.ts"] },
        { source: "passive_wait", paths: ["src/wait.ts"] },
        { source: "write_block_sync", paths: ["src/sync.ts"] },
        { source: "blocked_lease", paths: ["src/lease.ts"] },
      ],
    });
    const loaded = (await store.load(state.codexSessionId))!;
    expect(loaded.quarantine).toBeUndefined();
    expect(loaded.passiveWriteBlock).toBeUndefined();
    expect(loaded.writeBlockSyncPending).toBeUndefined();
    expect(loaded.leases[0]?.coordinationState).toBeUndefined();
  });

  it("removes only Hook sessions belonging to the selected room connection", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-hook-state-"));
    temporaryDirectories.push(directory);
    const store = new CodexHookStateStore(directory);
    const first = stateForConnection(directory, "codex-a", "connection-a", "hub-a");
    const second = stateForConnection(directory, "codex-b", "connection-b", "hub-b");
    const third = stateForConnection(directory, "codex-c", "connection-a", "hub-c");
    await Promise.all([store.save(first), store.save(second), store.save(third)]);

    await expect(store.removeForConnection("connection-a")).resolves.toBe(2);
    await expect(store.load(first.codexSessionId)).resolves.toBeUndefined();
    await expect(store.load(third.codexSessionId)).resolves.toBeUndefined();
    await expect(store.load(second.codexSessionId)).resolves.toMatchObject({
      connectionId: "connection-b",
      hubSessionId: "hub-b",
    });
    await expect(store.removeForConnections(["connection-b", "connection-b"])).resolves.toBe(1);
    await expect(store.removeForConnections([])).resolves.toBe(0);
  });

  it("merges renewed lease expiries without refreshing user activity or overwriting state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-hook-state-renew-"));
    temporaryDirectories.push(directory);
    const store = new CodexHookStateStore(directory);
    const state = stateForConnection(directory, "codex-renew", "connection-a", "hub-a");
    state.activityEpoch = 4;
    state.currentTurnId = "turn-4";
    state.leases = [{
      id: "lease-1",
      paths: ["src/value.ts"],
      expiresAt: "2026-08-27T00:10:00.000Z",
    }];
    await store.save(state);
    const before = (await store.load(state.codexSessionId))!;

    await store.updateLeaseExpiries(state.codexSessionId, [
      { id: "lease-1", expiresAt: "2026-08-27T00:20:00.000Z" },
      { id: "unknown-lease", expiresAt: "2026-08-27T00:30:00.000Z" },
    ]);

    await expect(store.load(state.codexSessionId)).resolves.toMatchObject({
      activityEpoch: 4,
      currentTurnId: "turn-4",
      updatedAt: before.updatedAt,
      leases: [{
        id: "lease-1",
        paths: ["src/value.ts"],
        expiresAt: "2026-08-27T00:20:00.000Z",
      }],
    });
  });

  it("times out a competing session lock within budget and releases ownership cleanly", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-hook-state-lock-"));
    temporaryDirectories.push(directory);
    const store = new CodexHookStateStore(directory);
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = store.runExclusive("codex-locked", async () => {
      firstEntered();
      await release;
    });
    await entered;

    await expect(store.runExclusive("codex-locked", async () => undefined, {
      timeoutMs: 40,
    })).rejects.toBeInstanceOf(CodexHookStateLockTimeoutError);
    releaseFirst();
    await first;
    await expect(store.runExclusive("codex-locked", async () => "released", {
      timeoutMs: 100,
    })).resolves.toBe("released");
  });
});

function stateForConnection(
  repositoryPath: string,
  codexSessionId: string,
  connectionId: string,
  hubSessionId: string,
): CodexHookSessionState {
  const now = "2026-08-27T00:00:00.000Z";
  return {
    version: 1,
    codexSessionId,
    connectionId,
    hubSessionId,
    repositoryPath,
    branch: "main",
    baseCommit: "0123456789abcdef",
    initialChangedPaths: [],
    initialChangedFingerprints: {},
    observedChangedPaths: [],
    observedChangedFingerprints: {},
    leases: [],
    openedAt: now,
    updatedAt: now,
  };
}
