import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexHookStateStore, type CodexHookSessionState } from "./hook-state.js";

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
      leases: [{ id: "lease-1", paths: ["src/new.ts"], expiresAt: now }],
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
      leases: [{ id: "lease-1", paths: ["src/new.ts"] }],
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
});
