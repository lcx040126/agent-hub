import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeleteConnectionModal,
  EntryScreen,
  SavedConnectionList,
  WorkItem,
  WorkView,
  formatLeaseExpiryCountdown,
  isRealtimeAgentSession,
  isValidLease,
  nextPendingReleaseRequestId,
  noticeForActivatedConnection,
  noticeForDeletedConnection,
  protectedSystemsForDashboard,
  splitVisibleLeases,
} from "./App";
import type { Dashboard, Lease, SavedRoomConnection } from "./api";

const originalWindow = globalThis.window;
const LEASE_NOW = Date.parse("2026-08-27T08:00:00.000Z");

function lease(overrides: Partial<Lease> = {}): Lease {
  return {
    id: "lease-a",
    title: "自动工作范围",
    memberId: "member-current",
    memberName: "当前成员",
    paths: ["src/client/App.tsx"],
    highRiskPaths: [],
    mode: "write",
    kind: "automatic",
    phase: "working",
    status: "active",
    expiresAt: "2026-08-27T08:10:00.000Z",
    ...overrides,
  };
}

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  const currentMember: Dashboard["currentMember"] = {
    id: "member-current",
    name: "当前成员",
    role: "member",
    status: "online",
    compatibility: "compatible",
  };
  return {
    room: {
      id: "room-a",
      name: "协作房间",
      projectName: "Agent Hub",
      repository: "https://github.com/example/agent-hub.git",
      defaultBranch: "main",
    },
    currentMember,
    members: [currentMember],
    leases: [],
    conflicts: [],
    records: [],
    activity: [],
    sessions: [],
    localScans: [],
    settings: {
      autoLockAfterAutoClaim: true,
      blockingProtectionEnabled: true,
      automaticLeaseTtlMinutes: 10,
      maximumExclusiveLeaseMinutes: 240,
      riskPolicyVersion: 1,
      riskRules: [],
    },
    releaseRequests: [],
    server: { mcpUrl: "http://127.0.0.1:4173/mcp" },
    ...overrides,
  };
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("dashboard modal coordination", () => {
  const requests = [
    { id: "request-other", status: "pending", holderMemberId: "member-other" },
    { id: "request-dismissed", status: "pending", holderMemberId: "member-current" },
    { id: "request-next", status: "pending", holderMemberId: "member-current" },
  ] as const;

  it("queues release requests until the current modal closes", () => {
    const dismissed = new Set(["request-dismissed"]);

    expect(nextPendingReleaseRequestId(
      { type: "claim" },
      requests,
      "member-current",
      dismissed,
    )).toBeUndefined();

    expect(nextPendingReleaseRequestId(
      null,
      requests,
      "member-current",
      dismissed,
    )).toBe("request-next");
  });

  it("does not reopen dismissed or already resolved requests", () => {
    expect(nextPendingReleaseRequestId(
      null,
      [
        { id: "request-dismissed", status: "pending", holderMemberId: "member-current" },
        { id: "request-resolved", status: "approved", holderMemberId: "member-current" },
      ],
      "member-current",
      new Set(["request-dismissed"]),
    )).toBeUndefined();
  });
});

