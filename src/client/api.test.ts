import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLease,
  createRoom,
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
    const saveRoomConnection = vi.fn(async () => ({
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

    const saved = await secureDesktopSession(
      joined,
      "http://192.168.1.25:4173",
      "D:\\UGit\\projectvanguard",
    );
    expect(saveRoomConnection).toHaveBeenCalledWith(expect.objectContaining({
      memberToken: "secret-member-token",
      repositoryPath: "D:\\UGit\\projectvanguard",
      memberRole: "member",
    }));
    expect(saved.memberToken).toBeUndefined();
    expect(saved.connectionId).toBe("connection-1");

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

    const secured = await secureDesktopSession(
      hostSession,
      "http://127.0.0.1:4173",
      "D:\\UGit\\projectvanguard",
    );
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
