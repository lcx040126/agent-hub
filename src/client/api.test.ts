import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateSavedConnection,
  ApiError,
  createLease,
  createRecord,
  createRoom,
  deleteSavedConnection,
  getDashboard,
  getLeaseScopeEvents,
  joinRoom,
  loadSession,
  pauseSavedConnection,
  resumeSavedConnection,
  saveSession,
  secureDesktopSession,
  updateRoomSettings,
  type Session,
} from "./api";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;
const originalSessionStorage = globalThis.sessionStorage;

function desktopSession(connectionId: string): Session {
  return {
    connectionId,
    serverUrl: "http://127.0.0.1:4173",
    repositoryPath: "D:\\UGit\\projectvanguard",
    room: {
      id: "room-1",
      name: "先锋协作",
      projectName: "Project Vanguard",
      repository: "https://github.com/example/project-vanguard.git",
      defaultBranch: "main",
    },
    member: {
      id: "member-a",
      name: "成员 A",
      role: "member",
      status: "online",
      compatibility: "unknown",
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: originalSessionStorage });
});

describe("desktop room transport", () => {
  it("sends the fixed decision predecessor when replacing a decision", async () => {
    const requestRoomServer = vi.fn(async () => ({
      status: 201,
      body: { decision: { supersedesDecisionId: "decision-old" } },
    }));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:4173" },
        agentHubDesktop: { requestRoomServer },
      },
    });

    await createRecord(desktopSession("connection-a"), {
      kind: "decision",
      title: "背包容量规则",
      summary: "背包满时将奖励发往邮箱。",
      paths: ["src/inventory"],
      evidence: "避免奖励丢失。",
      supersedesDecisionId: "decision-old",
    });

    expect(requestRoomServer).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST",
      path: "/api/decisions/decision-old/supersede",
      body: {
        paths: ["src/inventory"],
        title: "背包容量规则",
        decision: "背包满时将奖励发往邮箱。",
        rationale: "避免奖励丢失。",
        supersedesDecisionId: "decision-old",
      },
    }));
  });

  it("does not fall back to an independent record when replacement is unsupported", async () => {
    const requestRoomServer = vi.fn(async () => ({
      status: 404,
      body: { error: "not_found", message: "Endpoint not found." },
    }));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:4173" },
        agentHubDesktop: { requestRoomServer },
      },
    });

    await expect(createRecord(desktopSession("connection-a"), {
      kind: "decision",
      title: "背包容量规则",
      summary: "新的规则。",
      evidence: "新的判断依据。",
      supersedesDecisionId: "decision-old",
    })).rejects.toMatchObject({
      status: 409,
      code: "decision_supersession_unsupported",
    });
    expect(requestRoomServer).toHaveBeenCalledTimes(1);
    expect(requestRoomServer).not.toHaveBeenCalledWith(expect.objectContaining({
      path: "/api/records",
    }));
  });

  it("requires the server to confirm the exact replacement relationship", async () => {
    const requestRoomServer = vi.fn(async () => ({
      status: 201,
      body: { decision: { id: "decision-new", supersedesDecisionId: null } },
    }));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:4173" },
        agentHubDesktop: { requestRoomServer },
      },
    });

    await expect(createRecord(desktopSession("connection-a"), {
      kind: "decision",
      title: "背包容量规则",
      summary: "新的规则。",
      evidence: "新的判断依据。",
      supersedesDecisionId: "decision-old",
    })).rejects.toMatchObject({
      status: 409,
      code: "decision_supersession_unconfirmed",
    });
  });

  it("translates a concurrent decision replacement conflict", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:4173" },
        agentHubDesktop: {
          requestRoomServer: vi.fn(async () => ({
            status: 409,
            body: {
              error: "decision_already_superseded",
              details: { currentDecisionId: "decision-current" },
            },
          })),
        },
      },
    });

    await expect(createRecord(desktopSession("connection-a"), {
      kind: "decision",
      title: "背包容量规则",
      summary: "新的规则。",
      evidence: "新的判断依据。",
      supersedesDecisionId: "decision-old",
    })).rejects.toMatchObject({
      status: 409,
      code: "decision_already_superseded",
      message: "这条决定已被其他成员更新，请刷新后基于当前决定重试。",
      details: { currentDecisionId: "decision-current" },
    });
  });

  it("deduplicates snapshot decision projections while preserving replacement links", async () => {
    const projectedDecision = {
      id: "decision-current",
      kind: "decision",
      title: "当前背包规则",
      summary: "背包满时将奖励发往邮箱。",
      memberName: "成员 A",
      paths: ["src/inventory"],
      status: "current",
      evidence: ["避免奖励丢失。"],
      supersedesDecisionId: "decision-old",
      createdAt: "2026-08-29T08:00:00.000Z",
    };
    const requestRoomServer = vi.fn(async (input: { path: string }) => input.path === "/api/dashboard"
      ? { status: 404, body: { error: "not_found" } }
      : {
          status: 200,
          body: {
            room: desktopSession("connection-a").room,
            currentMember: desktopSession("connection-a").member,
            members: [],
            activeLeases: [],
            records: [
              projectedDecision,
              {
                ...projectedDecision,
                id: "decision-old",
                title: "旧背包规则",
                status: "superseded",
                supersedesDecisionId: undefined,
                supersededByDecisionId: "decision-current",
                createdAt: "2026-08-28T08:00:00.000Z",
              },
            ],
            decisions: [
              {
                id: "decision-current",
                title: "当前背包规则",
                decision: "背包满时将奖励发往邮箱。",
                rationale: "避免奖励丢失。",
                authorName: "成员 A",
                paths: ["src/inventory"],
                status: "current",
                supersedesDecisionId: "decision-old",
                createdAt: "2026-08-29T08:00:00.000Z",
              },
              {
                id: "decision-old",
                title: "旧背包规则",
                decision: "背包满时保留在场景。",
                authorName: "成员 A",
                paths: ["src/inventory"],
                status: "superseded",
                supersededByDecisionId: "decision-current",
                createdAt: "2026-08-28T08:00:00.000Z",
              },
            ],
            verifications: [],
            handoffs: [],
            contextEntries: [],
            sessions: [],
            localScans: [],
            activities: [],
            server: { mcpUrl: "http://127.0.0.1:4173/mcp" },
          },
        });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:4173" },
        agentHubDesktop: { requestRoomServer },
      },
    });

    const result = await getDashboard(desktopSession("connection-a"));

    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      id: "decision-current",
      status: "current",
      evidence: "避免奖励丢失。",
      supersedesDecisionId: "decision-old",
    });
    expect(result.records[1]).toMatchObject({
      id: "decision-old",
      status: "superseded",
      supersededByDecisionId: "decision-current",
    });
  });

  it("sends only manual standard or exclusive lease kinds from the UI client", async () => {
    const requestRoomServer = vi.fn(async (_input: { body?: unknown }) => ({
      status: 200,
      body: { acquired: false, decision: "warn", conflicts: [] },
    }));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:4173" },
        agentHubDesktop: { requestRoomServer },
      },
    });

    await createLease(desktopSession("connection-a"), {
      title: "Manual standard scope",
      paths: ["src/client"],
      ttlMinutes: 10,
    });
    await createLease(desktopSession("connection-a"), {
      title: "Manual exclusive scope",
      paths: ["ProjectSettings"],
      ttlMinutes: 60,
      kind: "exclusive",
    });

    expect(requestRoomServer).toHaveBeenCalledTimes(2);
    const standardBody = requestRoomServer.mock.calls[0]![0].body;
    const exclusiveBody = requestRoomServer.mock.calls[1]![0].body;
    expect(standardBody).toMatchObject({ kind: "standard", mode: "write" });
    expect(exclusiveBody).toMatchObject({ kind: "exclusive", mode: "write" });
    for (const body of [standardBody, exclusiveBody]) {
      expect(body).not.toHaveProperty("autoClaim");
      expect(body).not.toHaveProperty("managedBy");
      expect(body).not.toHaveProperty("createdVia");
    }
  });

  it("loads paged lease scope events and normalizes structured call metadata", async () => {
    const requestRoomServer = vi.fn(async () => ({
      status: 200,
      body: {
        items: [{
          id: "activity-19",
          type: "lease.scope_expanded",
          actorName: "成员 A",
          title: "Lease scope expanded",
          summary: "Added one repository path.",
          metadata: {
            invocationId: "invocation-1234567890",
            source: "hook",
            toolName: "exec_command",
            stage: "post",
            turnId: "turn-1234567890",
            requestedPaths: ["src/client/api.ts", 42],
            coveredPaths: ["src/client/api.ts"],
            addedPaths: ["src/client/App.tsx"],
            ignoredPaths: ["C:/Temp/test.log"],
            actualPaths: ["src/client/App.tsx"],
            pathDiagnostics: ["Join-Path target could not be proven statically.", 42],
          },
          createdAt: "2026-08-29T02:00:00.000Z",
        }],
        nextBefore: "activity-19",
      },
    }));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:4173" },
        agentHubDesktop: { requestRoomServer },
      },
    });

    const result = await getLeaseScopeEvents(desktopSession("connection-a"), "lease/agent", {
      limit: 150,
      before: "activity/20",
    });

    expect(requestRoomServer).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      path: "/api/leases/lease%2Fagent/scope-events?limit=100&before=activity%2F20",
    }));
    expect(result).toEqual({
      items: [expect.objectContaining({
        id: "activity-19",
        type: "lease.scope_expanded",
        actorName: "成员 A",
        metadata: {
          invocationId: "invocation-1234567890",
          source: "hook",
          toolName: "exec_command",
          stage: "post",
          turnId: "turn-1234567890",
          requestedPaths: ["src/client/api.ts"],
          coveredPaths: ["src/client/api.ts"],
          addedPaths: ["src/client/App.tsx"],
          ignoredPaths: ["C:/Temp/test.log"],
          actualPaths: ["src/client/App.tsx"],
          pathDiagnostics: ["Join-Path target could not be proven statically."],
        },
      })],
      nextBefore: "activity-19",
    });
  });

  it("drops unsupported scope-event sources while preserving path diagnostics", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:4173" },
        agentHubDesktop: {
          requestRoomServer: vi.fn(async () => ({
            status: 200,
            body: {
              items: [{
                id: "activity-unsupported-source",
                type: "lease.scope_observed",
                metadata: {
                  source: "public-request-spoof",
                  pathDiagnostics: ["The target remained dynamic."],
                },
              }],
            },
          })),
        },
      },
    });

    const result = await getLeaseScopeEvents(desktopSession("connection-a"), "lease-agent");

    expect(result.items[0]?.metadata.source).toBeUndefined();
    expect(result.items[0]?.metadata.pathDiagnostics).toEqual(["The target remained dynamic."]);
  });

  it("does not infer a denial when a legacy lease response omits decision", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:4173" },
        agentHubDesktop: {
          requestRoomServer: vi.fn(async () => ({
            status: 200,
            body: {
              acquired: false,
              conflicts: [{
                id: "legacy-critical",
                severity: "blocking",
                reason: "Legacy response without an execution decision.",
              }],
            },
          })),
        },
      },
    });

    const result = await createLease(desktopSession("connection-a"), {
      title: "Legacy monitor response",
      paths: ["ProjectSettings/ProjectSettings.asset"],
      ttlMinutes: 10,
    });

    expect(result).toMatchObject({
      acquired: false,
      decision: "warn",
      coverage: [],
      conflicts: [expect.objectContaining({ severity: "blocking", decision: "warn" })],
    });
  });

  it("normalizes manual coverage and Agent scope additions from a claim response", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:4173" },
        agentHubDesktop: {
          requestRoomServer: vi.fn(async () => ({
            status: 200,
            body: {
              acquired: true,
              decision: "allow",
              conflicts: [],
              coverage: [
                { leaseId: "manual-1", managedBy: "manual", paths: ["src/client/api.ts"], action: "covered" },
                { leaseId: "agent-1", managedBy: "agent", paths: ["src/client/App.tsx"], action: "added" },
                { leaseId: "invalid", managedBy: "unknown", paths: ["ignored"], action: "added" },
              ],
            },
          })),
        },
      },
    });

    const result = await createLease(desktopSession("connection-a"), {
      title: "Expand scope",
      paths: ["src/client/api.ts", "src/client/App.tsx"],
      ttlMinutes: 10,
    });

    expect(result.coverage).toEqual([
      { leaseId: "manual-1", managedBy: "manual", paths: ["src/client/api.ts"], action: "covered" },
      { leaseId: "agent-1", managedBy: "agent", paths: ["src/client/App.tsx"], action: "added" },
    ]);
  });

  it("preserves structured server error details for monitor-mode upgrade guidance", async () => {
    const details = {
      requiredProtocolVersion: 2,
      members: [{
        id: "member-old",
        displayName: "旧客户端成员",
        clientVersion: "0.2.5",
        protocolVersion: 1,
      }],
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:4173" },
        agentHubDesktop: {
          requestRoomServer: vi.fn(async () => ({
            status: 409,
            body: {
              error: "monitor_mode_upgrade_required",
              message: "Every room member must upgrade.",
              details,
            },
          })),
        },
      },
    });

    const operation = updateRoomSettings(desktopSession("connection-a"), {
      blockingProtectionEnabled: false,
    });
    await expect(operation).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      code: "monitor_mode_upgrade_required",
      details,
    });
    await operation.catch((error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
    });
  });

  it("uses the local server internally but gives the host a LAN invite address", async () => {
    const requestRoomServer = vi.fn(async () => ({
      status: 201,
      body: {
        memberToken: "host-secret",
        inviteCode: "ROOM-123",
        room: {
          id: "room-1",
          name: "先锋协作",
          projectName: "Project Vanguard",
          repository: "https://github.com/example/project-vanguard.git",
          defaultBranch: "main",
        },
        member: { id: "host-a", name: "房主 A", role: "owner" },
      },
    }));

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:4173" },
        agentHubDesktop: {
          getServerInfo: vi.fn(async () => ({
            localServerUrl: "http://127.0.0.1:4173",
            lanUrls: ["http://192.168.1.25:4173"],
            port: 4173,
          })),
          requestRoomServer,
        },
      },
    });

    const created = await createRoom({
      roomName: "先锋协作",
      projectName: "Project Vanguard",
      repository: "https://github.com/example/project-vanguard.git",
      defaultBranch: "main",
      ownerName: "房主 A",
    });

    expect(requestRoomServer).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: "http://127.0.0.1:4173",
      method: "POST",
      path: "/api/rooms",
    }));
    expect(created.serverUrl).toBe("http://127.0.0.1:4173");
    expect(created.inviteServerUrl).toBe("http://192.168.1.25:4173");
  });

  it("uses the server URL only for joining, then uses a saved connection ID", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const savedConnection = {
      id: "connection-1",
      serverUrl: "http://192.168.1.25:4173",
      repositoryPath: "D:\\UGit\\projectvanguard",
      roomId: "room-1",
      roomName: "先锋协作",
      memberName: "成员 B",
      memberRole: "member" as const,
      integrationEnabled: true,
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
    };
    const saveRoomConnection = vi.fn(async () => ({
      connection: savedConnection,
      pausedConnectionIds: ["connection-old"],
      warnings: ["旧房间离线，远端清理将在稍后重试。"],
    }));
    const requestRoomServer = vi.fn(async (input: Record<string, unknown>) => {
      requests.push(input);
      if (input.path === "/api/rooms/join") {
        return {
          status: 201,
          body: {
            memberToken: "secret-member-token",
            inviteCode: "ROOM-123",
            room: {
              id: "room-1",
              code: "ROOM-123",
              name: "先锋协作",
              projectName: "Project Vanguard",
              repository: "https://github.com/example/project-vanguard.git",
              defaultBranch: "main",
            },
            member: { id: "member-b", name: "成员 B", role: "member" },
          },
        };
      }
      if (input.path === "/api/dashboard") {
        return {
          status: 200,
          body: {
            room: {
              id: "room-1",
              code: "ROOM-123",
              name: "先锋协作",
              projectName: "Project Vanguard",
              repository: "https://github.com/example/project-vanguard.git",
              defaultBranch: "main",
            },
            currentMember: { id: "member-b", name: "成员 B", role: "member" },
            members: [],
            leases: [],
            conflicts: [],
            records: [],
            activity: [],
            sessions: [],
            localScans: [],
            server: { mcpUrl: "http://192.168.1.25:4173/mcp" },
          },
        };
      }
      return {
        status: 201,
        body: { acquired: true, decision: "allow", conflicts: [] },
      };
    });

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:4173" },
        agentHubDesktop: {
          requestRoomServer,
          saveRoomConnection,
        },
      },
    });

    const joined = await joinRoom({
      serverUrl: "http://192.168.1.25:4173",
      roomToken: "ROOM-123",
      memberName: "成员 B",
      agent: "Codex",
    });
    expect(joined.memberToken).toBe("secret-member-token");
    expect(requests[0]).toEqual({
      serverUrl: "http://192.168.1.25:4173",
      method: "POST",
      path: "/api/rooms/join",
      body: { inviteCode: "ROOM-123", memberName: "成员 B", clientName: "Codex" },
    });

    const secured = await secureDesktopSession(
      joined,
      "http://192.168.1.25:4173",
      "D:\\UGit\\projectvanguard",
    );
    const saved = secured.session;
    expect(saveRoomConnection).toHaveBeenCalledWith(expect.objectContaining({
      memberToken: "secret-member-token",
      repositoryPath: "D:\\UGit\\projectvanguard",
      memberRole: "member",
    }));
    expect(saved.memberToken).toBeUndefined();
    expect(saved.connectionId).toBe("connection-1");
    expect(secured.activation).toMatchObject({
      pausedConnectionIds: ["connection-old"],
      warnings: ["旧房间离线，远端清理将在稍后重试。"],
    });

    await getDashboard(saved);
    await createLease(saved, {
      title: "调整背包装备事务",
      objective: "保持旧功能有效",
      paths: ["Assets/Vanguard/Inventory"],
      ttlMinutes: 120,
    });

    expect(requests[1]).toEqual({
      connectionId: "connection-1",
      method: "GET",
      path: "/api/dashboard",
    });
    expect(requests[2]).toEqual(expect.objectContaining({
      connectionId: "connection-1",
      method: "POST",
      path: "/api/leases",
    }));
    expect(JSON.stringify(requests.slice(1))).not.toContain("secret-member-token");
    expect(JSON.stringify(requests.slice(1))).not.toContain("192.168.1.25");
  });

  it("persists and restores the host role for a saved desktop room", async () => {
    const saveRoomConnection = vi.fn(async (input: Record<string, unknown>) => ({
      connection: {
        id: "host-connection",
        serverUrl: input.serverUrl as string,
        repositoryPath: input.repositoryPath as string,
        roomId: input.roomId as string,
        roomName: input.roomName as string,
        memberName: input.memberName as string,
        memberRole: input.memberRole as "host" | "member",
        integrationEnabled: true,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
      pausedConnectionIds: [],
      warnings: [],
    }));
    const pauseRoomConnection = vi.fn(async () => ({
      queued: false,
      requestId: "pause-host",
      localRoomServerStopped: true,
    }));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { agentHubDesktop: { saveRoomConnection, pauseRoomConnection } },
    });
    const hostSession: Session = {
      memberToken: "host-token",
      room: {
        id: "room-host",
        name: "房主房间",
        projectName: "Project Vanguard",
        repository: "https://github.com/example/project-vanguard.git",
        defaultBranch: "main",
      },
      member: {
        id: "host-a",
        name: "房主 A",
        role: "host",
        status: "online",
        compatibility: "compatible",
      },
    };

    const secured = (await secureDesktopSession(
      hostSession,
      "http://127.0.0.1:4173",
      "D:\\UGit\\projectvanguard",
    )).session;
    expect(saveRoomConnection).toHaveBeenCalledWith(expect.objectContaining({ memberRole: "host" }));
    const restored = resumeSavedConnection({
      id: secured.connectionId!,
      serverUrl: secured.serverUrl!,
      repositoryPath: secured.repositoryPath!,
      roomId: hostSession.room.id,
      roomName: hostSession.room.name,
      memberName: hostSession.member.name,
      memberRole: "host",
      integrationEnabled: true,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(restored.member.role).toBe("host");
    await pauseSavedConnection(restored.connectionId!);
    expect(pauseRoomConnection).toHaveBeenCalledWith("host-connection");
  });

  it("returns a permanent cleanup diagnostic from the desktop bridge", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        agentHubDesktop: {
          pauseRoomConnection: vi.fn(async () => ({
            queued: false,
            requestId: "pause-auth-failed",
            cleanupError: "The member token is invalid.",
            localRoomServerStopped: false,
          })),
        },
      },
    });

    await expect(pauseSavedConnection("connection-a")).resolves.toMatchObject({
      queued: false,
      cleanupError: "The member token is invalid.",
    });
  });

  it("returns activation details when switching the active room for a project", async () => {
    const result = {
      connection: {
        id: "connection-b",
        serverUrl: "http://127.0.0.1:4173",
        repositoryPath: "D:\\UGit\\projectvanguard",
        roomName: "当前房间",
        integrationEnabled: true,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T01:00:00.000Z",
      },
      pausedConnectionIds: ["connection-a"],
      warnings: ["旧房间离线，远端清理将在稍后重试。"],
    };
    const activateRoomConnection = vi.fn(async () => result);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { agentHubDesktop: { activateRoomConnection } },
    });

    await expect(activateSavedConnection("connection-b")).resolves.toEqual(result);
    expect(activateRoomConnection).toHaveBeenCalledWith("connection-b");
  });

  it("deletes a saved room through the desktop bridge and returns cleanup status", async () => {
    const local = new MemoryStorage();
    const runtime = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: runtime });
    saveSession(desktopSession("connection-a"));
    const result = {
      deletedConnectionId: "connection-a",
      remoteCleanup: "pending" as const,
      codexConfigChanged: true,
      codexRestartRequired: true,
      warnings: ["房间服务当前离线。"],
    };
    const deleteRoomConnection = vi.fn(async () => result);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { agentHubDesktop: { deleteRoomConnection } },
    });

    await expect(deleteSavedConnection("connection-a")).resolves.toEqual(result);
    expect(deleteRoomConnection).toHaveBeenCalledWith("connection-a");
    expect(loadSession()).toBeNull();
    expect(local.length).toBe(0);
    expect(runtime.length).toBe(0);
  });

  it("keeps the current room pointer when another saved room is deleted", async () => {
    const local = new MemoryStorage();
    const runtime = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: runtime });
    saveSession(desktopSession("connection-current"));
    const deleteRoomConnection = vi.fn(async () => ({
      deletedConnectionId: "connection-other",
      remoteCleanup: "completed" as const,
      codexConfigChanged: false,
      codexRestartRequired: false,
      warnings: [],
    }));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { agentHubDesktop: { deleteRoomConnection } },
    });

    await deleteSavedConnection("connection-other");

    expect(loadSession()?.connectionId).toBe("connection-current");
  });

  it("preserves the current room pointer when local deletion fails", async () => {
    const local = new MemoryStorage();
    const runtime = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: runtime });
    saveSession(desktopSession("connection-a"));
    const deleteRoomConnection = vi.fn(async () => {
      throw new Error("Codex 配置无法安全写回。");
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { agentHubDesktop: { deleteRoomConnection } },
    });

    await expect(deleteSavedConnection("connection-a")).rejects.toThrow("Codex 配置无法安全写回");

    expect(loadSession()?.connectionId).toBe("connection-a");
  });

  it("rejects a mismatched deletion result without clearing the current pointer", async () => {
    const local = new MemoryStorage();
    const runtime = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: runtime });
    saveSession(desktopSession("connection-a"));
    const deleteRoomConnection = vi.fn(async () => ({
      deletedConnectionId: "connection-b",
      remoteCleanup: "completed" as const,
      codexConfigChanged: false,
      codexRestartRequired: false,
      warnings: [],
    }));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { agentHubDesktop: { deleteRoomConnection } },
    });

    await expect(deleteSavedConnection("connection-a")).rejects.toThrow("不匹配的房间连接标识");

    expect(loadSession()?.connectionId).toBe("connection-a");
  });

  it("does not pretend to delete local room data outside a supported desktop bridge", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { agentHubDesktop: {} },
    });

    await expect(deleteSavedConnection("connection-a")).rejects.toThrow(
      "仅桌面客户端支持从本机移除已保存的房间连接",
    );
  });
});

