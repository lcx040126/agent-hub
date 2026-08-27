import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateSavedConnection,
  createLease,
  createRoom,
  deleteSavedConnection,
  getDashboard,
  joinRoom,
  loadSession,
  pauseSavedConnection,
  resumeSavedConnection,
  saveSession,
  secureDesktopSession,
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
                  title: "等待提交",
                  memberId: "member-a",
                  memberName: "成员 A",
                  paths: ["src/client/App.tsx"],
                  mode: "write",
                  kind: "automatic",
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
              conflicts: [],
              records: [],
              activity: [],
              sessions: [{
                id: "session-stopped",
                memberId: "member-a",
                status: "active",
                lastSeenAt: "2026-08-27T08:00:00.000Z",
                turnStoppedAt: "2026-08-27T08:00:00.000Z",
              }],
              localScans: [],
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
    expect(result.sessions[0]?.turnStoppedAt).toBe("2026-08-27T08:00:00.000Z");
    expect(result.generatedAt).toBe("2026-08-27T08:00:00.000Z");
  });
});
