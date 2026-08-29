export type Room = {
  id: string;
  name: string;
  code?: string;
  projectName: string;
  repository: string;
  defaultBranch: string;
  createdAt?: string;
  status?: "active" | "dissolved";
  autoLockAfterAutoClaim?: boolean;
};

export type Member = {
  id: string;
  name: string;
  role: "host" | "member" | "viewer" | string;
  isAdmin?: boolean;
  removedAt?: string;
  status: "online" | "away" | "offline";
  agent?: string;
  lastSeenAt?: string;
  joinedAt?: string;
  clientVersion?: string;
  protocolVersion?: number;
  schemaVersion?: number;
  compatibility: "compatible" | "incompatible" | "unknown";
};

export type RiskRule = {
  id?: string;
  kind: "category" | "extension" | "file" | "directory";
  selector: string;
  level: "warning" | "blocking";
};

export type RoomSettings = {
  autoLockAfterAutoClaim: boolean;
  blockingProtectionEnabled: boolean;
  automaticLeaseTtlMinutes: 5 | 10 | 15 | 30 | 60;
  maximumExclusiveLeaseMinutes: number;
  riskPolicyVersion: number;
  riskRules: RiskRule[];
  updatedAt?: string;
  updatedBy?: string;
};

export type Lease = {
  id: string;
  sessionId?: string;
  title: string;
  objective?: string;
  memberId?: string;
  memberName: string;
  branch?: string;
  baseCommit?: string;
  paths: string[];
  highRiskPaths: string[];
  mode: "write" | "read";
  kind: "automatic" | "standard" | "exclusive";
  managedBy: "manual" | "agent";
  createdVia: "ui" | "mcp" | "hook" | "legacy";
  phase?: "working" | "waiting" | "blocked" | "awaiting_commit";
  status: string;
  createdAt?: string;
  expiresAt?: string;
  updatedAt?: string;
  completionSummary?: string;
};

export type Conflict = {
  id: string;
  title: string;
  summary: string;
  severity: "blocking" | "warning" | "notice";
  decision: "allow" | "warn" | "deny";
  paths: string[];
  memberNames: string[];
  leaseId?: string;
  createdAt?: string;
  status?: string;
};

export type RecordKind = "decision" | "validation" | "handoff" | "risk" | "context";

export type ProjectRecord = {
  id: string;
  kind: RecordKind;
  title: string;
  summary: string;
  memberName?: string;
  paths: string[];
  status?: string;
  evidence?: string;
  command?: string;
  commitHash?: string;
  createdAt?: string;
  details?: string[];
};

export type ActivityItem = {
  id: string;
  type?: string;
  title: string;
  summary?: string;
  memberName?: string;
  createdAt?: string;
};

export type AgentSession = {
  id: string;
  memberId: string;
  codexSessionId?: string;
  currentTurnId?: string;
  activityEpoch?: number;
  clientName?: string;
  agentName?: string;
  task?: string;
  branch?: string;
  baseCommit?: string;
  status: string;
  lastSeenAt?: string;
  turnStoppedAt?: string;
  clientVersion?: string;
  protocolVersion?: number;
  schemaVersion?: number;
};

export type LeaseScopeEventMetadata = {
  invocationId?: string;
  source?: "ui" | "mcp" | "hook" | "legacy";
  toolName?: string;
  stage?: "pre" | "post";
  turnId?: string;
  requestedPaths: string[];
  coveredPaths: string[];
  addedPaths: string[];
  ignoredPaths: string[];
  actualPaths: string[];
  pathDiagnostics: string[];
};

export type LeaseScopeEvent = {
  id: string;
  type: string;
  actorName?: string;
  memberName?: string;
  title: string;
  summary?: string;
  metadata: LeaseScopeEventMetadata;
  createdAt?: string;
};

export type LeaseScopeEventPage = {
  items: LeaseScopeEvent[];
  nextBefore?: string;
};

export type ReleaseRequest = {
  id: string;
  requesterMemberId: string;
  requesterName: string;
  requesterSessionId?: string;
  requesterLeaseId?: string;
  holderMemberId: string;
  holderName: string;
  conflictingLeaseId: string;
  conflictingLeaseTitle: string;
  conflictingLeaseKind: "automatic" | "standard" | "exclusive";
  requestTitle: string;
  requestObjective?: string;
  requestedKind: "automatic" | "standard" | "exclusive";
  requestedMode: "read" | "write";
  requestedPaths: string[];
  overlapPaths: Array<{ requestedPath: string; existingPath: string }>;
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  rejectionReason?: string;
  transferredLeaseId?: string;
  occurrenceCount: number;
  requestedAt: string;
  lastRequestedAt: string;
  resolvedAt?: string;
  holderLeaseExpiresAt: string;
};

export type LocalScan = {
  id: string;
  sessionId?: string;
  memberId: string;
  changedPaths: string[];
  systems: string[];
  ruleFiles: string[];
  scannedAt?: string;
};

export type Dashboard = {
  room: Room;
  currentMember: Member;
  members: Member[];
  leases: Lease[];
  conflicts: Conflict[];
  records: ProjectRecord[];
  activity: ActivityItem[];
  sessions: AgentSession[];
  localScans: LocalScan[];
  settings: RoomSettings;
  releaseRequests: ReleaseRequest[];
  partialSections?: string[];
  sectionTotals?: Record<string, number>;
  generatedAt?: string;
  server: { mcpUrl: string };
};

export type Session = {
  memberToken?: string;
  connectionId?: string;
  serverUrl?: string;
  inviteServerUrl?: string;
  repositoryPath?: string;
  roomToken?: string;
  integrationEnabled?: boolean;
  room: Room;
  member: Member;
};