describe("session persistence", () => {
  it("stores desktop pointers without tokens and browser tokens only for the tab session", () => {
    const local = new MemoryStorage();
    const runtime = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: runtime });

    const base: Session = {
      memberToken: "secret-member-token",
      roomToken: "ROOM-123",
      room: {
        id: "room-1",
        name: "先锋协作",
        code: "ROOM-123",
        projectName: "Project Vanguard",
        repository: "https://github.com/example/project-vanguard.git",
        defaultBranch: "main",
      },
      member: { id: "member-b", name: "成员 B", role: "member", status: "online", compatibility: "unknown" },
    };

    saveSession(base);
    expect([...Array(local.length)].map((_, index) => local.getItem(local.key(index)!)).join(""))
      .not.toContain("secret-member-token");
    expect([...Array(runtime.length)].map((_, index) => runtime.getItem(runtime.key(index)!)).join(""))
      .toContain("secret-member-token");
    expect(loadSession()?.memberToken).toBe("secret-member-token");

    const desktopSession: Session = {
      ...base,
      memberToken: undefined,
      connectionId: "connection-1",
      serverUrl: "http://192.168.1.25:4173",
      inviteServerUrl: "http://192.168.1.25:4173",
      repositoryPath: "D:\\UGit\\projectvanguard",
    };
    saveSession(desktopSession);
    const persisted = [...Array(local.length)]
      .map((_, index) => local.getItem(local.key(index)!))
      .join("");
    expect(persisted).toContain("connection-1");
    expect(persisted).toContain("192.168.1.25");
    expect(persisted).not.toContain("secret-member-token");
    expect(persisted).not.toContain("ROOM-123");
    expect(runtime.length).toBe(0);
  });
});