describe("lease protection presentation", () => {
  it("uses a strict expiry boundary and renders a second-level countdown", () => {
    expect(isValidLease(lease({ expiresAt: "2026-08-27T08:00:00.001Z" }), LEASE_NOW)).toBe(true);
    expect(isValidLease(lease({ expiresAt: "2026-08-27T08:00:00.000Z" }), LEASE_NOW)).toBe(false);
    expect(isValidLease(lease({ expiresAt: "not-a-date" }), LEASE_NOW)).toBe(false);
    expect(isValidLease(lease({ status: "working" }), LEASE_NOW)).toBe(false);
    expect(formatLeaseExpiryCountdown("2026-08-27T08:01:05.000Z", LEASE_NOW)).toBe("1 分 05 秒后到期");
    expect(formatLeaseExpiryCountdown("2026-08-27T08:01:05.000Z", LEASE_NOW + 1_000)).toBe("1 分 04 秒后到期");
  });

  it("shows only fresh active sessions whose current turn has not stopped", () => {
    expect(isRealtimeAgentSession({
      status: "active",
      lastSeenAt: "2026-08-27T07:55:00.001Z",
    }, LEASE_NOW)).toBe(true);
    expect(isRealtimeAgentSession({
      status: "active",
      lastSeenAt: "2026-08-27T07:55:00.000Z",
    }, LEASE_NOW)).toBe(false);
    expect(isRealtimeAgentSession({
      status: "active",
      lastSeenAt: "2026-08-27T08:00:00.000Z",
      turnStoppedAt: "2026-08-27T08:00:00.000Z",
    }, LEASE_NOW)).toBe(false);
  });

  it("derives protected systems only from valid leases and ignores historical scans", () => {
    const state = dashboard({
      leases: [
        lease({ id: "valid", paths: ["src/client/App.tsx"] }),
        lease({ id: "expired", paths: ["src/server/history.ts"], expiresAt: "2026-08-27T08:00:00.000Z" }),
      ],
      localScans: [{
        id: "historical-scan",
        memberId: "member-current",
        changedPaths: ["Assets/Historical/Old.prefab"],
        systems: ["Historical"],
        ruleFiles: [],
      }],
    });

    const systems = protectedSystemsForDashboard(state, LEASE_NOW);

    expect(systems.map((system) => system.name)).toEqual(["src"]);
    expect([...systems[0].paths]).toEqual(["src/client/App.tsx"]);
  });

  it("keeps valid manual leases in live work and separates automatic commit waiting", () => {
    const awaiting = lease({ id: "awaiting", title: "等待中的自动范围", phase: "awaiting_commit" });
    const standard = lease({ id: "standard", title: "普通手动范围", kind: "standard", phase: "awaiting_commit" });
    const exclusive = lease({ id: "exclusive", title: "独占手动范围", kind: "exclusive", phase: undefined });
    const expired = lease({ id: "expired", title: "已经过期的手动范围", kind: "standard", expiresAt: "2026-08-27T07:59:59.999Z" });
    const groups = splitVisibleLeases([awaiting, standard, exclusive, expired], LEASE_NOW);

    expect(groups.awaitingCommit.map((item) => item.id)).toEqual(["awaiting"]);
    expect(groups.working.map((item) => item.id)).toEqual(["standard", "exclusive"]);

    const markup = renderToStaticMarkup(
      <WorkView
        dashboard={dashboard({
          leases: [awaiting, standard, exclusive, expired],
          sessions: [{
            id: "stopped-session",
            memberId: "member-current",
            status: "active",
            lastSeenAt: "2026-08-27T08:00:00.000Z",
            turnStoppedAt: "2026-08-27T08:00:00.000Z",
            task: "已经停止的实时任务",
          }],
        })}
        transientConflicts={[]}
        now={LEASE_NOW}
        onClaim={() => undefined}
        onRenew={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(markup).toContain("会话已结束，等待提交");
    expect(markup).toContain("等待提交的保护范围");
    expect(markup).toContain("普通手动范围");
    expect(markup).toContain("独占手动范围");
    expect(markup).not.toContain("已经过期的手动范围");
    expect(markup).not.toContain("已经停止的实时任务");
    expect(markup).not.toContain('aria-label="Agent 实时活动"');
  });

  it("does not offer live-session actions for an automatic waiting lease", () => {
    const markup = renderToStaticMarkup(
      <WorkItem
        lease={lease({ phase: "awaiting_commit" })}
        own
        busy={false}
        now={LEASE_NOW}
        onRenew={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(markup).toContain("会话已结束，等待提交");
    expect(markup).toContain("10 分 00 秒后到期");
    expect(markup).not.toContain("完成并释放");
    expect(markup).not.toContain("延长保护时间");
  });
});

describe("entry screen updates", () => {
  it("surfaces pause and remote-cleanup warnings from create or join activation", () => {
    expect(noticeForActivatedConnection({
      pausedConnectionIds: ["connection-old"],
      warnings: ["旧房间离线，远端清理将在稍后重试。"],
    })).toEqual({
      tone: "warning",
      message: "已暂停同一项目的 1 个旧房间连接。 旧房间离线，远端清理将在稍后重试。",
    });
    expect(noticeForActivatedConnection({
      pausedConnectionIds: [],
      warnings: [],
    })).toBeNull();
  });

  it("mounts the desktop update control before a room is opened", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        agentHubDesktop: {},
        location: { origin: "http://127.0.0.1:4173" },
      },
    });

    const markup = renderToStaticMarkup(<EntryScreen onConnected={() => undefined} />);

    expect(markup).toContain("entry-update-control");
    expect(markup).toContain('aria-label="软件更新"');
  });

  it("shows a warning after local exit succeeds but remote cleanup fails", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        agentHubDesktop: {},
        location: { origin: "http://127.0.0.1:4173" },
      },
    });

    const markup = renderToStaticMarkup(
      <EntryScreen
        onConnected={() => undefined}
        initialNotice={{ tone: "warning", message: "房间中的会话或租约未能立即清理。" }}
      />,
    );

    expect(markup).toContain("toast warning");
    expect(markup).toContain("房间中的会话或租约未能立即清理。");
  });

  it("renders the full room history with separate open and delete buttons", () => {
    const connections: SavedRoomConnection[] = Array.from({ length: 4 }, (_, index) => ({
      id: `connection-${index + 1}`,
      serverUrl: `http://127.0.0.1:417${index}`,
      repositoryPath: "D:\\UGit\\projectvanguard",
      roomName: `房间 ${index + 1}`,
      memberName: "本机成员",
      memberRole: "member",
      integrationEnabled: true,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    }));

    const markup = renderToStaticMarkup(
      <SavedConnectionList
        connections={connections}
        deletingConnectionId="connection-2"
        onOpen={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(markup.match(/class="saved-connection-row"/g)).toHaveLength(4);
    expect(markup).toContain("房间 4");
    expect(markup).toContain('aria-label="打开房间 1"');
    expect(markup).toContain('aria-label="从本机移除房间 1"');
    expect(markup.match(/ disabled=""/g)).toHaveLength(2);
    expect(markup).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
  });

  it("makes the local-only scope explicit before deletion", () => {
    const markup = renderToStaticMarkup(
      <DeleteConnectionModal
        connection={{
          id: "connection-a",
          roomName: "先锋协作",
          memberName: "成员 A",
          serverUrl: "http://10.30.25.108:4173",
          repositoryPath: "D:\\UGit\\projectvanguard",
        }}
        busy={false}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(markup).toContain("只从这台电脑移除");
    expect(markup).toContain("不会删除远端房间或团队记录");
    expect(markup).toContain("远端会话或租约可能需要等待");
    expect(markup).toContain("从本机移除");
  });

  it("reports online deletion as complete and offline cleanup as a retry warning", () => {
    const completed = noticeForDeletedConnection({
      deletedConnectionId: "connection-a",
      remoteCleanup: "completed",
      codexConfigChanged: false,
      codexRestartRequired: false,
      warnings: [],
    });
    const offline = noticeForDeletedConnection({
      deletedConnectionId: "connection-b",
      remoteCleanup: "pending",
      codexConfigChanged: true,
      codexRestartRequired: true,
      warnings: [],
    });

    expect(completed).toEqual({
      tone: "success",
      message: "房间已从本机移除，本机保存的成员凭证和接入数据已删除。",
    });
    expect(offline.tone).toBe("warning");
    expect(offline.message).toContain("远端会话或租约可能要等到过期后才会清理");
    expect(offline.message).toContain("请重启 Codex");
  });

  it("keeps the confirmation available and displays a retryable deletion error", () => {
    const markup = renderToStaticMarkup(
      <DeleteConnectionModal
        connection={{
          id: "connection-a",
          roomName: "先锋协作",
          memberName: "成员 A",
          serverUrl: "http://10.30.25.108:4173",
          repositoryPath: "D:\\UGit\\projectvanguard",
        }}
        busy={false}
        error="Codex 配置无法安全写回，请重试。"
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Codex 配置无法安全写回，请重试。");
    expect(markup).toContain("从本机移除");
    expect(markup).not.toContain('disabled=""');
  });

  it("locks every dismissal control while local deletion is running", () => {
    const markup = renderToStaticMarkup(
      <DeleteConnectionModal
        connection={{
          id: "connection-a",
          roomName: "先锋协作",
          memberName: "成员 A",
          serverUrl: "http://10.30.25.108:4173",
          repositoryPath: "D:\\UGit\\projectvanguard",
        }}
        busy
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(markup).toContain("正在移除");
    expect(markup.match(/ disabled=""/g)).toHaveLength(3);
  });
});