export type SavedRoomConnection = {
  id: string;
  serverUrl: string;
  repositoryPath: string;
  roomId?: string;
  roomName?: string;
  memberName?: string;
  memberRole?: "host" | "member";
  integrationEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ActivateRoomConnectionResult = {
  connection: SavedRoomConnection;
  pausedConnectionIds: string[];
  warnings: string[];
};

export type SecureDesktopSessionResult = {
  session: Session;
  activation: ActivateRoomConnectionResult | null;
};

export type DeleteRoomConnectionResult = {
  deletedConnectionId: string;
  remoteCleanup: "completed" | "pending" | "skipped";
  codexConfigChanged: boolean;
  codexRestartRequired: boolean;
  warnings: string[];
};

type RepositorySnapshot = {
  repository: {
    root: string;
    name: string;
    remote: string | null;
    branch: string;
    headCommit: string;
    fingerprint: string;
  };
};

type RoomServerRequest =
  | { serverUrl: string; method: "GET" | "POST"; path: string; body?: unknown }
  | { connectionId: string; method: "GET" | "POST"; path: string; body?: unknown };

type DesktopApi = {
  chooseRepository(): Promise<string | null>;
  inspectRepository(repositoryPath: string): Promise<RepositorySnapshot>;
  getServerInfo(): Promise<DesktopServerInfo>;
  saveRoomConnection(input: {
    id?: string;
    serverUrl: string;
    memberToken: string;
    repositoryPath: string;
    roomId?: string;
    roomName?: string;
    memberName?: string;
    memberRole?: "host" | "member";
    integrationEnabled?: boolean;
  }): Promise<ActivateRoomConnectionResult>;
  listRoomConnections(): Promise<SavedRoomConnection[]>;
  pauseRoomConnection(connectionId: string): Promise<{
    connection: SavedRoomConnection;
    queued: boolean;
    requestId: string;
    cleanupError?: string;
    localRoomServerStopped: boolean;
  }>;
  activateRoomConnection(connectionId: string): Promise<ActivateRoomConnectionResult>;
  deleteRoomConnection(connectionId: string): Promise<DeleteRoomConnectionResult>;
  requestRoomServer(input: RoomServerRequest): Promise<{ status: number; body: unknown }>;
  installCodexIntegration(connectionId: string): Promise<{
    configPath: string;
    mcpServerName: string;
    restartRequired: boolean;
  }>;
  getDesktopUpdateStatus(): Promise<DesktopUpdateStatus>;
  checkDesktopUpdate(): Promise<DesktopUpdateStatus>;
  downloadDesktopUpdate(): Promise<DesktopUpdateStatus>;
  installDesktopUpdate(): Promise<DesktopUpdateStatus>;
  onDesktopUpdateStatus(listener: (status: DesktopUpdateStatus) => void): () => void;
};

export type DesktopServerInfo = {
  localServerUrl: string;
  lanUrls: string[];
  port: number;
  appVersion: string;
  protocolVersion: number;
  schemaVersion: number;
};

export type DesktopUpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "failed";

export type DesktopUpdateStatus = {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  publishedAt?: string;
  notes?: string;
  sizeBytes?: number;
  progressPercent?: number;
  transferredBytes?: number;
  bytesPerSecond?: number;
  checkedAt?: string;
  error?: string;
  canRetry: boolean;
};

declare global {
  interface Window {
    agentHubDesktop?: DesktopApi;
  }
}

export type CreateRoomInput = {
  roomName: string;
  projectName: string;
  repository: string;
  defaultBranch: string;
  ownerName: string;
  agent?: string;
};

export type JoinRoomInput = {
  serverUrl: string;
  roomToken: string;
  memberName: string;
  agent?: string;
};

export type CreateLeaseInput = {
  title: string;
  objective?: string;
  branch?: string;
  baseCommit?: string;
  paths: string[];
  ttlMinutes: number;
  kind?: "standard" | "exclusive";
};

export type CloseLeaseInput = {
  outcome: string;
  changedPaths?: string[];
  commitHash?: string;
  validations?: string[];
  remainingRisks?: string[];
  handoff?: string;
};

export type CreateRecordInput = {
  kind: Exclude<RecordKind, "context">;
  title: string;
  summary: string;
  paths?: string[];
  status?: string;
  evidence?: string;
  command?: string;
  leaseId?: string;
  toMemberId?: string;
  completed?: string[];
  remaining?: string[];
  risks?: string[];
};

export type LeaseDecision = {
  acquired: boolean;
  lease?: Lease;
  coverage: LeaseCoverage[];
  conflicts: Conflict[];
  decision: "allow" | "warn" | "deny" | "wait";
  releaseRequests: ReleaseRequest[];
  waitingFor?: {
    leaseId: string;
    sessionId?: string;
    title: string;
    memberName: string;
    expiresAt: string;
    paths: string[];
  };
};

export type LeaseCoverage = {
  leaseId: string;
  managedBy: "manual" | "agent";
  paths: string[];
  action: "covered" | "added";
};

const SESSION_POINTER_KEY = "agent-hub.session.public.v3";
const SESSION_RUNTIME_KEY = "agent-hub.session.runtime.v1";
const LEGACY_SESSION_KEYS = ["agent-hub.session.v2", "agent-hub.session.v1"];

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function firstArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function pathValues(value: unknown): { paths: string[]; highRiskPaths: string[] } {
  if (!Array.isArray(value)) return { paths: [], highRiskPaths: [] };
  const paths: string[] = [];
  const highRiskPaths: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      paths.push(item);
      continue;
    }
    const entry = asObject(item);
    const path = asString(entry.path);
    if (!path) continue;
    paths.push(path);
    if (entry.risk === "high") highRiskPaths.push(path);
  }
  return { paths, highRiskPaths };
}

function statusFromLastSeen(value: unknown): Member["status"] {
  const explicit = asString(value);
  if (["online", "away", "offline"].includes(explicit)) return explicit as Member["status"];
  return "offline";
}

function normalizeRoom(value: unknown, roomToken?: string): Room {
  const room = asObject(value);
  const name = asString(room.name, asString(room.roomName, "未命名房间"));
  return {
    id: asString(room.id),
    name,
    code: asString(room.code, asString(room.inviteCode, roomToken)) || undefined,
    projectName: asString(room.projectName, asString(room.project, name)),
    repository: asString(room.repository, asString(room.repositoryUrl)),
    defaultBranch: asString(room.defaultBranch, "main"),
    createdAt: asString(room.createdAt) || undefined,
    status: asString(room.status, "active") as Room["status"],
    autoLockAfterAutoClaim: room.autoLockAfterAutoClaim !== false,
  };
}

function normalizeMember(value: unknown): Member {
  const member = asObject(value);
  const lastSeenAt = asString(member.lastSeenAt) || undefined;
  let status = statusFromLastSeen(member.status);
  if (!member.status && lastSeenAt) {
    const age = Date.now() - new Date(lastSeenAt).getTime();
    status = age < 120_000 ? "online" : age < 600_000 ? "away" : "offline";
  }
  const rawRole = asString(member.role, "member");
  return {
    id: asString(member.id),
    name: asString(member.name, asString(member.displayName, "未知成员")),
    role: rawRole === "owner" ? "host" : rawRole,
    isAdmin: member.isAdmin === true || rawRole === "admin",
    status,
    agent: asString(member.agent, asString(member.clientName)) || undefined,
    lastSeenAt,
    joinedAt: asString(member.joinedAt, asString(member.createdAt)) || undefined,
    clientVersion: asString(member.clientVersion) || undefined,
    protocolVersion: typeof member.protocolVersion === "number" ? member.protocolVersion : undefined,
    schemaVersion: typeof member.schemaVersion === "number" ? member.schemaVersion : undefined,
    compatibility: ["compatible", "incompatible", "unknown"].includes(asString(member.compatibility))
      ? asString(member.compatibility) as Member["compatibility"]
      : "unknown",
  };
}

function normalizeLease(value: unknown): Lease {
  const lease = asObject(value);
  const member = asObject(lease.member);
  const normalizedPaths = pathValues(lease.paths);
  const detailedPaths = pathValues(lease.pathDetails);
  const phase = asString(lease.phase);
  const kind = ["automatic", "standard", "exclusive"].includes(asString(lease.kind))
    ? asString(lease.kind) as Lease["kind"]
    : "standard";
  const managedBy = asString(lease.managedBy, asString(lease.managed_by));
  const createdVia = asString(lease.createdVia, asString(lease.created_via));
  return {
    id: asString(lease.id),
    sessionId: asString(lease.sessionId, asString(lease.session_id)) || undefined,
    title: asString(lease.title, "未命名工作"),
    objective: asString(lease.objective, asString(lease.intent, asString(lease.description))) || undefined,
    memberId: asString(lease.memberId, asString(member.id)) || undefined,
    memberName: asString(lease.memberName, asString(member.name, "未知成员")),
    branch: asString(lease.branch) || undefined,
    baseCommit: asString(lease.baseCommit) || undefined,
    paths: normalizedPaths.paths,
    highRiskPaths: [...new Set([
      ...normalizedPaths.highRiskPaths,
      ...detailedPaths.highRiskPaths,
      ...asStringArray(lease.highRiskPaths),
    ])],
    mode: lease.mode === "read" ? "read" : "write",
    kind,
    // schema 5 及更早的响应没有来源字段；automatic 是唯一可安全识别的 Agent 托管信号。
    managedBy: ["manual", "agent"].includes(managedBy)
      ? managedBy as Lease["managedBy"]
      : kind === "automatic" ? "agent" : "manual",
    createdVia: ["ui", "mcp", "hook", "legacy"].includes(createdVia)
      ? createdVia as Lease["createdVia"]
      : "legacy",
    phase: ["working", "waiting", "blocked", "awaiting_commit"].includes(phase)
      ? phase as Lease["phase"]
      : "working",
    status: asString(lease.status, "active"),
    createdAt: asString(lease.createdAt) || undefined,
    updatedAt: asString(lease.updatedAt) || undefined,
    expiresAt: asString(lease.expiresAt) || undefined,
    completionSummary: asString(lease.completionSummary) || undefined,
  };
}

