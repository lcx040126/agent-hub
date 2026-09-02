import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeleteConnectionModal,
  DecisionHistory,
  EntryScreen,
  ConflictList,
  ManagementView,
  RecordModal,
  RecordsView,
  SavedConnectionList,
  RoomRecoveryPanel,
  WorkItem,
  WorkView,
  StatusSummary,
  classifyDashboardRefreshFailure,
  dashboardPartialRefreshMessage,
  dashboardSyncStateForPartialSections,
  dashboardClockOffsetMs,
  decisionReplacementConflictRecovery,
  decisionHistoryStateFor,
  formatLeaseExpiryCountdown,
  isRealtimeAgentSession,
  isCurrentDecision,
  isValidLease,
  nextPendingReleaseRequestId,
  noticeForActivatedConnection,
  noticeForDeletedConnection,
  monitorModeUpgradeGuidance,
  protectedSystemsForDashboard,
  recoveryCountdown,
  roomRecoveryGuidance,
  roomSettingsErrorMessage,
  ScopeEventRow,
  shortIdentifier,
  splitVisibleLeases,
  visibleProjectRecords,
} from "./App";
import { ApiError, type Conflict, type Dashboard, type Lease, type ProjectRecord, type SavedRoomConnection, type Session } from "./api";

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
    managedBy: "agent",
    createdVia: "legacy",
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