describe("dashboard lease compatibility", () => {
  it("preserves awaiting_commit and treats missing or unknown phases as working", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:4173" },
        agentHubDesktop: {
          requestRoomServer: vi.fn(async () => ({
            status: 200,
            body: {
              room: {
                id: "room-1",
                name: "先锋协作",
                projectName: "Project Vanguard",
                repository: "https://github.com/example/project-vanguard.git",
                defaultBranch: "main",
              },
              currentMember: { id: "member-a", name: "成员 A", role: "member" },
              members: [],
              leases: [
                {
                  id: "lease-awaiting",
                  sessionId: "hub-session-1234567890",
                  title: "等待提交",
                  memberId: "member-a",
                  memberName: "成员 A",
                  paths: ["src/client/App.tsx"],
                  mode: "write",
                  kind: "automatic",
                  managedBy: "agent",
                  createdVia: "mcp",
                  phase: "awaiting_commit",
                  status: "active",
                  expiresAt: "2026-08-27T08:10:00.000Z",
                },
                {
                  id: "lease-legacy",
                  title: "旧服务响应",
                  memberId: "member-a",
                  memberName: "成员 A",
                  paths: ["src/client/api.ts"],
                  mode: "write",
                  kind: "automatic",
                  status: "active",
                  expiresAt: "2026-08-27T08:10:00.000Z",
                },
                {
                  id: "lease-unknown",
                  title: "未知阶段",
                  memberId: "member-a",
                  memberName: "成员 A",
                  paths: ["src/client/styles.css"],
                  mode: "write",
                  kind: "standard",
                  phase: "future_phase",
                  status: "active",
                  expiresAt: "2026-08-27T08:10:00.000Z",
                },
              ],
              conflicts: [
                {
                  id: "high-warning",
                  title: "Critical scope risk",
                  summary: "The red warning remains writable.",
                  severity: "blocking",
                  decision: "warn",
                  paths: ["ProjectSettings/ProjectSettings.asset"],
                },
                {
                  id: "legacy-high-warning",
                  title: "Legacy high-risk overlap",
                  summary: "Missing decisions must not become denials.",
                  severity: "critical",
                  paths: ["ProjectSettings/TagManager.asset"],
                },
              ],
              records: [],
              activity: [],
              sessions: [{
                id: "session-stopped",
                memberId: "member-a",
                codexSessionId: "codex-session-1234567890",
                currentTurnId: "turn-1234567890",
                activityEpoch: 4,
                status: "active",
                lastSeenAt: "2026-08-27T08:00:00.000Z",
                turnStoppedAt: "2026-08-27T08:00:00.000Z",
              }],
              localScans: [],
              releaseRequests: [{
                id: "request-1",
                holderMemberId: "member-a",
                requestedPaths: ["Assets/Scenes/Main.unity"],
                status: "pending",
              }],
              generatedAt: "2026-08-27T08:00:00.000Z",
              server: { mcpUrl: "http://127.0.0.1:4173/mcp" },
            },
          })),
        },
      },
    });

    const result = await getDashboard(desktopSession("connection-1"));

    expect(result.leases.map((item) => [item.id, item.phase])).toEqual([
      ["lease-awaiting", "awaiting_commit"],
      ["lease-legacy", "working"],
      ["lease-unknown", "working"],
    ]);
    expect(result.leases[0]).toMatchObject({
      sessionId: "hub-session-1234567890",
      managedBy: "agent",
      createdVia: "mcp",
    });
    expect(result.leases[1]).toMatchObject({ managedBy: "agent", createdVia: "legacy" });
    expect(result.leases[2]).toMatchObject({ managedBy: "manual", createdVia: "legacy" });
    expect(result.sessions[0]).toMatchObject({
      codexSessionId: "codex-session-1234567890",
      currentTurnId: "turn-1234567890",
      activityEpoch: 4,
      turnStoppedAt: "2026-08-27T08:00:00.000Z",
    });
    expect(result.releaseRequests[0]).toMatchObject({
      id: "request-1",
      requestedPaths: ["Assets/Scenes/Main.unity"],
      overlapPaths: [],
    });
    expect(result.generatedAt).toBe("2026-08-27T08:00:00.000Z");
    expect(result.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "high-warning",
        title: "检测到高风险范围重叠",
        severity: "blocking",
        decision: "warn",
      }),
      expect.objectContaining({ id: "legacy-high-warning", severity: "blocking", decision: "warn" }),
    ]));
  });
});