function normalizeConflict(value: unknown, index = 0): Conflict {
  const conflict = asObject(value);
  const requestedPath = asString(conflict.requestedPath);
  const existingPath = asString(conflict.existingPath, asString(conflict.conflictingPath));
  const paths = asStringArray(conflict.paths);
  if (requestedPath) paths.push(requestedPath);
  if (existingPath && !paths.includes(existingPath)) paths.push(existingPath);
  const rawSeverity = asString(conflict.severity, "warning");
  const severity: Conflict["severity"] = ["blocking", "critical", "high"].includes(rawSeverity)
    ? "blocking"
    : ["notice", "low"].includes(rawSeverity)
      ? "notice"
      : "warning";
  // severity 只负责黄/红展示；服务端没有明确返回 deny 时，客户端不能自行升级为阻断。
  const rawDecision = asString(conflict.decision, "warn");
  const memberName = asString(conflict.memberName);
  const rawTitle = asString(conflict.title);
  const rawSummary = asString(conflict.summary, asString(conflict.reason, asString(conflict.description)));
  const title = rawTitle === "Exclusive scope overlap"
    ? "独占范围已被占用"
    : rawTitle === "Critical scope risk"
      ? "检测到高风险范围重叠"
      : rawTitle === "Registered scope overlap"
        ? "检测到工作范围重叠"
        : rawTitle;
  const summary = rawSummary === "The overlap includes a Unity, configuration, or Luban scope that requires exclusive access."
    ? "重叠范围包含 Unity 资源、配置或 Luban 数据，必须独占修改。"
    : rawSummary === "Ordinary source write scopes overlap; provide an explicit override reason to continue."
      ? "普通代码写入范围重叠，需要明确说明后才能继续。"
      : rawSummary;
  return {
    id: asString(conflict.id, `${asString(conflict.leaseId, "conflict")}-${index}`),
    title: title || (severity === "blocking" ? "工作范围被占用" : "检测到范围重叠"),
    summary: summary || "多个进行中的工作涉及相同或相交的范围。",
    severity,
    decision: ["allow", "warn", "deny"].includes(rawDecision)
      ? (rawDecision as Conflict["decision"])
      : "warn",
    paths: [...new Set(paths)],
    memberNames: asStringArray(conflict.memberNames).concat(memberName ? [memberName] : []),
    leaseId: asString(conflict.leaseId) || undefined,
    createdAt: asString(conflict.createdAt) || undefined,
    status: asString(conflict.status) || undefined,
  };
}

function normalizeGenericRecord(value: unknown, fallbackKind: RecordKind): ProjectRecord {
  const record = asObject(value);
  const rawKind = asString(record.kind, asString(record.type, fallbackKind));
  const kind = ["decision", "validation", "handoff", "risk", "context"].includes(rawKind)
    ? (rawKind as RecordKind)
    : fallbackKind;
  const rawEvidence = record.evidence;
  const evidence = Array.isArray(rawEvidence)
    ? asStringArray(rawEvidence).join("；")
    : asString(rawEvidence) || undefined;
  let title = asString(record.title, "未命名记录");
  const validationMatch = title.match(/^(static|automated_test|unity_edit_mode|unity_play_mode|manual): (passed|failed|pending)$/);
  if (validationMatch) {
    const kindLabels: Record<string, string> = {
      static: "静态检查",
      automated_test: "自动化测试",
      unity_edit_mode: "Unity Edit Mode",
      unity_play_mode: "Unity Play Mode",
      manual: "人工验收",
    };
    const resultLabels: Record<string, string> = { passed: "通过", failed: "失败", pending: "待验证" };
    title = `${kindLabels[validationMatch[1]]} · ${resultLabels[validationMatch[2]]}`;
  } else if (title === "Team handoff") {
    title = "团队交接";
  } else if (title.startsWith("Handoff to ")) {
    title = `交接给 ${title.slice("Handoff to ".length)}`;
  } else if (title.endsWith(": reported validation")) {
    title = `${title.slice(0, -": reported validation".length)}：验证结果`;
  } else if (title.endsWith(": remaining risks")) {
    title = `${title.slice(0, -": remaining risks".length)}：遗留风险`;
  } else if (title.endsWith(": handoff")) {
    title = `${title.slice(0, -": handoff".length)}：工作交接`;
  }
  return {
    id: asString(record.id),
    kind,
    title,
    summary: asString(record.summary, asString(record.content, asString(record.decision))),
    memberName:
      asString(record.memberName, asString(record.authorName, asString(record.fromMemberName))) || undefined,
    paths: pathValues(record.paths).paths,
    status: asString(record.status, asString(record.result, asString(record.kind))) || undefined,
    evidence,
    command: asString(record.command) || undefined,
    commitHash: asString(record.commitHash) || undefined,
    createdAt: asString(record.createdAt) || undefined,
  };
}

function normalizeDecision(value: unknown): ProjectRecord {
  const record = asObject(value);
  const decision = asString(record.decision, asString(record.summary));
  const rationale = asString(record.rationale);
  return {
    ...normalizeGenericRecord(value, "decision"),
    kind: "decision",
    summary: decision,
    details: rationale ? [`原因：${rationale}`] : undefined,
  };
}

function normalizeVerification(value: unknown): ProjectRecord {
  const record = asObject(value);
  return {
    ...normalizeGenericRecord(value, "validation"),
    kind: "validation",
    title: asString(record.title, asString(record.summary, "验证记录")),
    summary: asString(record.summary),
    status: asString(record.result, asString(record.status, "pending")),
  };
}

function normalizeHandoff(value: unknown): ProjectRecord {
  const record = asObject(value);
  const completed = asStringArray(record.completed).map((item) => `已完成：${item}`);
  const remaining = asStringArray(record.remaining).map((item) => `待处理：${item}`);
  const risks = asStringArray(record.risks).map((item) => `风险：${item}`);
  const toName = asString(record.toMemberName);
  return {
    ...normalizeGenericRecord(value, "handoff"),
    kind: "handoff",
    title: asString(record.title, toName ? `交接给 ${toName}` : "团队交接"),
    summary: asString(record.summary),
    details: [...completed, ...remaining, ...risks],
  };
}