function projectRecord(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "decision-current",
    kind: "decision",
    title: "当前背包规则",
    summary: "背包满时将奖励发往邮箱。",
    memberName: "成员 B",
    paths: ["src/inventory"],
    status: "current",
    evidence: "避免奖励丢失。",
    createdAt: "2026-08-29T08:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("decision replacement presentation", () => {
  it("closes a stale replacement modal and warns after a concurrent replacement", () => {
    const conflict = new ApiError(
      "already superseded",
      409,
      "decision_already_superseded",
      { currentDecisionId: "decision-current" },
    );
    expect(decisionReplacementConflictRecovery(conflict, true)).toEqual({
      closeModal: true,
      notice: {
        tone: "warning",
        message: "这条决定已被其他成员更新。当前决定已刷新，请基于最新决定重新操作。",
      },
    });
    expect(decisionReplacementConflictRecovery(conflict, false)?.notice.message).toBe(
      "这条决定已被其他成员更新，但当前决定刷新失败。请恢复连接并刷新后再操作。",
    );
    expect(decisionReplacementConflictRecovery(new ApiError("offline", 0), false)).toBeNull();
  });

  it("hides superseded decisions from the default list and count while keeping legacy accepted decisions current", () => {
    const oldDecision = projectRecord({
      id: "decision-old",
      title: "旧背包规则",
      status: "superseded",
      createdAt: "2026-08-27T08:00:00.000Z",
    });
    const currentDecision = projectRecord({
      supersedesDecisionId: oldDecision.id,
    });
    const legacyDecision = projectRecord({
      id: "decision-legacy",
      title: "旧版仍有效决定",
      status: "accepted",
    });
    const records = [currentDecision, oldDecision, legacyDecision];

    expect(isCurrentDecision(oldDecision)).toBe(false);
    expect(isCurrentDecision(legacyDecision)).toBe(true);
    expect(visibleProjectRecords(records).map((record) => record.id)).toEqual([
      "decision-current",
      "decision-legacy",
    ]);

    const markup = renderToStaticMarkup(
      <RecordsView
        dashboard={dashboard({ records })}
        onAdd={() => undefined}
        onReplaceDecision={() => undefined}
      />,
    );
    expect(markup).toContain("<b>2</b> 项决定");
    expect(markup).toContain("当前背包规则");
    expect(markup).toContain("旧版仍有效决定");
    expect(markup).not.toContain("旧背包规则");
    expect(markup).toContain("查看历史");
    expect(markup.match(/更新决定/g)).toHaveLength(2);
  });

  it("builds newest-to-oldest history and stops at missing links or cycles", () => {
    const oldest = projectRecord({ id: "decision-a", status: "superseded", title: "第一版" });
    const previous = projectRecord({
      id: "decision-b",
      status: "superseded",
      title: "第二版",
      supersedesDecisionId: oldest.id,
    });
    const current = projectRecord({
      id: "decision-c",
      title: "第三版",
      supersedesDecisionId: previous.id,
    });

    const historyState = decisionHistoryStateFor([oldest, previous, current], current.id);
    const history = historyState.records;
    expect(history.map((record) => record.id)).toEqual(["decision-c", "decision-b", "decision-a"]);
    expect(historyState.incomplete).toBe(false);

    const missingHistoryState = decisionHistoryStateFor([current], current.id);
    expect(missingHistoryState.records.map((record) => record.id)).toEqual(["decision-c"]);
    expect(missingHistoryState.incomplete).toBe(true);

    const cycleA = projectRecord({ id: "cycle-a", supersedesDecisionId: "cycle-b" });
    const cycleB = projectRecord({ id: "cycle-b", status: "superseded", supersedesDecisionId: "cycle-a" });
    const cycleHistoryState = decisionHistoryStateFor([cycleA, cycleB], cycleA.id);
    expect(cycleHistoryState.records.map((record) => record.id)).toEqual([
      "cycle-a",
      "cycle-b",
    ]);
    expect(cycleHistoryState.incomplete).toBe(false);

    const markup = renderToStaticMarkup(<DecisionHistory records={history} incomplete={historyState.incomplete} />);
    expect(markup.indexOf("第三版")).toBeLessThan(markup.indexOf("第二版"));
    expect(markup.indexOf("第二版")).toBeLessThan(markup.indexOf("第一版"));
    expect(markup).toContain("当前决定");
    expect(markup.match(/已替代/g)).toHaveLength(2);
    expect(markup).not.toContain("更早决定未包含在当前刷新结果中。");

    const incompleteMarkup = renderToStaticMarkup(
      <DecisionHistory records={missingHistoryState.records} incomplete={missingHistoryState.incomplete} />,
    );
    expect(incompleteMarkup).toContain("更早决定未包含在当前刷新结果中。");
  });

  it("prefills replacement fields and requires a new rationale", () => {
    const markup = renderToStaticMarkup(
      <RecordModal
        kind="decision"
        leases={[]}
        members={[]}
        supersedesDecision={projectRecord()}
        onClose={() => undefined}
        onSubmit={async () => undefined}
      />,
    );

    expect(markup).toContain("更新团队决定");
    expect(markup).toContain('value="当前背包规则"');
    expect(markup).toContain("背包满时将奖励发往邮箱。");
    expect(markup).toContain("src/inventory");
    expect(markup).toMatch(/判断依据<\/span><textarea required=""/);
    expect(markup).toContain("保存更新");
  });
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

describe("dashboard refresh state", () => {
  it("separates transport failures, expired credentials, and stale dashboard data", () => {
    expect(classifyDashboardRefreshFailure(new ApiError("无法连接", 0))).toBe("offline");
    expect(classifyDashboardRefreshFailure(new Error("无法连接房主服务，请确认房主电脑在线。"))).toBe("offline");
    expect(classifyDashboardRefreshFailure(new ApiError("成员凭证已失效", 401))).toBe("unauthorized");
    expect(classifyDashboardRefreshFailure(new Error("The room server response is too large."))).toBe("refresh_failed");
    expect(classifyDashboardRefreshFailure(new Error("The room server returned invalid JSON."))).toBe("refresh_failed");
    expect(classifyDashboardRefreshFailure(new ApiError("服务内部错误", 500))).toBe("refresh_failed");
  });

  it("labels stale data as a refresh failure without claiming the room disconnected", () => {
    const markup = renderToStaticMarkup(
      <StatusSummary dashboard={dashboard()} syncState="refresh_failed" now={LEASE_NOW} />,
    );

    expect(markup).toContain("团队数据暂未刷新");
    expect(markup).toContain("房间未被判定为断开");
    expect(markup).not.toContain("正在重新连接房间");
  });

  it("reports budgeted dashboard sections as partial data while keeping the room online", () => {
    expect(dashboardPartialRefreshMessage(["records", "activity", "records"])).toBe(
      "房间仍在线，但项目记录、动态达到轮询展示上限；完整内容仍保留在房间数据库和专用查询中。",
    );
    expect(dashboardSyncStateForPartialSections(["activity", "records"])).toBe("online");
    expect(dashboardSyncStateForPartialSections(["activity", "leases"])).toBe("partial");

    const markup = renderToStaticMarkup(
      <StatusSummary dashboard={dashboard()} syncState="partial" now={LEASE_NOW} />,
    );
    expect(markup).toContain("团队状态部分展示");
    expect(markup).toContain("房间保持在线");
    expect(markup).not.toContain("团队数据暂未刷新");
    expect(markup).not.toContain("正在重新连接房间");
  });
});

describe("risk presentation semantics", () => {
  const redWarning: Conflict = {
    id: "red-warning",
    title: "重点文件重叠",
    summary: "该范围是高风险，但服务端允许继续。",
    severity: "blocking",
    decision: "warn",
    paths: ["ProjectSettings/ProjectSettings.asset"],
    memberNames: ["成员 B"],
  };
  const yellowDenial: Conflict = {
    id: "yellow-denial",
    title: "明确拒绝",
    summary: "颜色普通，但服务端明确拒绝。",
    severity: "warning",
    decision: "deny",
    paths: ["src/shared.ts"],
    memberNames: ["成员 C"],
  };

  it("uses severity for color and decision=deny alone for blocked labels and counts", () => {
    const listMarkup = renderToStaticMarkup(<ConflictList conflicts={[redWarning, yellowDenial]} />);
    expect(listMarkup).toContain("conflict-item blocking");
    expect(listMarkup).toContain("高风险警告");
    expect(listMarkup).toContain("conflict-item warning");
    expect(listMarkup).toContain("已阻止");

    const summaryMarkup = renderToStaticMarkup(
      <StatusSummary
        dashboard={dashboard({ conflicts: [redWarning, yellowDenial] })}
        syncState="online"
        now={LEASE_NOW}
      />,
    );
    expect(summaryMarkup).toContain("1 项阻塞尚未解决");
    expect(summaryMarkup).toContain("<b>1</b> 阻塞");
  });

  it("describes pure monitoring and names members that must upgrade before switching", () => {
    const owner: Dashboard["currentMember"] = {
      id: "owner",
      name: "房主",
      role: "host",
      status: "online",
      compatibility: "compatible",
      protocolVersion: 2,
    };
    const state = dashboard({
      currentMember: owner,
      members: [
        owner,
        { id: "old", name: "旧客户端", role: "member", status: "online", compatibility: "incompatible", clientVersion: "0.2.5", protocolVersion: 1 },
        { id: "unknown", name: "未上报成员", role: "member", status: "away", compatibility: "unknown", protocolVersion: undefined },
      ],
      settings: {
        ...dashboard().settings,
        riskRules: [{ kind: "category", selector: "normal_source", level: "blocking" }],
      },
    });
    const session: Session = { room: state.room, member: owner, memberToken: "owner-token" };
    const markup = renderToStaticMarkup(
      <ManagementView
        dashboard={state}
        session={session}
        onRefresh={async () => undefined}
        onNotice={() => undefined}
      />,
    );

    expect(markup).toContain("自动与普通范围进入纯监测");
    expect(markup).toContain("红色高风险警告都只记录");
    expect(markup).toContain("红色高风险");
    expect(markup).toContain("切换前需要成员升级");
    expect(markup).toContain("旧客户端（v0.2.5）");
    expect(markup).toContain("未上报成员（未上报版本）");
    expect(monitorModeUpgradeGuidance(state.members)).toContain("协议 2");
  });

  it("uses preserved server details in the monitor-mode upgrade error", () => {
    const message = roomSettingsErrorMessage(new ApiError(
      "升级后再试。",
      409,
      "monitor_mode_upgrade_required",
      {
        requiredProtocolVersion: 2,
        members: [
          { displayName: "成员 B", clientVersion: "0.2.5", protocolVersion: 1 },
          { displayName: "成员 C", clientVersion: null, protocolVersion: null },
        ],
      },
    ));
    expect(message).toContain("成员 B（v0.2.5）");
    expect(message).toContain("成员 C（未上报版本）");
    expect(message).toContain("协议 2");
    expect(message).toContain("服务已拒绝本次切换");
  });
});

describe("lease protection presentation", () => {
  it("uses server-relative time when the member clock is ahead and falls back for older servers", () => {
    const memberClock = Date.parse("2026-08-27T10:00:00.000Z");
    const offset = dashboardClockOffsetMs("2026-08-27T08:00:00.000Z", memberClock);
    const serverRelativeNow = memberClock + offset;

    expect(offset).toBe(-2 * 60 * 60_000);
    expect(isValidLease(lease({ expiresAt: "2026-08-27T08:01:00.000Z" }), serverRelativeNow)).toBe(true);
    expect(formatLeaseExpiryCountdown("2026-08-27T08:01:00.000Z", serverRelativeNow)).toBe("1 分 00 秒后到期");
    expect(dashboardClockOffsetMs(undefined, memberClock)).toBe(0);
    expect(dashboardClockOffsetMs("not-a-date", memberClock)).toBe(0);
  });

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

  it("shortens long identifiers to the first eight and last four characters", () => {
    expect(shortIdentifier("codex-session-abcdefgh")).toBe("codex-se…efgh");
    expect(shortIdentifier("short-id")).toBe("short-id");
    expect(shortIdentifier()).toBe("");
  });

  it("shows a scope event source and preserves long wrapping diagnostics", () => {
    const diagnostic = "Join-Path could not be proven because every parameter depends on a runtime-only variable/with/an/intentionally/long/value.";
    const markup = renderToStaticMarkup(<ScopeEventRow event={{
      id: "scope-event-source",
      type: "lease.scope_observed",
      title: "Observed scope",
      createdAt: "2026-08-29T02:00:00.000Z",
      metadata: {
        invocationId: "invocation-source",
        source: "hook",
        toolName: "Bash",
        stage: "pre",
        turnId: "turn-source",
        requestedPaths: [],
        coveredPaths: [],
        addedPaths: [],
        ignoredPaths: [],
        actualPaths: [],
        pathDiagnostics: [diagnostic],
      },
    }} />);

    expect(markup).toContain("来源 Hook");
    expect(markup).toContain('aria-label="路径诊断"');
    expect(markup).toContain(diagnostic);
    expect(markup).toContain('class="scope-event-diagnostics"');
  });

  it("shows linked session identifiers, copy actions, epoch, and acquisition source on work cards", () => {
    const markup = renderToStaticMarkup(
      <WorkItem
        lease={lease({
          sessionId: "hub-session-1234567890",
          managedBy: "agent",
          createdVia: "mcp",
        })}
        agentSession={{
          id: "hub-session-1234567890",
          memberId: "member-current",
          codexSessionId: "codex-session-abcdefgh",
          currentTurnId: "turn-1234567890",
          activityEpoch: 7,
          status: "active",
        }}
        own
        busy={false}
        now={LEASE_NOW}
        onRenew={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(markup).toContain("codex-se…efgh");
    expect(markup).toContain("hub-sess…7890");
    expect(markup).toContain("turn-123…7890");
    expect(markup).toContain('aria-label="复制Codex Session ID"');
    expect(markup).toContain('aria-label="复制Hub Session ID"');
    expect(markup).toContain('aria-label="复制当前 Turn ID"');
    expect(markup).toContain("activityEpoch");
    expect(markup).toContain(">7</code>");
    expect(markup).toContain("MCP");
  });

  it("keeps manual work unassociated even when a legacy response contains a session id", () => {
    const markup = renderToStaticMarkup(
      <WorkItem
        lease={lease({
          sessionId: "legacy-session-id",
          kind: "standard",
          managedBy: "manual",
          createdVia: "ui",
        })}
        agentSession={{
          id: "legacy-session-id",
          memberId: "member-current",
          codexSessionId: "must-not-display",
          currentTurnId: "must-not-display",
          activityEpoch: 9,
          status: "active",
        }}
        own
        busy={false}
        now={LEASE_NOW}
        onRenew={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(markup.match(/未关联/g)?.length).toBeGreaterThanOrEqual(4);
    expect(markup).not.toContain("must-not-display");
    expect(markup).not.toContain('aria-label="复制Hub Session ID"');
    expect(markup).toContain('aria-label="历史调用归因"');
    expect(markup).not.toContain("人工任务没有 Agent 调用记录");
  });

  it("binds work cards by Hub Session ID and keeps standalone live rows free of identifiers", () => {
    const markup = renderToStaticMarkup(
      <WorkView
        dashboard={dashboard({
          leases: [lease({ sessionId: "hub-bound-session", createdVia: "hook" })],
          sessions: [
            {
              id: "hub-bound-session",
              memberId: "member-current",
              codexSessionId: "codex-bound-session",
              currentTurnId: "turn-bound-session",
              activityEpoch: 3,
              status: "active",
              lastSeenAt: "2026-08-27T08:00:00.000Z",
              task: "不应重复显示的会话行",
            },
            {
              id: "hub-standalone-session",
              memberId: "member-current",
              codexSessionId: "codex-standalone-session",
              currentTurnId: "turn-standalone-session",
              activityEpoch: 1,
              status: "active",
              lastSeenAt: "2026-08-27T08:00:00.000Z",
              task: "保留的独立会话行",
            },
          ],
        })}
        transientConflicts={[]}
        now={LEASE_NOW}
        onClaim={() => undefined}
        onRenew={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(markup).toContain("codex-bo…sion");
    expect(markup).not.toContain("不应重复显示的会话行");
    expect(markup).toContain("保留的独立会话行");
    expect(markup).not.toContain("hub-standalone-session");
    expect(markup).not.toContain("codex-standalone-session");
    expect(markup).not.toContain("turn-standalone-session");
  });

  it("hides the generated Codex session task until the session has a lease", () => {
    const codexSessionId = "01a0469b-8192-7082-8fc7-c8a37e5ea76e";
    const markup = renderToStaticMarkup(
      <WorkView
        dashboard={dashboard({
          sessions: [{
            id: "hub-unclaimed-session",
            memberId: "member-current",
            codexSessionId,
            currentTurnId: "turn-unclaimed-session",
            activityEpoch: 3,
            status: "active",
            lastSeenAt: "2026-08-27T08:00:00.000Z",
            task: `Codex session ${codexSessionId}`,
            agentName: "Codex",
            branch: "dev",
          }],
        })}
        transientConflicts={[]}
        now={LEASE_NOW}
        onClaim={() => undefined}
        onRenew={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(markup).toContain("Codex · dev · Epoch 3");
    expect(markup).not.toContain(codexSessionId);
    expect(markup).not.toContain("hub-unclaimed-session");
    expect(markup).not.toContain("turn-unclaimed-session");
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

  it("renders actionable remote cleanup recovery without a force-enter action", () => {
    const recovery = {
      status: "waiting-cleanup" as const,
      connectionId: "connection-a",
      serverUrl: "http://10.20.16.139:4173",
      phase: "remote-cleanup" as const,
      attempts: 7,
      nextAttemptAt: "2026-09-02T08:00:30.000Z",
      lastError: "Agent Hub did not respond within 10000 ms.",
      failureKind: "timeout" as const,
      retryable: true,
    };
    const markup = renderToStaticMarkup(
      <RoomRecoveryPanel recovery={recovery} retrying={false} onRetry={() => undefined} />,
    );

    expect(markup).toContain("正在等待远程清理");
    expect(markup).toContain("http://10.20.16.139:4173");
    expect(markup).toContain("已重试 7 次");
    expect(markup).toContain("立即重试");
    expect(markup).toContain("房主已启动 Agent Hub");
    expect(markup).not.toContain("强制进入");
  });

  it("gives terminal recovery guidance and hides retry for a dissolved room", () => {
    const recovery = {
      status: "waiting-cleanup" as const,
      connectionId: "connection-a",
      serverUrl: "http://10.20.16.139:4173",
      phase: "remote-cleanup" as const,
      attempts: 2,
      failureKind: "room_dissolved" as const,
      retryable: false,
    };
    const markup = renderToStaticMarkup(
      <RoomRecoveryPanel recovery={recovery} retrying={false} onRetry={() => undefined} />,
    );

    expect(roomRecoveryGuidance(recovery)).toContain("从本机移除");
    expect(markup).not.toContain("立即重试");
    expect(recoveryCountdown("2026-09-02T08:00:05.000Z", Date.parse("2026-09-02T08:00:00.000Z")))
      .toBe("5 秒后重试");
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
