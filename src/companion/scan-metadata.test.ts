import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStore } from "../desktop/connection-store.js";
import type { SavedRoomConnection } from "../desktop/contracts.js";
import { AGENT_HUB_SCAN_METADATA_MAX_LENGTH } from "../shared/limits.js";
import { createAgentHubApp } from "../server/app.js";
import { AgentHubDatabase } from "../server/db.js";
import type { DependencyEdge, RepositorySnapshot } from "./repository.js";
import {
  BackgroundScanMetadataTooLargeError,
  createBackgroundScanPayload,
  startRepositoryScanScheduler,
} from "./scan-scheduler.js";

const databases: AgentHubDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("background scan metadata budget", () => {
  it("trims 7,068 long dependencies to a stable prefix accepted by the real scan endpoint", async () => {
    const snapshot = repositorySnapshot();
    snapshot.dependencies = Array.from({ length: 7_068 }, (_, index) => dependency(index));
    const payload = createBackgroundScanPayload(snapshot);
    const metadata = payload.metadata as ScanMetadata;

    expect(JSON.stringify(metadata).length).toBeLessThanOrEqual(AGENT_HUB_SCAN_METADATA_MAX_LENGTH);
    expect(metadata.dependencyCount).toBe(7_068);
    expect(metadata.dependencyIncludedCount).toBeGreaterThan(0);
    expect(metadata.dependencyIncludedCount).toBeLessThan(7_068);
    expect(metadata.dependencies).toEqual(snapshot.dependencies.slice(0, metadata.dependencyIncludedCount));
    expect(metadata.ruleHashCount).toBe(0);
    expect(metadata.ruleHashIncludedCount).toBe(0);
    expect(metadata.metadataTruncated).toBe(true);

    const database = new AgentHubDatabase({ path: ":memory:" });
    databases.push(database);
    const app = createAgentHubApp({ database });
    const room = await request(app).post("/api/rooms").send({
      roomName: "Scan budget",
      projectName: "Scan budget",
      repository: "https://example.test/scan-budget.git",
      defaultBranch: "main",
      ownerName: "Owner",
    });
    const token = room.body.token as string;
    const session = await request(app).post("/api/sessions")
      .set("Authorization", `Bearer ${token}`)
      .send({ repository: "scan-budget", branch: "main" });
    const scanned = await request(app)
      .post(`/api/sessions/${session.body.session.id as string}/scan`)
      .set("Authorization", `Bearer ${token}`)
      .send(payload);

    expect(scanned.status, JSON.stringify(scanned.body)).toBe(201);
    expect(scanned.body.scan.metadata).toMatchObject({
      dependencyCount: 7_068,
      dependencyIncludedCount: metadata.dependencyIncludedCount,
      metadataTruncated: true,
    });

    const rejected = await request(app)
      .post(`/api/sessions/${session.body.session.id as string}/scan`)
      .set("Authorization", `Bearer ${token}`)
      .send({ metadata: { oversized: "x".repeat(AGENT_HUB_SCAN_METADATA_MAX_LENGTH) } });
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({ error: "invalid_input", message: "Scan metadata is too large." });
  });

  it("lets rule hashes consume the shared budget while dependencies remain empty", () => {
    const snapshot = repositorySnapshot();
    snapshot.ruleFiles = Array.from({ length: 1_000 }, (_, index) => ({
      path: `规则/很长的目录-${index.toString().padStart(4, "0")}/${"子目录".repeat(12)}.md`,
      sha256: index.toString(16).padStart(64, "0"),
      bytes: 100,
    }));
    const metadata = createBackgroundScanPayload(snapshot).metadata as ScanMetadata;

    expect(JSON.stringify(metadata).length).toBeLessThanOrEqual(AGENT_HUB_SCAN_METADATA_MAX_LENGTH);
    expect(metadata.dependencyCount).toBe(0);
    expect(metadata.dependencyIncludedCount).toBe(0);
    expect(metadata.ruleHashCount).toBe(1_000);
    expect(metadata.ruleHashIncludedCount).toBeGreaterThan(0);
    expect(metadata.ruleHashIncludedCount).toBeLessThan(1_000);
    expect(metadata.ruleHashes).toEqual(snapshot.ruleFiles
      .slice(0, metadata.ruleHashIncludedCount)
      .map(({ path, sha256 }) => ({ path, sha256 })));
    expect(metadata.metadataTruncated).toBe(true);
  });

  it("supports empty collections and metadata that exactly reaches the shared limit", () => {
    const snapshot = repositorySnapshot();
    const initial = createBackgroundScanPayload(snapshot).metadata as ScanMetadata;
    const padding = AGENT_HUB_SCAN_METADATA_MAX_LENGTH - JSON.stringify(initial).length;
    snapshot.repository.fingerprint += "x".repeat(padding);
    const metadata = createBackgroundScanPayload(snapshot).metadata as ScanMetadata;

    expect(JSON.stringify(metadata).length).toBe(AGENT_HUB_SCAN_METADATA_MAX_LENGTH);
    expect(metadata).toMatchObject({
      dependencies: [],
      dependencyCount: 0,
      dependencyIncludedCount: 0,
      ruleHashes: [],
      ruleHashCount: 0,
      ruleHashIncludedCount: 0,
      metadataTruncated: false,
    });
  });

  it("does not skip past one oversized dependency and measures multilingual paths by JSON length", () => {
    const snapshot = repositorySnapshot();
    snapshot.dependencies = [
      { ...dependency(0), fromSystemId: "资源/" + "超长路径".repeat(10_000) },
      dependency(1),
    ];
    const metadata = createBackgroundScanPayload(snapshot).metadata as ScanMetadata;

    expect(JSON.stringify(metadata).length).toBeLessThanOrEqual(AGENT_HUB_SCAN_METADATA_MAX_LENGTH);
    expect(metadata.dependencyCount).toBe(2);
    expect(metadata.dependencyIncludedCount).toBe(0);
    expect(metadata.dependencies).toEqual([]);
    expect(metadata.metadataTruncated).toBe(true);
  });

  it("reports fixed metadata overflow locally without reading credentials or sending a request", async () => {
    const connection: SavedRoomConnection = {
      id: "connection-a",
      serverUrl: "http://agent-hub.test:4173",
      repositoryPath: "C:/oversized",
      memberRole: "member",
      integrationEnabled: true,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const store = {
      filePath: "C:/agent-hub/connections.json",
      list: vi.fn(async () => [connection]),
      get: vi.fn(async () => connection),
      readMemberToken: vi.fn(async () => "member-token"),
    } as unknown as ConnectionStore;
    const snapshot = repositorySnapshot();
    snapshot.generatedAt = "x".repeat(AGENT_HUB_SCAN_METADATA_MAX_LENGTH);
    const fetchImpl = vi.fn<typeof fetch>();
    const onError = vi.fn();
    const scheduler = startRepositoryScanScheduler({
      store,
      inspect: vi.fn(async () => snapshot),
      fetchImpl,
      onError,
      intervalMs: 60_000,
    });

    await scheduler.stop();

    expect(onError).toHaveBeenCalledWith(expect.any(BackgroundScanMetadataTooLargeError), connection);
    expect(store.readMemberToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

interface ScanMetadata {
  dependencies: DependencyEdge[];
  dependencyCount: number;
  dependencyIncludedCount: number;
  ruleHashes: Array<{ path: string; sha256: string }>;
  ruleHashCount: number;
  ruleHashIncludedCount: number;
  metadataTruncated: boolean;
}

function repositorySnapshot(): RepositorySnapshot {
  return {
    repository: {
      root: "C:/project",
      name: "project",
      remote: null,
      branch: "main",
      headCommit: "0123456789abcdef",
      rootCommit: "0123456789abcdef",
      fingerprint: "fingerprint-a",
    },
    generatedAt: "2026-08-28T00:00:00.000Z",
    changedPaths: [],
    ruleFiles: [],
    systems: [],
    dependencies: [],
    impactedSystemIds: [],
    analysis: {
      trackedFileCount: 0,
      parsedCSharpFileCount: 0,
      unityReferenceCount: 0,
      historyCommitCount: 0,
      truncated: false,
    },
  };
}

function dependency(index: number): DependencyEdge {
  const suffix = index.toString().padStart(5, "0");
  return {
    fromSystemId: `Assets/LongFeature_${suffix}/Runtime`,
    toSystemId: `Packages/LongDependency_${suffix}/Runtime`,
    kind: "code",
    confidence: 0.95,
    evidenceCount: index + 1,
  };
}