function normalizeContext(value: unknown): ProjectRecord {
  const record = asObject(value);
  const contextKind = asString(record.kind, "note");
  return {
    ...normalizeGenericRecord(value, contextKind === "risk" ? "risk" : "context"),
    kind: contextKind === "risk" ? "risk" : "context",
    status: contextKind,
  };
}

function normalizeActivity(value: unknown): ActivityItem {
  const activity = asObject(value);
  const rawSummary = asString(activity.summary, asString(activity.description));
  const type = asString(activity.type);
  const actorName = asString(activity.memberName, asString(activity.actorName, asString(asObject(activity.member).name))) || "Agent Hub";
  let summary = rawSummary;
  if (type === "room.created") summary = `${actorName} 创建了协作房间`;
  else if (type === "member.joined") summary = `${actorName} 加入了房间`;
  else if (type === "lease.rejected") summary = `${actorName} 的工作范围因独占冲突未被登记`;
  else if (type === "lease.renewed") summary = `${actorName} 延长了工作范围保护`;
  else if (type === "lease.expired") summary = "一项工作范围保护已过期";
  else if (type === "lease.acquired") {
    const match = rawSummary.match(/registered (?:read|write) work: (.+)\.$/);
    summary = match ? `${actorName} 开始了工作：${match[1]}` : `${actorName} 登记了工作范围`;
  } else if (type === "lease.closed") {
    const match = rawSummary.match(/ (?:completed|cancelled) (.+)\.$/);
    summary = match ? `${actorName} 完成了工作：${match[1]}` : `${actorName} 结束并释放了工作范围`;
  } else if (type === "decision.added") {
    const match = rawSummary.match(/^Recorded decision: (.+)\.$/);
    summary = match ? `${actorName} 记录了决定：${match[1]}` : `${actorName} 记录了团队决定`;
  } else if (type === "verification.added") {
    summary = `${actorName} 记录了验证结果`;
  } else if (type === "handoff.added") {
    summary = `${actorName} 记录了项目交接`;
  } else if (type === "context.added" || type === "record.added") {
    summary = `${actorName} 补充了项目上下文`;
  } else if (type === "session.opened") {
    summary = `${actorName} 的本地组件已连接`;
  } else if (type === "session.closed") {
    summary = `${actorName} 的本地组件已断开`;
  } else if (type === "session.scanned") {
    summary = `${actorName} 完成了本地项目扫描`;
  }
  return {
    id: asString(activity.id),
    type: type || undefined,
    title: summary || asString(activity.title, asString(activity.action, "项目动态")),
    summary: undefined,
    memberName: actorName === "Agent Hub" ? undefined : actorName,
    createdAt: asString(activity.createdAt) || undefined,
  };
}

function normalizeAgentSession(value: unknown): AgentSession {
  const session = asObject(value);
  return {
    id: asString(session.id),
    memberId: asString(session.memberId),
    codexSessionId: asString(session.codexSessionId, asString(session.codex_session_id)) || undefined,
    currentTurnId: asString(session.currentTurnId, asString(session.current_turn_id)) || undefined,
    activityEpoch: typeof session.activityEpoch === "number" && Number.isFinite(session.activityEpoch)
      ? session.activityEpoch
      : typeof session.activity_epoch === "number" && Number.isFinite(session.activity_epoch)
        ? session.activity_epoch
        : undefined,
    clientName: asString(session.clientName) || undefined,
    agentName: asString(session.agentName) || undefined,
    task: asString(session.task) || undefined,
    branch: asString(session.branch) || undefined,
    baseCommit: asString(session.baseCommit) || undefined,
    status: asString(session.status, "active"),
    lastSeenAt: asString(session.lastSeenAt) || undefined,
    turnStoppedAt: asString(session.turnStoppedAt) || undefined,
    clientVersion: asString(session.clientVersion) || undefined,
    protocolVersion: typeof session.protocolVersion === "number" ? session.protocolVersion : undefined,
    schemaVersion: typeof session.schemaVersion === "number" ? session.schemaVersion : undefined,
  };
}

function normalizeLeaseScopeEvent(value: unknown): LeaseScopeEvent {
  const event = asObject(value);
  const metadata = asObject(event.metadata);
  const source = asString(metadata.source);
  const stage = asString(metadata.stage);
  return {
    id: asString(event.id),
    type: asString(event.type),
    actorName: asString(event.actorName) || undefined,
    memberName: asString(event.memberName) || undefined,
    title: asString(event.title, asString(event.summary, "范围调用记录")),
    summary: asString(event.summary) || undefined,
    metadata: {
      invocationId: asString(metadata.invocationId) || undefined,
      source: ["ui", "mcp", "hook", "legacy"].includes(source)
        ? source as LeaseScopeEventMetadata["source"]
        : undefined,
      toolName: asString(metadata.toolName) || undefined,
      stage: ["pre", "post"].includes(stage) ? stage as LeaseScopeEventMetadata["stage"] : undefined,
      turnId: asString(metadata.turnId) || undefined,
      requestedPaths: asStringArray(metadata.requestedPaths),
      coveredPaths: asStringArray(metadata.coveredPaths),
      addedPaths: asStringArray(metadata.addedPaths),
      ignoredPaths: asStringArray(metadata.ignoredPaths),
      actualPaths: asStringArray(metadata.actualPaths),
      pathDiagnostics: asStringArray(metadata.pathDiagnostics),
    },
    createdAt: asString(event.createdAt) || undefined,
  };
}

function normalizeLeaseCoverage(value: unknown): LeaseCoverage | undefined {
  const coverage = asObject(value);
  const leaseId = asString(coverage.leaseId);
  const managedBy = asString(coverage.managedBy);
  const action = asString(coverage.action);
  if (!leaseId || !["manual", "agent"].includes(managedBy) || !["covered", "added"].includes(action)) {
    return undefined;
  }
  return {
    leaseId,
    managedBy: managedBy as LeaseCoverage["managedBy"],
    paths: asStringArray(coverage.paths),
    action: action as LeaseCoverage["action"],
  };
}

function normalizeRiskRule(value: unknown): RiskRule | undefined {
  const rule = asObject(value);
  const kind = asString(rule.kind);
  const selector = asString(rule.selector);
  const level = asString(rule.level);
  if (!["category", "extension", "file", "directory"].includes(kind) || !selector) return undefined;
  if (level !== "warning" && level !== "blocking") return undefined;
  return {
    id: asString(rule.id) || undefined,
    kind: kind as RiskRule["kind"],
    selector,
    level,
  };
}

function normalizeRoomSettings(value: unknown, room?: Room): RoomSettings {
  const settings = asObject(value);
  const rawTtl = asNumber(settings.automaticLeaseTtlMinutes, 10);
  const automaticLeaseTtlMinutes = [5, 10, 15, 30, 60].includes(rawTtl)
    ? rawTtl as RoomSettings["automaticLeaseTtlMinutes"]
    : 10;
  const blockingProtectionEnabled = typeof settings.blockingProtectionEnabled === "boolean"
    ? settings.blockingProtectionEnabled
    : room?.autoLockAfterAutoClaim !== false;
  return {
    autoLockAfterAutoClaim: blockingProtectionEnabled,
    blockingProtectionEnabled,
    automaticLeaseTtlMinutes,
    maximumExclusiveLeaseMinutes: Math.max(5, Math.round(asNumber(settings.maximumExclusiveLeaseMinutes, 1440))),
    riskPolicyVersion: Math.max(1, Math.round(asNumber(settings.riskPolicyVersion, 1))),
    riskRules: firstArray(settings.riskRules).map(normalizeRiskRule).filter((rule): rule is RiskRule => Boolean(rule)),
    updatedAt: asString(settings.updatedAt) || undefined,
    updatedBy: asString(settings.updatedBy) || undefined,
  };
}

function normalizeReleaseRequest(value: unknown): ReleaseRequest {
  const request = asObject(value);
  const leaseKind = (raw: unknown): Lease["kind"] => ["automatic", "standard", "exclusive"].includes(asString(raw))
    ? asString(raw) as Lease["kind"]
    : "automatic";
  const rawStatus = asString(request.status, "pending");
  return {
    id: asString(request.id),
    requesterMemberId: asString(request.requesterMemberId),
    requesterName: asString(request.requesterName, "团队成员"),
    requesterSessionId: asString(request.requesterSessionId) || undefined,
    requesterLeaseId: asString(request.requesterLeaseId) || undefined,
    holderMemberId: asString(request.holderMemberId),
    holderName: asString(request.holderName, "范围持有人"),
    conflictingLeaseId: asString(request.conflictingLeaseId),
    conflictingLeaseTitle: asString(request.conflictingLeaseTitle, "受保护范围"),
    conflictingLeaseKind: leaseKind(request.conflictingLeaseKind),
    requestTitle: asString(request.requestTitle, "请求修改受保护范围"),
    requestObjective: asString(request.requestObjective) || undefined,
    requestedKind: leaseKind(request.requestedKind),
    requestedMode: request.requestedMode === "read" ? "read" : "write",
    requestedPaths: asStringArray(request.requestedPaths),
    overlapPaths: firstArray(request.overlapPaths).map((item) => {
      const overlap = asObject(item);
      return { requestedPath: asString(overlap.requestedPath), existingPath: asString(overlap.existingPath) };
    }).filter((item) => item.requestedPath && item.existingPath),
    reason: asString(request.reason, "请求范围与现有保护重叠。"),
    status: ["pending", "approved", "rejected", "cancelled"].includes(rawStatus)
      ? rawStatus as ReleaseRequest["status"]
      : "pending",
    rejectionReason: asString(request.rejectionReason) || undefined,
    transferredLeaseId: asString(request.transferredLeaseId) || undefined,
    occurrenceCount: Math.max(1, Math.round(asNumber(request.occurrenceCount, 1))),
    requestedAt: asString(request.requestedAt),
    lastRequestedAt: asString(request.lastRequestedAt, asString(request.requestedAt)),
    resolvedAt: asString(request.resolvedAt) || undefined,
    holderLeaseExpiresAt: asString(request.holderLeaseExpiresAt),
  };
}

function normalizeLocalScan(value: unknown): LocalScan {
  const scan = asObject(value);
  return {
    id: asString(scan.id),
    sessionId: asString(scan.sessionId) || undefined,
    memberId: asString(scan.memberId),
    changedPaths: asStringArray(scan.changedPaths),
    systems: asStringArray(scan.systems),
    ruleFiles: asStringArray(scan.ruleFiles),
    scannedAt: asString(scan.scannedAt) || undefined,
  };
}

type RequestAccess = string | Pick<Session, "memberToken" | "connectionId" | "serverUrl"> | undefined;

function accessToken(access: RequestAccess): string | undefined {
  return typeof access === "string" ? access : access?.memberToken;
}

function accessConnectionId(access: RequestAccess): string | undefined {
  return typeof access === "string" ? undefined : access?.connectionId;
}

function accessServerUrl(access: RequestAccess): string | undefined {
  return typeof access === "string" ? undefined : access?.serverUrl;
}

function requestBody(init: RequestInit): unknown {
  if (init.body === undefined || init.body === null) return undefined;
  if (typeof init.body !== "string") throw new ApiError("请求内容格式不正确。", 400);
  try {
    return JSON.parse(init.body) as unknown;
  } catch {
    throw new ApiError("请求内容格式不正确。", 400);
  }
}

function translatedError(payload: Record<string, unknown>, status: number): ApiError {
  const code = asString(payload.error);
  const translated: Record<string, string> = {
    invite_not_found: "房间码无效或房间已不存在。",
    invalid_invite: "房间码格式不正确。",
    unauthorized: "成员凭证已失效，请重新加入房间。",
    invalid_input: "填写内容不完整或格式不正确。",
    lease_not_active: "这项工作已结束，无法继续操作。",
    lease_not_found: "没有找到这项工作，它可能已经被释放。",
    lease_forbidden: "只能操作自己领取的工作范围。",
    member_not_found: "没有找到指定成员。",
    invalid_verification_kind: "请选择有效的验证类型。",
    invalid_verification_result: "请选择有效的验证结果。",
    monitor_mode_upgrade_required: "开启纯监测模式前，房间中的所有成员都必须升级到当前协议并重新连接。",
  };
  return new ApiError(
    translated[code] ?? asString(payload.message, code || "请求未完成，请稍后重试。"),
    status,
    code || undefined,
    payload.details,
  );
}

function friendlyDesktopError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : "无法连接房主服务。";
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*/i, "");
  if (message.includes("could not reach the room server")) {
    return new Error("无法连接房主服务，请确认邀请地址正确且房主电脑在线。");
  }
  if (message.includes("selected room connection does not exist")) {
    return new Error("保存的房间连接已不存在，请重新加入。");
  }
  if (message.includes("Windows secure storage is unavailable")) {
    return new Error("Windows 安全存储当前不可用，无法保存房间连接。");
  }
  return new Error(message);
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  access?: RequestAccess,
  bootstrapServerUrl?: string,
): Promise<T> {
  const desktop = window.agentHubDesktop;
  const connectionId = accessConnectionId(access);
  const method = (init.method ?? "GET").toUpperCase();
  if (desktop && (connectionId || bootstrapServerUrl)) {
    if (method !== "GET" && method !== "POST") throw new ApiError("不支持这项请求。", 405);
    try {
      const response = await desktop.requestRoomServer({
        ...(connectionId ? { connectionId } : { serverUrl: bootstrapServerUrl! }),
        method,
        path,
        ...(method === "POST" ? { body: requestBody(init) } : {}),
      } as RoomServerRequest);
      const payload = asObject(response.body);
      if (response.status < 200 || response.status >= 300) throw translatedError(payload, response.status);
      return response.body as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw friendlyDesktopError(error);
    }
  }

  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  const token = accessToken(access);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const baseUrl = bootstrapServerUrl ?? accessServerUrl(access);
  const target = baseUrl ? new URL(path, `${baseUrl.replace(/\/+$/, "")}/`).toString() : path;

  let response: Response;
  try {
    response = await fetch(target, { ...init, headers });
  } catch {
    throw new ApiError("无法连接 Agent Hub，请确认房主服务正在运行。", 0);
  }

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw translatedError(payload, response.status);
  return payload as T;
}

async function requestFirst<T>(
  candidates: Array<{ path: string; init?: RequestInit }>,
  access?: RequestAccess,
): Promise<T> {
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await request<T>(candidate.path, candidate.init, access);
    } catch (error) {
      lastError = error;
      if (!(error instanceof ApiError) || ![404, 405].includes(error.status)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new ApiError("服务接口不可用。", 404);
}

export function loadSession(): Session | null {
  try {
    let raw = sessionStorage.getItem(SESSION_RUNTIME_KEY);
    if (!raw) raw = localStorage.getItem(SESSION_POINTER_KEY);
    if (!raw) {
      for (const key of LEGACY_SESSION_KEYS) {
        const legacy = localStorage.getItem(key);
        if (!legacy) continue;
        sessionStorage.setItem(SESSION_RUNTIME_KEY, legacy);
        localStorage.removeItem(key);
        raw = legacy;
        break;
      }
    }
    if (!raw) return null;
    const parsed = asObject(JSON.parse(raw));
    const memberToken = asString(parsed.memberToken, asString(parsed.token));
    const connectionId = asString(parsed.connectionId) || undefined;
    if (!memberToken && !connectionId) return null;
    const roomToken = asString(parsed.roomToken) || undefined;
    return {
      memberToken: memberToken || undefined,
      connectionId,
      serverUrl: asString(parsed.serverUrl) || undefined,
      inviteServerUrl: asString(parsed.inviteServerUrl) || undefined,
      repositoryPath: asString(parsed.repositoryPath) || undefined,
      roomToken,
      room: normalizeRoom(parsed.room, roomToken),
      member: normalizeMember(parsed.member),
      integrationEnabled: parsed.integrationEnabled !== false,
    };
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  for (const key of LEGACY_SESSION_KEYS) localStorage.removeItem(key);
  if (session.connectionId) {
    const publicSession: Session = {
      connectionId: session.connectionId,
      serverUrl: session.serverUrl,
      inviteServerUrl: session.inviteServerUrl,
      repositoryPath: session.repositoryPath,
      room: { ...session.room, code: undefined },
      member: session.member,
      integrationEnabled: session.integrationEnabled !== false,
    };
    localStorage.setItem(SESSION_POINTER_KEY, JSON.stringify(publicSession));
    sessionStorage.removeItem(SESSION_RUNTIME_KEY);
    return;
  }
  localStorage.removeItem(SESSION_POINTER_KEY);
  sessionStorage.setItem(SESSION_RUNTIME_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_POINTER_KEY);
  sessionStorage.removeItem(SESSION_RUNTIME_KEY);
  for (const key of LEGACY_SESSION_KEYS) localStorage.removeItem(key);
}

function clearMatchingSavedConnectionSession(connectionId: string): void {
  if (loadSession()?.connectionId === connectionId) clearSession();
}

function normalizeSession(value: unknown): Session {
  const payload = asObject(value);
  const memberToken = asString(payload.memberToken, asString(payload.token));
  const roomToken = asString(payload.roomToken, asString(payload.inviteCode)) || undefined;
  if (!memberToken) throw new ApiError("服务没有返回成员凭证，请重新创建或加入房间。", 500);
  return {
    memberToken,
    roomToken,
    room: normalizeRoom(payload.room, roomToken),
    member: normalizeMember(payload.member),
  };
}

export async function checkHealth(): Promise<boolean> {
  try {
    await request("/api/health");
    return true;
  } catch {
    return false;
  }
}

export function isDesktopApp(): boolean {
  return Boolean(window.agentHubDesktop);
}

export async function getDesktopServerInfo(): Promise<DesktopServerInfo | null> {
  try {
    const desktop = window.agentHubDesktop;
    if (!desktop || typeof desktop.getServerInfo !== "function") return null;
    return (await desktop.getServerInfo()) ?? null;
  } catch (error) {
    throw friendlyDesktopError(error);
  }
}

export async function chooseRepository(): Promise<{ path: string; snapshot: RepositorySnapshot } | null> {
  const desktop = window.agentHubDesktop;
  if (!desktop) return null;
  try {
    const path = await desktop.chooseRepository();
    if (!path) return null;
    return { path, snapshot: await desktop.inspectRepository(path) };
  } catch (error) {
    throw friendlyDesktopError(error);
  }
}

export async function listSavedConnections(): Promise<SavedRoomConnection[]> {
  try {
    return (await window.agentHubDesktop?.listRoomConnections()) ?? [];
  } catch (error) {
    throw friendlyDesktopError(error);
  }
}

export function resumeSavedConnection(connection: SavedRoomConnection): Session {
  return {
    connectionId: connection.id,
    serverUrl: connection.serverUrl,
    repositoryPath: connection.repositoryPath,
    room: normalizeRoom({ id: connection.roomId, name: connection.roomName }),
    member: normalizeMember({ name: connection.memberName, role: connection.memberRole }),
    integrationEnabled: connection.integrationEnabled !== false,
  };
}

export async function pauseSavedConnection(
  connectionId: string,
): Promise<{ queued: boolean; requestId: string; cleanupError?: string; localRoomServerStopped: boolean }> {
  const desktop = window.agentHubDesktop;
  if (!desktop) return { queued: false, requestId: "", localRoomServerStopped: false };
  try {
    const result = await desktop.pauseRoomConnection(connectionId);
    return {
      queued: result.queued,
      requestId: result.requestId,
      cleanupError: result.cleanupError,
      localRoomServerStopped: result.localRoomServerStopped,
    };
  } catch (error) {
    throw friendlyDesktopError(error);
  }
}

export async function activateSavedConnection(connectionId: string): Promise<ActivateRoomConnectionResult | null> {
  const desktop = window.agentHubDesktop;
  if (!desktop || typeof desktop.activateRoomConnection !== "function") return null;
  try {
    return await desktop.activateRoomConnection(connectionId);
  } catch (error) {
    throw friendlyDesktopError(error);
  }
}

export async function deleteSavedConnection(connectionId: string): Promise<DeleteRoomConnectionResult> {
  const desktop = window.agentHubDesktop;
  if (!desktop || typeof desktop.deleteRoomConnection !== "function") {
    throw new Error("仅桌面客户端支持从本机移除已保存的房间连接。");
  }
  try {
    const result = await desktop.deleteRoomConnection(connectionId);
    if (result.deletedConnectionId !== connectionId) {
      throw new Error("桌面客户端返回了不匹配的房间连接标识，删除结果未被接受。");
    }
    clearMatchingSavedConnectionSession(connectionId);
    return result;
  } catch (error) {
    throw friendlyDesktopError(error);
  }
}

export async function secureDesktopSession(
  session: Session,
  serverUrl: string,
  repositoryPath: string,
): Promise<SecureDesktopSessionResult> {
  const desktop = window.agentHubDesktop;
  if (!desktop) return { session, activation: null };
  if (!session.memberToken) throw new ApiError("服务没有返回成员凭证，请重新创建或加入房间。", 500);
  try {
    const activation = await desktop.saveRoomConnection({
      serverUrl,
      memberToken: session.memberToken,
      repositoryPath,
      roomId: session.room.id,
      roomName: session.room.name,
      memberName: session.member.name,
      memberRole: session.member.role === "host" ? "host" : "member",
      integrationEnabled: session.integrationEnabled,
    });
    const saved = activation.connection;
    return {
      session: {
        ...session,
        memberToken: undefined,
        connectionId: saved.id,
        serverUrl: saved.serverUrl,
        repositoryPath: saved.repositoryPath,
        integrationEnabled: saved.integrationEnabled,
      },
      activation,
    };
  } catch (error) {
    throw friendlyDesktopError(error);
  }
}

export async function installCodexConnection(connectionId: string): Promise<string> {
  const desktop = window.agentHubDesktop;
  if (!desktop) throw new Error("请在 Agent Hub 桌面客户端中安装 Codex 连接。");
  try {
    const result = await desktop.installCodexIntegration(connectionId);
    return result.restartRequired
      ? `${result.mcpServerName} 已安装，重启 Codex 后生效。`
      : `${result.mcpServerName} 配置已经是最新版本。`;
  } catch (error) {
    throw friendlyDesktopError(error);
  }
}

export async function createRoom(input: CreateRoomInput): Promise<Session> {
  const desktopServerInfo = await getDesktopServerInfo();
  const desktopServerUrl = desktopServerInfo?.localServerUrl;
  const result = await request("/api/rooms", {
    method: "POST",
    body: JSON.stringify({
      roomName: input.roomName,
      projectName: input.projectName,
      repository: input.repository,
      defaultBranch: input.defaultBranch || "main",
      ownerName: input.ownerName,
      clientName: input.agent || "Codex",
      clientVersion: desktopServerInfo?.appVersion,
      protocolVersion: desktopServerInfo?.protocolVersion,
      schemaVersion: desktopServerInfo?.schemaVersion,
    }),
  }, undefined, desktopServerUrl);
  const session = normalizeSession(result);
  session.serverUrl = desktopServerUrl ?? window.location.origin;
  session.inviteServerUrl = desktopServerInfo?.lanUrls[0] ?? session.serverUrl;
  return session;
}

export async function joinRoom(input: JoinRoomInput): Promise<Session> {
  const desktopServerInfo = await getDesktopServerInfo();
  const result = await request("/api/rooms/join", {
    method: "POST",
    body: JSON.stringify({
      inviteCode: input.roomToken,
      memberName: input.memberName,
      clientName: input.agent || "Codex",
      clientVersion: desktopServerInfo?.appVersion,
      protocolVersion: desktopServerInfo?.protocolVersion,
      schemaVersion: desktopServerInfo?.schemaVersion,
    }),
  }, undefined, input.serverUrl);
  const session = normalizeSession(result);
  session.serverUrl = input.serverUrl.replace(/\/+$/, "");
  session.roomToken = input.roomToken;
  session.room.code ||= input.roomToken;
  return session;
}

export async function getDashboard(access: RequestAccess, roomToken?: string): Promise<Dashboard> {
  const payload = asObject(
    await requestFirst(
      [
        { path: "/api/dashboard" },
        { path: "/api/snapshot" },
      ],
      access,
    ),
  );
  const records = firstArray(payload.records).map((record) => normalizeGenericRecord(record, "context"));
  records.push(...firstArray(payload.contextEntries, payload.context).map(normalizeContext));
  records.push(...firstArray(payload.decisions).map(normalizeDecision));
  records.push(...firstArray(payload.verifications, payload.validations).map(normalizeVerification));
  records.push(...firstArray(payload.handoffs).map(normalizeHandoff));
  records.sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  const rawConflicts = firstArray(payload.conflicts, payload.blockers);
  const room = normalizeRoom(payload.room, roomToken);
  return {
    room,
    currentMember: normalizeMember(payload.currentMember),
    members: firstArray(payload.members).map(normalizeMember),
    leases: firstArray(payload.leases, payload.activeLeases).map(normalizeLease),
    conflicts: rawConflicts.map(normalizeConflict),
    records,
    activity: firstArray(payload.activity, payload.activities).map(normalizeActivity),
    sessions: firstArray(payload.sessions).map(normalizeAgentSession),
    localScans: firstArray(payload.localScans).map(normalizeLocalScan),
    settings: normalizeRoomSettings(payload.settings, room),
    releaseRequests: firstArray(payload.releaseRequests).map(normalizeReleaseRequest),
    partialSections: asStringArray(payload.partialSections),
    sectionTotals: Object.fromEntries(
      Object.entries(asObject(payload.sectionTotals))
        .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
    ),
    generatedAt: asString(payload.generatedAt) || undefined,
    server: {
      mcpUrl: asString(asObject(payload.server).mcpUrl, `${accessServerUrl(access) ?? window.location.origin}/mcp`),
    },
  };
}

export async function getLeaseScopeEvents(
  access: RequestAccess,
  leaseId: string,
  options: { limit?: number; before?: string } = {},
): Promise<LeaseScopeEventPage> {
  const requestedLimit = typeof options.limit === "number" && Number.isFinite(options.limit)
    ? options.limit
    : 50;
  const limit = Math.min(100, Math.max(1, Math.trunc(requestedLimit)));
  const query = new URLSearchParams({ limit: String(limit) });
  if (options.before) query.set("before", options.before);
  const payload = asObject(await requestFirst(
    [{ path: `/api/leases/${encodeURIComponent(leaseId)}/scope-events?${query.toString()}` }],
    access,
  ));
  return {
    items: firstArray(payload.items).map(normalizeLeaseScopeEvent),
    nextBefore: asString(payload.nextBefore) || undefined,
  };
}

export async function createLease(access: RequestAccess, input: CreateLeaseInput): Promise<LeaseDecision> {
  const body = JSON.stringify({
    title: input.title,
    intent: input.objective ?? "",
    branch: input.branch ?? "",
    baseCommit: input.baseCommit,
    paths: input.paths,
    mode: "write",
    ttlMinutes: input.ttlMinutes,
    // 这个客户端入口只创建人工租约。Agent 领取分别由 MCP 和 Hook 的专用入口负责。
    kind: input.kind ?? "standard",
  });
  const payload = asObject(
    await requestFirst(
      [
        { path: "/api/leases", init: { method: "POST", body } },
      ],
      access,
    ),
  );
  const conflicts = firstArray(payload.conflicts).map(normalizeConflict);
  const acquired = typeof payload.acquired === "boolean" ? payload.acquired : Boolean(payload.lease);
  // 旧服务或异常响应缺少 decision 时只能降级为提醒，客户端不能根据 acquired 自行制造阻止。
  const fallbackDecision: LeaseDecision["decision"] = acquired
    ? conflicts.length ? "warn" : "allow"
    : "warn";
  const rawDecision = asString(payload.decision, fallbackDecision);
  return {
    acquired,
    lease: payload.lease ? normalizeLease(payload.lease) : undefined,
    coverage: firstArray(payload.coverage).flatMap((item) => {
      const coverage = normalizeLeaseCoverage(item);
      return coverage ? [coverage] : [];
    }),
    conflicts,
    decision: ["allow", "warn", "deny", "wait"].includes(rawDecision)
      ? (rawDecision as LeaseDecision["decision"])
      : fallbackDecision,
    releaseRequests: firstArray(payload.releaseRequests).map(normalizeReleaseRequest),
    waitingFor: payload.waitingFor ? {
      leaseId: asString(asObject(payload.waitingFor).leaseId),
      sessionId: asString(asObject(payload.waitingFor).sessionId) || undefined,
      title: asString(asObject(payload.waitingFor).title),
      memberName: asString(asObject(payload.waitingFor).memberName),
      expiresAt: asString(asObject(payload.waitingFor).expiresAt),
      paths: asStringArray(asObject(payload.waitingFor).paths),
    } : undefined,
  };
}

export type UpdateRoomSettingsInput = Partial<Pick<
  RoomSettings,
  "blockingProtectionEnabled" | "automaticLeaseTtlMinutes" | "maximumExclusiveLeaseMinutes" | "riskRules"
>> & {
  resetRiskPolicy?: boolean;
};

export async function getRoomSettings(access: RequestAccess): Promise<RoomSettings> {
  const payload = asObject(await requestFirst([{ path: "/api/room/settings" }], access));
  return normalizeRoomSettings(payload.settings);
}

export async function updateRoomSettings(
  access: RequestAccess,
  input: UpdateRoomSettingsInput,
): Promise<RoomSettings> {
  const payload = asObject(await requestFirst([{ path: "/api/room/settings", init: { method: "POST", body: JSON.stringify(input) } }], access));
  return normalizeRoomSettings(payload.settings);
}

export async function listReleaseRequests(
  access: RequestAccess,
  status: ReleaseRequest["status"] | "all" = "pending",
): Promise<ReleaseRequest[]> {
  const payload = asObject(await requestFirst([
    { path: `/api/release-requests?status=${encodeURIComponent(status)}` },
  ], access));
  return firstArray(payload.releaseRequests).map(normalizeReleaseRequest);
}

export async function resolveReleaseRequest(
  access: RequestAccess,
  requestId: string,
  decision: "approve" | "reject",
  reason?: string,
): Promise<ReleaseRequest> {
  const payload = asObject(await requestFirst([{
    path: `/api/release-requests/${encodeURIComponent(requestId)}/resolve`,
    init: { method: "POST", body: JSON.stringify({ decision, reason }) },
  }], access));
  return normalizeReleaseRequest(payload.releaseRequest);
}

export async function manageMember(access: RequestAccess, memberId: string, action: "admin" | "remove", isAdmin?: boolean): Promise<void> {
  if (action === "admin") {
    await requestFirst([{ path: `/api/room/members/${encodeURIComponent(memberId)}/role`, init: { method: "POST", body: JSON.stringify({ isAdmin: Boolean(isAdmin) }) } }], access);
  } else {
    await requestFirst([{ path: `/api/room/members/${encodeURIComponent(memberId)}/remove`, init: { method: "POST", body: "{}" } }], access);
  }
}

export async function transferOwnership(access: RequestAccess, targetMemberId: string): Promise<void> {
  await requestFirst([{ path: "/api/room/transfer", init: { method: "POST", body: JSON.stringify({ targetMemberId }) } }], access);
}

export async function dissolveRoom(access: RequestAccess): Promise<void> {
  await requestFirst([{ path: "/api/room/dissolve", init: { method: "POST", body: "{}" } }], access);
}

export async function exportRoomContext(access: RequestAccess): Promise<unknown> {
  return requestFirst([{ path: "/api/room/context/export" }], access);
}

export async function importRoomContext(access: RequestAccess, payload: unknown): Promise<{ imported: number; rejected: number }> {
  return requestFirst([{ path: "/api/room/context/import", init: { method: "POST", body: JSON.stringify(payload) } }], access);
}

export async function rebaselineSession(access: RequestAccess, sessionId: string, branch: string, baseCommit: string): Promise<void> {
  await requestFirst([{ path: `/api/sessions/${encodeURIComponent(sessionId)}/rebaseline`, init: { method: "POST", body: JSON.stringify({ branch, baseCommit }) } }], access);
}

export async function getUpdateStatus(access: RequestAccess): Promise<Record<string, unknown>> {
  const payload = asObject(await requestFirst([{ path: "/api/update/status" }], access));
  return asObject(payload.update);
}

export async function checkForUpdate(access: RequestAccess): Promise<Record<string, unknown>> {
  const payload = asObject(await requestFirst([{ path: "/api/update/check", init: { method: "POST", body: "{}" } }], access));
  return asObject(payload.update);
}

export async function stageUpdate(access: RequestAccess): Promise<Record<string, unknown>> {
  const payload = asObject(await requestFirst([{ path: "/api/update/stage", init: { method: "POST", body: "{}" } }], access));
  return asObject(payload.update);
}

export async function getDesktopUpdateStatus(): Promise<DesktopUpdateStatus> {
  if (!window.agentHubDesktop) throw new ApiError("软件更新仅在 Agent Hub 桌面版中可用。", 400);
  return window.agentHubDesktop.getDesktopUpdateStatus();
}

export async function checkDesktopUpdate(): Promise<DesktopUpdateStatus> {
  if (!window.agentHubDesktop) throw new ApiError("软件更新仅在 Agent Hub 桌面版中可用。", 400);
  return window.agentHubDesktop.checkDesktopUpdate();
}

export async function downloadDesktopUpdate(): Promise<DesktopUpdateStatus> {
  if (!window.agentHubDesktop) throw new ApiError("软件更新仅在 Agent Hub 桌面版中可用。", 400);
  return window.agentHubDesktop.downloadDesktopUpdate();
}

export async function installDesktopUpdate(): Promise<DesktopUpdateStatus> {
  if (!window.agentHubDesktop) throw new ApiError("软件更新仅在 Agent Hub 桌面版中可用。", 400);
  return window.agentHubDesktop.installDesktopUpdate();
}

export function subscribeDesktopUpdateStatus(listener: (status: DesktopUpdateStatus) => void): () => void {
  return window.agentHubDesktop?.onDesktopUpdateStatus(listener) ?? (() => undefined);
}

export async function renewLease(access: RequestAccess, leaseId: string, ttlMinutes = 120): Promise<void> {
  const body = JSON.stringify({ ttlMinutes });
  await requestFirst(
    [
      { path: `/api/leases/${encodeURIComponent(leaseId)}/renew`, init: { method: "POST", body } },
    ],
    access,
  );
}

export async function closeLease(
  access: RequestAccess,
  leaseId: string,
  input: CloseLeaseInput,
): Promise<void> {
  const body = JSON.stringify({
    outcome: input.outcome,
    changedPaths: input.changedPaths ?? [],
    commitHash: input.commitHash,
    validations: input.validations ?? [],
    remainingRisks: input.remainingRisks ?? [],
    handoff: input.handoff,
  });
  await requestFirst(
    [
      { path: `/api/leases/${encodeURIComponent(leaseId)}/close`, init: { method: "POST", body } },
    ],
    access,
  );
}

function recordRequest(input: CreateRecordInput): { path: string; body: string } {
  const common = { paths: input.paths ?? [] };
  if (input.kind === "decision") {
    return {
      path: "/api/decisions",
      body: JSON.stringify({
        ...common,
        title: input.title,
        decision: input.summary,
        rationale: input.evidence,
      }),
    };
  }
  if (input.kind === "validation") {
    return {
      path: "/api/verifications",
      body: JSON.stringify({
        leaseId: input.leaseId,
        kind: input.title || "manual",
        result: input.status || "pending",
        summary: input.summary,
        command: input.command,
        evidence: input.evidence,
      }),
    };
  }
  if (input.kind === "handoff") {
    return {
      path: "/api/handoffs",
      body: JSON.stringify({
        leaseId: input.leaseId,
        toMemberId: input.toMemberId,
        summary: input.summary,
        completed: input.completed ?? [],
        remaining: input.remaining ?? [],
        risks: input.risks ?? [],
      }),
    };
  }
  return {
    path: "/api/context",
    body: JSON.stringify({ ...common, kind: "risk", title: input.title, content: input.summary }),
  };
}

export async function createRecord(access: RequestAccess, input: CreateRecordInput): Promise<void> {
  const specific = recordRequest(input);
  await requestFirst(
    [
      { path: specific.path, init: { method: "POST", body: specific.body } },
      {
        path: "/api/records",
        init: { method: "POST", body: JSON.stringify(input) },
      },
    ],
    access,
  );
}
