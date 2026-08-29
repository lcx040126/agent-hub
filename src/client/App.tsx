import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clipboard,
  Clock3,
  Copy,
  FileCheck2,
  FileClock,
  FolderOpen,
  GitBranch,
  Handshake,
  History,
  KeyRound,
  Layers3,
  Link2,
  LoaderCircle,
  LogOut,
  Menu,
  Network,
  Plus,
  PencilLine,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  Users,
  X,
  XCircle,
  Settings,
  UserCog,
  Download,
  Upload,
} from "lucide-react";
import {
  ApiError,
  activateSavedConnection,
  clearSession,
  checkDesktopUpdate,
  chooseRepository,
  closeLease,
  createLease,
  createRecord,
  createRoom,
  deleteSavedConnection,
  downloadDesktopUpdate,
  getDashboard,
  getLeaseScopeEvents,
  getDesktopUpdateStatus,
  installDesktopUpdate,
  manageMember,
  transferOwnership,
  dissolveRoom,
  exportRoomContext,
  importRoomContext,
  resolveReleaseRequest,
  rebaselineSession,
  updateRoomSettings,
  getDesktopServerInfo,
  installCodexConnection,
  isDesktopApp,
  joinRoom,
  listSavedConnections,
  loadSession,
  renewLease,
  resumeSavedConnection,
  pauseSavedConnection,
  saveSession,
  secureDesktopSession,
  subscribeDesktopUpdateStatus,
  type ActivateRoomConnectionResult,
  type Conflict,
  type CreateLeaseInput,
  type CreateRecordInput,
  type Dashboard,
  type DesktopUpdateStatus,
  type DeleteRoomConnectionResult,
  type Lease,
  type LeaseScopeEvent,
  type ProjectRecord,
  type RecordKind,
  type ReleaseRequest,
  type RiskRule,
  type RoomSettings,
  type SavedRoomConnection,
  type Session,
} from "./api";
import { AGENT_HUB_PROTOCOL_VERSION } from "../shared/version";

type View = "work" | "records" | "connection" | "management";
type Notice = { tone: "success" | "warning" | "danger"; message: string };
type RecordModalKind = Exclude<RecordKind, "context">;
export type DashboardSyncState = "online" | "partial" | "offline" | "refresh_failed" | "unauthorized";
type DeleteConnectionTarget = Pick<
  SavedRoomConnection,
  "id" | "roomName" | "memberName" | "serverUrl" | "repositoryPath"
>;

export function classifyDashboardRefreshFailure(
  error: unknown,
): Exclude<DashboardSyncState, "online" | "partial"> {
  if (error instanceof ApiError) {
    if (error.status === 401) return "unauthorized";
    if (error.status === 0) return "offline";
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    message.includes("无法连接房主服务")
    || message.includes("could not reach the room server")
    || message.includes("failed to fetch")
    || message.includes("fetch failed")
    || message.includes("econnrefused")
    || message.includes("etimedout")
  ) return "offline";
  return "refresh_failed";
}

function dashboardRefreshErrorMessage(
  error: unknown,
  state: Exclude<DashboardSyncState, "online" | "partial">,
): string {
  if (state === "unauthorized") return "成员凭证已失效，请重新加入房间。";
  if (state === "offline") return "无法连接房主服务，请确认邀请地址正确且房主电脑在线。";
  const detail = error instanceof Error ? error.message : "房间状态加载失败。";
  return `房间仍保留最近一次同步内容，但团队数据刷新失败：${detail}`;
}

export function dashboardPartialRefreshMessage(sections: readonly string[]): string {
  const labels: Record<string, string> = {
    leases: "工作范围",
    conflicts: "冲突",
    releaseRequests: "交接申请",
    members: "成员",
    sessions: "Agent 会话",
    activity: "动态",
    records: "项目记录",
    settings: "风险规则",
  };
  const visible = [...new Set(sections)].map((section) => labels[section] ?? section);
  return `房间仍在线，但${visible.join("、")}达到轮询展示上限；完整内容仍保留在房间数据库和专用查询中。`;
}

export function dashboardSyncStateForPartialSections(
  sections: readonly string[],
): Extract<DashboardSyncState, "online" | "partial"> {
  // 动态和项目记录本来就是有界历史视图；只有协作安全状态不完整时才标记部分展示。
  const coordinationSections = new Set([
    "leases",
    "conflicts",
    "releaseRequests",
    "members",
    "sessions",
    "settings",
  ]);
  return sections.some((section) => coordinationSections.has(section)) ? "partial" : "online";
}

export function monitorModeUpgradeGuidance(members: Dashboard["members"]): string | null {
  const membersToUpgrade = members.filter((member) =>
    member.protocolVersion !== AGENT_HUB_PROTOCOL_VERSION
  );
  if (membersToUpgrade.length === 0) return null;
  const labels = membersToUpgrade.map((member) =>
    `${member.name}${member.clientVersion ? `（v${member.clientVersion}）` : "（未上报版本）"}`
  );
  return `关闭前请先让 ${labels.join("、")} 升级到支持协议 ${AGENT_HUB_PROTOCOL_VERSION} 的 Agent Hub 并重新连接。房间服务会在保存时再次校验。`;
}

export function roomSettingsErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError) || error.code !== "monitor_mode_upgrade_required") {
    return error instanceof Error ? error.message : "操作失败。";
  }
  const details = error.details && typeof error.details === "object"
    ? error.details as Record<string, unknown>
    : {};
  const requiredProtocolVersion = typeof details.requiredProtocolVersion === "number"
    ? details.requiredProtocolVersion
    : AGENT_HUB_PROTOCOL_VERSION;
  const members = Array.isArray(details.members) ? details.members : [];
  const labels = members.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const member = value as Record<string, unknown>;
    const name = typeof member.displayName === "string" && member.displayName.trim()
      ? member.displayName.trim()
      : "未识别成员";
    const version = typeof member.clientVersion === "string" && member.clientVersion.trim()
      ? `（v${member.clientVersion.trim()}）`
      : "（未上报版本）";
    return [`${name}${version}`];
  });
  const subject = labels.length > 0 ? labels.join("、") : "房间中的未升级成员";
  return `开启纯监测模式前，请先让 ${subject} 升级到支持协议 ${requiredProtocolVersion} 的 Agent Hub 并重新连接。房间服务已拒绝本次切换。`;
}

export type DashboardModal =
  | { type: "claim" }
  | { type: "close"; lease: Lease }
  | { type: "record"; recordKind: RecordModalKind }
  | { type: "replace-decision"; decision: ProjectRecord }
  | { type: "release"; requestId: string };

export function decisionReplacementConflictRecovery(
  error: unknown,
  refreshSucceeded: boolean,
): { closeModal: true; notice: Notice } | null {
  if (!(error instanceof ApiError) || error.code !== "decision_already_superseded") return null;
  return {
    closeModal: true,
    notice: {
      tone: "warning",
      message: refreshSucceeded
        ? "这条决定已被其他成员更新。当前决定已刷新，请基于最新决定重新操作。"
        : "这条决定已被其他成员更新，但当前决定刷新失败。请恢复连接并刷新后再操作。",
    },
  };
}

export function nextPendingReleaseRequestId(
  activeModal: DashboardModal | null,
  requests: ReadonlyArray<Pick<ReleaseRequest, "id" | "status" | "holderMemberId">>,
  currentMemberId: string,
  dismissedRequestIds: ReadonlySet<string>,
): string | undefined {
  if (activeModal) return undefined;
  return requests.find((request) =>
    request.status === "pending"
    && request.holderMemberId === currentMemberId
    && !dismissedRequestIds.has(request.id)
  )?.id;
}

export function noticeForActivatedConnection(
  activation: Pick<ActivateRoomConnectionResult, "pausedConnectionIds" | "warnings"> | null | undefined,
): Notice | null {
  if (!activation) return null;
  const messages: string[] = [];
  if (activation.pausedConnectionIds.length > 0) {
    messages.push(`已暂停同一项目的 ${activation.pausedConnectionIds.length} 个旧房间连接。`);
  }
  if (activation.warnings.length > 0) messages.push(...activation.warnings);
  if (messages.length === 0) return null;
  return {
    tone: activation.warnings.length > 0 ? "warning" : "success",
    message: messages.join(" "),
  };
}

const RISK_CATEGORY_LABELS: Record<string, string> = {
  repository_scope: "整个仓库",
  normal_source: "普通源码",
  unity_scene_prefab: "Unity 场景与 Prefab",
  unity_serialized: "Unity 序列化资源",
  project_settings: "项目设置",
  git_ci: "Git 与 CI",
  structured_config: "结构化配置",
  luban: "Luban 表与生成内容",
  other: "其他文件",
};

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatDate(value?: string, withDate = false): string {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: withDate ? "numeric" : undefined,
    day: withDate ? "numeric" : undefined,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatLeaseExpiryCountdown(value: string | undefined, now = Date.now()): string {
  if (!value) return "到期时间未知";
  const expiresAt = Date.parse(value);
  if (!Number.isFinite(expiresAt)) return "到期时间未知";
  const remainingSeconds = Math.ceil((expiresAt - now) / 1_000);
  if (remainingSeconds <= 0) return "保护已到期";
  const hours = Math.floor(remainingSeconds / 3_600);
  const minutes = Math.floor((remainingSeconds % 3_600) / 60);
  const seconds = remainingSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${String(minutes).padStart(2, "0")} 分 ${String(seconds).padStart(2, "0")} 秒后到期`;
  if (minutes > 0) return `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒后到期`;
  return `${seconds} 秒后到期`;
}

export function dashboardClockOffsetMs(
  generatedAt: string | undefined,
  localObservedAt = Date.now(),
): number {
  if (!generatedAt) return 0;
  const serverObservedAt = Date.parse(generatedAt);
  return Number.isFinite(serverObservedAt) ? serverObservedAt - localObservedAt : 0;
}

function shortCommit(value?: string): string {
  if (!value) return "未记录";
  return value.length > 10 ? value.slice(0, 10) : value;
}

function getSystemName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const lower = parts.map((item) => item.toLowerCase());
  if (lower.includes("luban")) return "Luban 数据";
  if (lower[0] === "projectsettings") return "项目设置";
  if (lower[0] === ".github") return "自动化流程";
  if (lower[0] === "assets") {
    if (lower[1] === "vanguard" && parts[2]) return parts[2];
    if (lower[1] === "scripts" && parts[2]) return parts[2];
    if (parts[1]) return parts[1];
  }
  return parts[0] || "整个项目";
}

export function isValidLease(
  lease: Pick<Lease, "status" | "expiresAt">,
  now = Date.now(),
): boolean {
  if (lease.status !== "active" || !lease.expiresAt) return false;
  const expiresAt = Date.parse(lease.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function isAwaitingCommitLease(
  lease: Pick<Lease, "kind" | "phase">,
): boolean {
  return lease.kind === "automatic" && lease.phase === "awaiting_commit";
}

export function isBlockedLease(lease: Pick<Lease, "kind" | "phase">): boolean {
  return lease.kind === "automatic" && lease.phase === "blocked";
}

export function splitVisibleLeases(
  leases: readonly Lease[],
  now = Date.now(),
): { working: Lease[]; waiting: Lease[]; blocked: Lease[]; awaitingCommit: Lease[] } {
  const working: Lease[] = [];
  const waiting: Lease[] = [];
  const blocked: Lease[] = [];
  const awaitingCommit: Lease[] = [];
  for (const lease of leases) {
    if (!isValidLease(lease, now)) continue;
    if (lease.phase === "waiting") waiting.push(lease);
    else if (isBlockedLease(lease)) blocked.push(lease);
    else if (isAwaitingCommitLease(lease)) awaitingCommit.push(lease);
    else working.push(lease);
  }
  return { working, waiting, blocked, awaitingCommit };
}

export type ProtectedSystem = {
  name: string;
  paths: Set<string>;
  members: Set<string>;
  highRisk: boolean;
};

export function protectedSystemsForDashboard(
  dashboard: Pick<Dashboard, "leases">,
  now = Date.now(),
): ProtectedSystem[] {
  const map = new Map<string, Omit<ProtectedSystem, "name">>();
  for (const lease of dashboard.leases) {
    if (!isValidLease(lease, now)) continue;
    for (const path of lease.paths.length ? lease.paths : ["整个项目"]) {
      const name = getSystemName(path);
      const item = map.get(name) ?? { paths: new Set<string>(), members: new Set<string>(), highRisk: false };
      item.paths.add(path);
      item.members.add(lease.memberName);
      item.highRisk ||= lease.highRiskPaths.includes(path);
      map.set(name, item);
    }
  }
  return [...map.entries()].map(([name, item]) => ({ name, ...item }));
}

function recordLabel(kind: RecordKind): string {
  return {
    decision: "决定",
    validation: "验证",
    handoff: "交接",
    risk: "风险",
    context: "项目上下文",
  }[kind];
}

function statusLabel(value: string): string {
  return {
    accepted: "已确认",
    current: "当前决定",
    superseded: "已替代",
    passed: "通过",
    failed: "失败",
    pending: "待验证",
    open: "待跟进",
    active: "进行中",
    completed: "已完成",
    cancelled: "已取消",
    released: "已释放",
    reported: "已记录",
    risk: "风险",
    rule: "规则",
    architecture: "架构",
    note: "备注",
    dependency: "依赖",
  }[value] ?? value;
}

function recordIcon(kind: RecordKind): ReactNode {
  if (kind === "decision") return <CheckCircle2 aria-hidden="true" />;
  if (kind === "validation") return <FileCheck2 aria-hidden="true" />;
  if (kind === "handoff") return <Handshake aria-hidden="true" />;
  if (kind === "risk") return <AlertTriangle aria-hidden="true" />;
  return <Layers3 aria-hidden="true" />;
}

export function isCurrentDecision(record: Pick<ProjectRecord, "kind" | "status">): boolean {
  // 旧版本使用 accepted，缺失状态的快照也代表尚未被替代；只排除明确失效的决定。
  return record.kind === "decision" && record.status !== "superseded";
}

export function visibleProjectRecords(records: readonly ProjectRecord[]): ProjectRecord[] {
  return records.filter((record) => record.kind !== "decision" || isCurrentDecision(record));
}

export function decisionHistoryFor(
  records: readonly ProjectRecord[],
  currentDecisionId: string,
): ProjectRecord[] {
  return decisionHistoryStateFor(records, currentDecisionId).records;
}

export function decisionHistoryStateFor(
  records: readonly ProjectRecord[],
  currentDecisionId: string,
): { records: ProjectRecord[]; incomplete: boolean } {
  const decisions = new Map(
    records
      .filter((record) => record.kind === "decision" && record.id)
      .map((record) => [record.id, record] as const),
  );
  const history: ProjectRecord[] = [];
  const visited = new Set<string>();
  let incomplete = false;
  let decision = decisions.get(currentDecisionId);
  while (decision && !visited.has(decision.id)) {
    history.push(decision);
    visited.add(decision.id);
    if (!decision.supersedesDecisionId || visited.has(decision.supersedesDecisionId)) break;
    const predecessor = decisions.get(decision.supersedesDecisionId);
    if (!predecessor) {
      incomplete = true;
      break;
    }
    decision = predecessor;
  }
  return { records: history, incomplete };
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function IconButton({
  label,
  children,
  onClick,
  disabled,
  className = "",
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}

function EmptyState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function Modal({
  title,
  detail,
  children,
  onClose,
  closeDisabled = false,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
  onClose: () => void;
  closeDisabled?: boolean;
}) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !closeDisabled) onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [closeDisabled, onClose]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={() => { if (!closeDisabled) onClose(); }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {detail && <p>{detail}</p>}
          </div>
          <IconButton label="关闭" onClick={onClose} disabled={closeDisabled}>
            <X aria-hidden="true" />
          </IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}

export function SavedConnectionList({
  connections,
  openingConnectionId,
  deletingConnectionId,
  notice,
  onOpen,
  onDelete,
}: {
  connections: SavedRoomConnection[];
  openingConnectionId?: string;
  deletingConnectionId?: string;
  notice?: { connectionId: string; notice: Notice } | null;
  onOpen: (connection: SavedRoomConnection) => void;
  onDelete: (connection: SavedRoomConnection) => void;
}) {
  return (
    <div className="saved-connection-list">
      {connections.map((connection) => {
        const roomLabel = connection.roomName || "项目协作房间";
        const opening = openingConnectionId === connection.id;
        const deleting = deletingConnectionId === connection.id;
        const rowBusy = opening || deleting;
        const rowNotice = notice?.connectionId === connection.id ? notice.notice : null;
        return (
          <div className="saved-connection-item" key={connection.id}>
            <div className="saved-connection-row">
              <button
                type="button"
                className="saved-connection-open"
                onClick={() => onOpen(connection)}
                disabled={rowBusy}
                aria-label={`打开${roomLabel}`}
              >
                <span><Server aria-hidden="true" /></span>
                <div>
                  <strong>{roomLabel}</strong>
                  <small>{connection.memberName || "已保存成员"} · {connection.integrationEnabled === false ? "接入已暂停，点击恢复" : connection.serverUrl}</small>
                </div>
                {opening ? <LoaderCircle className="spin" aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
              </button>
              <IconButton
                label={`从本机移除${roomLabel}`}
                className="saved-connection-delete"
                onClick={() => onDelete(connection)}
                disabled={rowBusy}
              >
                {deleting ? <LoaderCircle className="spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
              </IconButton>
            </div>
            {rowNotice && (
              <div className={`saved-connection-feedback ${rowNotice.tone}`} role="status">
                <AlertTriangle aria-hidden="true" />
                <span>{rowNotice.message}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function DeleteConnectionModal({
  connection,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  connection: DeleteConnectionTarget;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const roomLabel = connection.roomName || "项目协作房间";
  return (
    <Modal
      title={`从本机移除“${roomLabel}”`}
      detail="此操作只清理当前电脑保存的连接，不是解散或删除远端房间。"
      onClose={onClose}
      closeDisabled={busy}
    >
      <form
        className="modal-form delete-connection-form"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <div className="delete-connection-summary">
          <Server aria-hidden="true" />
          <div>
            <strong>{roomLabel}</strong>
            <span>{connection.memberName || "已保存成员"}</span>
            <code>{connection.repositoryPath || connection.serverUrl}</code>
          </div>
        </div>
        <div className="delete-connection-scope">
          <p><strong>只从这台电脑移除。</strong>将删除本机保存记录、加密成员凭证、Hook 会话和本地接入数据。</p>
          <p><strong>不会删除远端房间或团队记录。</strong>共享记录、功能记忆、其他成员数据和房主数据库都会保留。</p>
          <p>如果房间服务离线，本机删除仍会完成；远端会话或租约可能需要等待房间服务按过期规则自然清理。</p>
        </div>
        {error && <div className="form-error" role="alert"><AlertTriangle aria-hidden="true" />{error}</div>}
        <div className="modal-actions">
          <button type="button" className="text-button" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="primary-button danger-action-button" disabled={busy}>
            {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
            {busy ? "正在移除" : "从本机移除"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function EntryScreen({
  onConnected,
  onRequestDelete = () => undefined,
  deletingConnectionId,
  connectionsRevision = 0,
  initialNotice = null,
}: {
  onConnected: (session: Session, notice?: Notice | null) => void;
  onRequestDelete?: (connection: SavedRoomConnection) => void;
  deletingConnectionId?: string;
  connectionsRevision?: number;
  initialNotice?: Notice | null;
}) {
  const desktop = isDesktopApp();
  const [mode, setMode] = useState<"create" | "join">("create");
  const [busy, setBusy] = useState(false);
  const [repoBusy, setRepoBusy] = useState(false);
  const [error, setError] = useState("");
  const [updateNotice, setUpdateNotice] = useState<Notice | null>(initialNotice);
  const [repositoryPath, setRepositoryPath] = useState("");
  const [savedConnections, setSavedConnections] = useState<SavedRoomConnection[]>([]);
  const [openingConnectionId, setOpeningConnectionId] = useState<string>();
  const [savedConnectionNotice, setSavedConnectionNotice] = useState<{
    connectionId: string;
    notice: Notice;
  } | null>(null);
  const [createValues, setCreateValues] = useState({
    roomName: "",
    projectName: "",
    repository: "",
    defaultBranch: "main",
    ownerName: "",
  });
  const [joinValues, setJoinValues] = useState({
    serverUrl: desktop ? "" : window.location.origin,
    roomToken: "",
    memberName: "",
  });

  useEffect(() => {
    if (!desktop) return;
    void listSavedConnections()
      .then(setSavedConnections)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "无法读取已保存的房间。"));
  }, [connectionsRevision, desktop]);

  useEffect(() => {
    if (initialNotice) setUpdateNotice(initialNotice);
  }, [initialNotice]);

  useEffect(() => {
    if (!updateNotice) return;
    const timeout = window.setTimeout(() => setUpdateNotice(null), 3500);
    return () => window.clearTimeout(timeout);
  }, [updateNotice]);

  const selectRepository = async () => {
    setRepoBusy(true);
    setError("");
    try {
      const selected = await chooseRepository();
      if (!selected) return;
      setRepositoryPath(selected.path);
      setCreateValues((current) => ({
        ...current,
        projectName: current.projectName || selected.snapshot.repository.name,
        repository:
          selected.snapshot.repository.remote ||
          `urn:agent-hub:repository:${selected.snapshot.repository.fingerprint}`,
        defaultBranch:
          selected.snapshot.repository.branch === "(detached)"
            ? current.defaultBranch
            : selected.snapshot.repository.branch,
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法读取所选项目。 ");
    } finally {
      setRepoBusy(false);
    }
  };

  const enterSession = (session: Session, notice?: Notice | null) => {
    saveSession(session);
    onConnected(session, notice);
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (desktop && !repositoryPath) {
      setError("请先选择本机 Git 项目。 ");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let session = await createRoom({ ...createValues, agent: "Codex" });
      let activationNotice: Notice | null = null;
      if (desktop) {
        const secured = await secureDesktopSession(session, session.serverUrl!, repositoryPath);
        session = secured.session;
        activationNotice = noticeForActivatedConnection(secured.activation);
      }
      enterSession(session, activationNotice);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "房间创建失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const submitJoin = async (event: FormEvent) => {
    event.preventDefault();
    if (desktop && !repositoryPath) {
      setError("请先选择要协作的本机 Git 项目。 ");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let session = await joinRoom({ ...joinValues, agent: "Codex" });
      let activationNotice: Notice | null = null;
      if (desktop) {
        const secured = await secureDesktopSession(session, joinValues.serverUrl, repositoryPath);
        session = secured.session;
        activationNotice = noticeForActivatedConnection(secured.activation);
      }
      enterSession(session, activationNotice);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加入失败，请检查邀请地址和房间码。");
    } finally {
      setBusy(false);
    }
  };

  const openSaved = (connection: SavedRoomConnection) => {
    setOpeningConnectionId(connection.id);
    setSavedConnectionNotice(null);
    void activateSavedConnection(connection.id)
      .then((activated) => {
        const next = activated?.connection ?? connection;
        if (activated) {
          const paused = new Set(activated.pausedConnectionIds);
          setSavedConnections((current) => current.map((item) => {
            if (item.id === next.id) return next;
            return paused.has(item.id) ? { ...item, integrationEnabled: false } : item;
          }));
        }
        enterSession(
          resumeSavedConnection(next),
          noticeForActivatedConnection(activated),
        );
      })
      .catch((caught) => setSavedConnectionNotice({
        connectionId: connection.id,
        notice: {
          tone: "danger",
          message: caught instanceof Error ? caught.message : "无法恢复房间连接。",
        },
      }))
      .finally(() => setOpeningConnectionId(undefined));
  };

  const repositoryPicker = desktop && (
    <div className="repository-picker">
      <div>
        <span>本机项目</span>
        <strong>{repositoryPath || "尚未选择 Git 项目"}</strong>
      </div>
      <button type="button" className="secondary-button" onClick={() => void selectRepository()} disabled={repoBusy}>
        {repoBusy ? <LoaderCircle className="spin" aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}
        {repositoryPath ? "更换" : "选择项目"}
      </button>
    </div>
  );

  return (
    <main className="entry-shell">
      <section className="entry-brand" aria-label="Agent Hub">
        <div className="brand-mark large" aria-hidden="true"><Network /></div>
        <div className="entry-brand-copy">
          <span className="eyebrow">AGENT HUB</span>
          <h1>让团队 Agent 共享同一份项目现场</h1>
          <p>创建或加入房间后，工作范围、系统影响与验证状态会在后台自动同步。</p>
        </div>
        <div className="entry-flow" aria-label="协作流程">
          <span><Check aria-hidden="true" /> 自动识别进行中的工作</span>
          <span><Check aria-hidden="true" /> 在改动相互影响时提前预警</span>
          <span><Check aria-hidden="true" /> 保留决定、验证和交接结果</span>
        </div>
      </section>

      <section className="entry-panel">
        <div className="entry-panel-inner">
          {desktop && (
            <section className="entry-update-control" aria-label="软件更新">
              <DesktopUpdateControl onNotice={(message, tone = "success") => setUpdateNotice({ message, tone })} />
            </section>
          )}
          {desktop && savedConnections.length > 0 && (
            <section className="saved-connections" aria-labelledby="saved-title">
              <div><span className="section-kicker">快速返回</span><h2 id="saved-title">已保存的房间</h2></div>
              <SavedConnectionList
                connections={savedConnections}
                openingConnectionId={openingConnectionId}
                deletingConnectionId={deletingConnectionId}
                notice={savedConnectionNotice}
                onOpen={openSaved}
                onDelete={onRequestDelete}
              />
            </section>
          )}

          <div className="segmented-control" aria-label="进入方式">
            <button type="button" className={mode === "create" ? "active" : ""} onClick={() => { setMode("create"); setError(""); }}>创建房间</button>
            <button type="button" className={mode === "join" ? "active" : ""} onClick={() => { setMode("join"); setError(""); }}>加入房间</button>
          </div>

          {mode === "create" ? (
            <form className="entry-form" onSubmit={submitCreate}>
              <div className="form-heading"><h2>创建项目协作房间</h2><p>房主电脑保持 Agent Hub 服务运行，成员即可持续同步。</p></div>
              {repositoryPicker}
              <div className="field-grid two-columns">
                <Field label="房间名称"><input required maxLength={80} placeholder="例如：先锋项目开发组" value={createValues.roomName} onChange={(event) => setCreateValues({ ...createValues, roomName: event.target.value })} /></Field>
                <Field label="你的称呼"><input required maxLength={60} placeholder="团队中显示的名字" value={createValues.ownerName} onChange={(event) => setCreateValues({ ...createValues, ownerName: event.target.value })} /></Field>
              </div>
              <Field label="项目名称"><input required maxLength={100} placeholder="例如：Project Vanguard" value={createValues.projectName} onChange={(event) => setCreateValues({ ...createValues, projectName: event.target.value })} /></Field>
              {!desktop && <Field label="Git 仓库地址" hint="用于确认每位成员加入的是同一个项目，不会上传源码。"><input required type="url" placeholder="https://github.com/your-team/project.git" value={createValues.repository} onChange={(event) => setCreateValues({ ...createValues, repository: event.target.value })} /></Field>}
              <Field label="团队默认分支"><input required maxLength={120} value={createValues.defaultBranch} onChange={(event) => setCreateValues({ ...createValues, defaultBranch: event.target.value })} /></Field>
              {error && <div className="form-error"><AlertTriangle aria-hidden="true" />{error}</div>}
              <button className="primary-button full-width" type="submit" disabled={busy || repoBusy}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Network aria-hidden="true" />}创建并进入{!busy && <ArrowRight aria-hidden="true" />}</button>
            </form>
          ) : (
            <form className="entry-form" onSubmit={submitJoin}>
              <div className="form-heading"><h2>加入现有房间</h2><p>粘贴房主发来的邀请地址和房间码，当前协作现场会自动同步。</p></div>
              {repositoryPicker}
              <Field label="房主邀请地址" hint="与房主在同一局域网时，使用房主提供的 http 地址。"><input required type="url" inputMode="url" placeholder="http://192.168.1.10:4173" value={joinValues.serverUrl} onChange={(event) => setJoinValues({ ...joinValues, serverUrl: event.target.value.trim() })} /></Field>
              <Field label="房间码"><input className="code-input" required autoComplete="off" placeholder="粘贴邀请房间码" value={joinValues.roomToken} onChange={(event) => setJoinValues({ ...joinValues, roomToken: event.target.value.trim() })} /></Field>
              <Field label="你的称呼"><input required maxLength={60} placeholder="团队中显示的名字" value={joinValues.memberName} onChange={(event) => setJoinValues({ ...joinValues, memberName: event.target.value })} /></Field>
              {error && <div className="form-error"><AlertTriangle aria-hidden="true" />{error}</div>}
              <button className="primary-button full-width" type="submit" disabled={busy || repoBusy}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Users aria-hidden="true" />}加入房间{!busy && <ArrowRight aria-hidden="true" />}</button>
            </form>
          )}
        </div>
      </section>
      {updateNotice && <div className={`toast ${updateNotice.tone}`} role="status">{updateNotice.tone === "success" ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}<span>{updateNotice.message}</span><IconButton label="关闭提示" onClick={() => setUpdateNotice(null)}><X aria-hidden="true" /></IconButton></div>}
    </main>
  );
}

function AppNav({ view, onChange, open, onClose, blockingProtectionEnabled }: { view: View; onChange: (view: View) => void; open: boolean; onClose: () => void; blockingProtectionEnabled: boolean }) {
  const items: Array<{ id: View; label: string; icon: ReactNode }> = [
    { id: "work", label: "当前协作", icon: <Activity aria-hidden="true" /> },
    { id: "records", label: "团队记录", icon: <FileClock aria-hidden="true" /> },
    { id: "management", label: "房间管理", icon: <UserCog aria-hidden="true" /> },
    { id: "connection", label: "连接设置", icon: <Link2 aria-hidden="true" /> },
  ];
  return (
    <>
      {open && <button type="button" className="nav-scrim" aria-label="关闭导航" onClick={onClose} />}
      <aside className={`side-nav ${open ? "open" : ""}`}>
        <nav aria-label="主要导航">
          {items.map((item) => (
            <button
              type="button"
              key={item.id}
              className={view === item.id ? "active" : ""}
              onClick={() => {
                onChange(item.id);
                onClose();
              }}
            >
              {item.icon}
              <span>{item.label}</span>
              <ChevronRight className="nav-chevron" aria-hidden="true" />
            </button>
          ))}
        </nav>
        <div className={`automation-note ${blockingProtectionEnabled ? "" : "monitoring"}`}>
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>{blockingProtectionEnabled ? "写入保护已开启" : "纯监测模式"}</strong>
            <span>{blockingProtectionEnabled ? "日常无需手动维护范围" : "自动与普通范围只记录风险"}</span>
          </div>
        </div>
      </aside>
    </>
  );
}

export function ManagementView({ dashboard, session, onRefresh, onNotice }: { dashboard: Dashboard; session: Session; onRefresh: () => Promise<void>; onNotice: (message: string, tone?: Notice["tone"]) => void }) {
  const canManageMembers = dashboard.currentMember.role === "host" || dashboard.currentMember.isAdmin;
  const isOwner = dashboard.currentMember.role === "host";
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<RoomSettings>(dashboard.settings);
  useEffect(() => setSettings(dashboard.settings), [dashboard.settings.updatedAt, dashboard.settings.riskPolicyVersion]);

  const run = async (operation: () => Promise<void>, success: string) => {
    setBusy(true);
    try {
      await operation();
      onNotice(success);
      await onRefresh();
    } catch (error) {
      onNotice(roomSettingsErrorMessage(error), "danger");
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    const payload = await exportRoomContext(session);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${dashboard.room.name}-context.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    onNotice("房间上下文已导出。");
  };
  const updateRule = (index: number, next: Partial<RiskRule>) => {
    setSettings((current) => ({
      ...current,
      riskRules: current.riskRules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...next } : rule),
    }));
  };
  const categoryRules = settings.riskRules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.kind === "category");
  const customRules = settings.riskRules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.kind !== "category");
  const upgradeGuidance = dashboard.settings.blockingProtectionEnabled
    ? monitorModeUpgradeGuidance(dashboard.members)
    : null;
  const saveSettings = () => run(
    () => updateRoomSettings(session, {
      blockingProtectionEnabled: settings.blockingProtectionEnabled,
      automaticLeaseTtlMinutes: settings.automaticLeaseTtlMinutes,
      maximumExclusiveLeaseMinutes: settings.maximumExclusiveLeaseMinutes,
      riskRules: settings.riskRules,
    }).then(() => undefined),
    "房间保护策略已保存。",
  );

  return (
    <div className="content-grid wide-main">
      <section className="section-block" aria-labelledby="management-title">
        <div className="section-heading">
          <div><span className="section-kicker">房间设置</span><h2 id="management-title">保护策略与租期</h2></div>
          <span className="quiet-count">策略 v{settings.riskPolicyVersion}</span>
        </div>
        <div className="management-settings">
          {upgradeGuidance && <div className="monitor-upgrade-guidance" role="status"><AlertTriangle aria-hidden="true" /><span><strong>切换前需要成员升级</strong><small>{upgradeGuidance}</small></span></div>}
          <label className="toggle-row">
            <span><strong>写入阻塞保护</strong><small>关闭后，自动与普通范围进入纯监测：黄色普通警告、红色高风险警告都只记录；其他成员的手动独占范围仍需持有人批准。</small></span>
            <input type="checkbox" checked={settings.blockingProtectionEnabled} disabled={!isOwner || busy} onChange={(event) => setSettings({ ...settings, blockingProtectionEnabled: event.target.checked, autoLockAfterAutoClaim: event.target.checked })} />
          </label>
          <div className="setting-row">
            <span><strong>自动与普通租期</strong><small>Agent 持续工作时会按心跳续期，停止后按这里的时间释放。</small></span>
            <div className="segmented-control compact">
              {([5, 10, 15, 30, 60] as const).map((minutes) => (
                <button type="button" key={minutes} disabled={!isOwner || busy} className={settings.automaticLeaseTtlMinutes === minutes ? "active" : ""} onClick={() => setSettings({ ...settings, automaticLeaseTtlMinutes: minutes })}>{minutes} 分钟</button>
              ))}
            </div>
          </div>
          <label className="setting-row">
            <span><strong>手动独占最大租期</strong><small>成员仍可选择更短时长，独占租期不会随 Agent 心跳自动延长。</small></span>
            <span className="number-setting"><input type="number" min={5} max={10080} step={5} value={settings.maximumExclusiveLeaseMinutes} disabled={!isOwner || busy} onChange={(event) => setSettings({ ...settings, maximumExclusiveLeaseMinutes: Math.max(5, Number(event.target.value) || 5) })} />分钟</span>
          </label>
        </div>

        <div className="subsection-heading"><div><strong>文件重叠规则</strong><small>黄色表示普通警告，红色表示高风险；红色本身不等于已阻止。</small></div></div>
        <div className="risk-rule-list">
          {categoryRules.map(({ rule, index }) => (
            <div className="risk-rule-row" key={rule.selector}>
              <span><strong>{RISK_CATEGORY_LABELS[rule.selector] ?? rule.selector}</strong><small>预设分类</small></span>
              <div className="segmented-control compact">
                <button type="button" disabled={!isOwner || busy} className={rule.level === "warning" ? "active warning" : ""} onClick={() => updateRule(index, { level: "warning" })}>黄色警告</button>
                <button type="button" disabled={!isOwner || busy} className={rule.level === "blocking" ? "active danger" : ""} onClick={() => updateRule(index, { level: "blocking" })}>红色高风险</button>
              </div>
            </div>
          ))}
          {customRules.map(({ rule, index }) => (
            <div className="risk-rule-row custom" key={`${rule.kind}-${index}`}>
              <select aria-label="规则类型" value={rule.kind} disabled={!isOwner || busy} onChange={(event) => updateRule(index, { kind: event.target.value as RiskRule["kind"] })}>
                <option value="extension">扩展名</option><option value="file">具体文件</option><option value="directory">目录</option>
              </select>
              <input aria-label="匹配内容" value={rule.selector} disabled={!isOwner || busy} placeholder={rule.kind === "extension" ? ".cs" : "Assets/Vanguard/Inventory"} onChange={(event) => updateRule(index, { selector: event.target.value })} />
              <select aria-label="处理方式" value={rule.level} disabled={!isOwner || busy} onChange={(event) => updateRule(index, { level: event.target.value as RiskRule["level"] })}>
                <option value="warning">黄色警告</option><option value="blocking">红色高风险</option>
              </select>
              {isOwner && <IconButton label="删除这条规则" disabled={busy} onClick={() => setSettings((current) => ({ ...current, riskRules: current.riskRules.filter((_, ruleIndex) => ruleIndex !== index) }))}><X aria-hidden="true" /></IconButton>}
            </div>
          ))}
        </div>
        {isOwner && (
          <div className="management-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setSettings((current) => ({ ...current, riskRules: [...current.riskRules, { kind: "extension", selector: ".cs", level: "warning" }] }))}><Plus aria-hidden="true" />添加自定义规则</button>
            <button type="button" className="text-button" disabled={busy} onClick={() => void run(() => updateRoomSettings(session, { resetRiskPolicy: true }).then(() => undefined), "默认文件规则已恢复。")}>恢复默认规则</button>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void saveSettings()}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}保存保护策略</button>
          </div>
        )}
        {!isOwner && <p className="automation-caption"><CircleHelp aria-hidden="true" />当前规则由房主维护，你可以查看但不能修改。</p>}

        <div className="subsection-heading"><div><strong>共享上下文</strong><small>用于迁移或备份房间记录，不会导出成员私密聊天。</small></div></div>
        <div className="management-actions">
          <button type="button" className="secondary-button" onClick={() => void download()}><Download aria-hidden="true" />导出上下文</button>
          <label className="secondary-button">
            <Upload aria-hidden="true" />导入上下文
            <input type="file" accept="application/json" hidden onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void file.text().then((text) => {
                try {
                  return run(() => importRoomContext(session, JSON.parse(text)).then(() => undefined), "上下文已追加导入。");
                } catch (error) {
                  onNotice(error instanceof Error ? error.message : "导入文件格式不正确。", "danger");
                }
              });
            }} />
          </label>
        </div>

        {canManageMembers && <div className="subsection-heading"><div><strong>成员管理</strong><small>成员版本不兼容时应先完成客户端更新。</small></div></div>}
        {canManageMembers && <div className="member-management-list">
          {dashboard.members.map((member) => (
            <div className="member-management-row" key={member.id}>
              <div><strong>{member.name}</strong><small>{member.role === "host" ? "房主" : member.isAdmin ? "管理员" : "成员"} · {member.clientVersion ? `v${member.clientVersion}` : "未上报版本"} · {compatibilityLabel(member.compatibility)}</small></div>
              {member.id !== dashboard.currentMember.id && member.role !== "host" && (
                <div className="member-management-actions">
                  {isOwner && <button type="button" className="text-button" disabled={busy} onClick={() => void run(() => manageMember(session, member.id, "admin", !member.isAdmin), member.isAdmin ? "管理员权限已撤销。" : "管理员权限已授予。")}>{member.isAdmin ? "撤销管理员" : "设为管理员"}</button>}
                  {(isOwner || (!member.isAdmin && dashboard.currentMember.isAdmin)) && <button type="button" className="text-button danger" disabled={busy} onClick={() => void run(() => manageMember(session, member.id, "remove"), "成员已移出房间。")}>踢出</button>}
                  {isOwner && <button type="button" className="text-button" disabled={busy} onClick={() => void run(() => transferOwnership(session, member.id), "房主已交接。")}>交接房主</button>}
                </div>
              )}
            </div>
          ))}
        </div>}
        {canManageMembers && <div className="member-management-list">
          {dashboard.sessions.filter((item) => item.status === "frozen" && isVisibleAgentSession(item)).map((item) => (
            <div className="member-management-row" key={item.id}>
              <div><strong>会话已冻结</strong><small>{item.branch || "新分支"} · {item.baseCommit || "未记录基线"}</small></div>
              <button type="button" className="text-button" disabled={busy} onClick={() => void run(() => rebaselineSession(session, item.id, item.branch || dashboard.room.defaultBranch, item.baseCommit || "0000000"), "会话已重新建立基线。")}>重新建立基线</button>
            </div>
          ))}
        </div>}
        {isOwner && <button type="button" className="danger-button" disabled={busy} onClick={() => { if (window.confirm("确定解散房间吗？")) void run(() => dissolveRoom(session), "房间已解散。"); }}><XCircle aria-hidden="true" />解散房间</button>}
      </section>
    </div>
  );
}

function compatibilityLabel(value: Dashboard["members"][number]["compatibility"]): string {
  if (value === "compatible") return "版本兼容";
  if (value === "incompatible") return "需要更新";
  return "版本未知";
}

function isVisibleAgentSession(session: Pick<Dashboard["sessions"][number], "agentName">): boolean {
  return session.agentName?.trim().toLocaleLowerCase("en-US") !== "background repository scanner";
}

export function isRealtimeAgentSession(
  session: Pick<Dashboard["sessions"][number], "agentName" | "lastSeenAt" | "status" | "turnStoppedAt">,
  now = Date.now(),
): boolean {
  if (session.status !== "active" || session.turnStoppedAt || !isVisibleAgentSession(session)) {
    return false;
  }
  if (!session.lastSeenAt) return false;
  const lastSeenAt = Date.parse(session.lastSeenAt);
  return Number.isFinite(lastSeenAt) && lastSeenAt > now - 5 * 60_000;
}

function formatBytes(value?: number): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB"];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function DesktopUpdateControl({ onNotice }: { onNotice: (message: string, tone?: Notice["tone"]) => void }) {
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState<string>();

  useEffect(() => {
    if (!isDesktopApp()) return;
    let active = true;
    void getDesktopUpdateStatus()
      .then((nextStatus) => { if (active) setStatus(nextStatus); })
      .catch(() => undefined);
    const unsubscribe = subscribeDesktopUpdateStatus((nextStatus) => {
      if (active) setStatus(nextStatus);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  if (!status || status.phase === "disabled") return null;

  const check = async () => {
    setBusy(true);
    try {
      const nextStatus = await checkDesktopUpdate();
      setStatus(nextStatus);
      if (nextStatus.phase === "up-to-date") onNotice(`当前已是最新版 v${nextStatus.currentVersion}。`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "更新检查失败。", "danger");
    } finally {
      setBusy(false);
    }
  };

  const updateNow = async () => {
    setBusy(true);
    try {
      let nextStatus = status;
      if (nextStatus.phase === "available") nextStatus = await downloadDesktopUpdate();
      if (nextStatus.phase === "ready") await installDesktopUpdate();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "更新失败，当前版本未被替换。", "danger");
    } finally {
      setBusy(false);
    }
  };

  const availableVersion = status.availableVersion;
  const isAvailable = status.phase === "available" || status.phase === "downloading" || status.phase === "ready";
  if (isAvailable && dismissedVersion === availableVersion) {
    return (
      <div className="update-reminder" role="status">
        <Download aria-hidden="true" />
        <span>Agent Hub v{availableVersion} 可以更新</span>
        <button type="button" className="text-button" onClick={() => setDismissedVersion(undefined)}>查看</button>
      </div>
    );
  }

  if (isAvailable || status.phase === "installing" || status.phase === "failed") {
    const progress = Math.round(status.progressPercent ?? 0);
    return (
      <section className={`desktop-update-banner ${status.phase === "failed" ? "failed" : ""}`} aria-live="polite">
        <div className="desktop-update-icon">
          {status.phase === "downloading" || status.phase === "installing"
            ? <LoaderCircle className="spin" aria-hidden="true" />
            : status.phase === "failed"
              ? <AlertTriangle aria-hidden="true" />
              : <Download aria-hidden="true" />}
        </div>
        <div className="desktop-update-copy">
          <strong>
            {status.phase === "failed"
              ? "软件更新未完成"
              : status.phase === "downloading"
                ? `正在下载 v${availableVersion}`
                : status.phase === "ready"
                  ? `v${availableVersion} 已通过校验`
                  : status.phase === "installing"
                    ? "正在安装并重新启动"
                    : `Agent Hub v${availableVersion} 可用`}
          </strong>
          <span>
            {status.phase === "failed"
              ? status.error ?? "当前版本保持不变，可以重新检查后再试。"
              : status.phase === "downloading"
                ? `${progress}%${formatBytes(status.sizeBytes) ? ` · 共 ${formatBytes(status.sizeBytes)}` : ""}`
                : status.phase === "ready"
                  ? "点击后会保存房间数据、安装完整版本并自动重新打开。"
                  : status.phase === "installing"
                    ? "房主服务会短暂断开，房间记录和连接信息会保留。"
                    : `当前 v${status.currentVersion}${formatBytes(status.sizeBytes) ? ` · 下载 ${formatBytes(status.sizeBytes)}` : ""}`}
          </span>
          {status.notes && status.phase === "available" && <p>{status.notes}</p>}
          {status.phase === "downloading" && <div className="update-progress" aria-label={`下载进度 ${progress}%`}><span style={{ width: `${progress}%` }} /></div>}
        </div>
        <div className="desktop-update-actions">
          {(status.phase === "available" || status.phase === "ready") && (
            <button type="button" className="primary-button" disabled={busy} onClick={() => void updateNow()}>
              {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
              立即更新
            </button>
          )}
          {status.phase === "failed" && <button type="button" className="secondary-button" disabled={busy} onClick={() => void check()}><RefreshCw aria-hidden="true" />重新检查</button>}
          {isAvailable && status.phase !== "downloading" && <button type="button" className="text-button" disabled={busy} onClick={() => setDismissedVersion(availableVersion)}>稍后</button>}
        </div>
      </section>
    );
  }

  return (
    <div className="desktop-update-status" role="status">
      <span>Agent Hub v{status.currentVersion}</span>
      <small>{status.phase === "checking" ? "正在检查更新" : status.phase === "up-to-date" ? "已是最新版" : "自动更新已开启"}</small>
      <button type="button" className="text-button" disabled={busy || status.phase === "checking"} onClick={() => void check()}>
        <RefreshCw className={status.phase === "checking" ? "spin" : ""} aria-hidden="true" />检查更新
      </button>
    </div>
  );
}

export function StatusSummary({ dashboard, syncState, now, conflicts }: { dashboard: Dashboard; syncState: DashboardSyncState; now: number; conflicts?: Conflict[] }) {
  const activeLeases = dashboard.leases.filter((lease) => isValidLease(lease, now));
  // 红色只表示高风险；只有服务端明确返回 deny 才计入阻塞。
  const blockers = (conflicts ?? dashboard.conflicts).filter((item) => item.decision === "deny");
  const onlineMembers = dashboard.members.filter((member) => member.status === "online").length;
  const connected = syncState === "online" || syncState === "partial";
  const statusTitle = syncState === "offline"
    ? "正在重新连接房间"
    : syncState === "unauthorized"
      ? "成员凭证已失效"
      : syncState === "refresh_failed"
        ? "团队数据暂未刷新"
        : blockers.length
          ? "需要处理协作阻塞"
          : syncState === "partial"
            ? "团队状态部分展示"
            : "团队协作正常";
  const statusDetail = syncState === "offline"
    ? "已保留最近一次同步内容，不会丢失本地工作"
    : syncState === "unauthorized"
      ? "已保留最近一次同步内容，请重新加入房间"
      : syncState === "refresh_failed"
        ? "房间未被判定为断开，系统会继续重试团队数据刷新"
        : blockers.length
          ? `${blockers.length} 项阻塞尚未解决，相关工作不会进入共享结果`
          : syncState === "partial"
            ? "房间保持在线，超出轮询上限的协作内容仍保留在房间中"
            : "系统正在后台同步工作范围与项目上下文";
  return (
    <section className={`status-summary ${connected ? "healthy" : "offline"}`} aria-label="协作状态">
      <div className="status-primary">
        <span className="status-signal"><Radio aria-hidden="true" /></span>
        <div>
          <strong>{statusTitle}</strong>
          <span>{statusDetail}</span>
        </div>
      </div>
      <div className="status-metrics">
        <span><b>{activeLeases.length}</b> 范围保护</span>
        <span><b>{onlineMembers}</b> 人在线</span>
        <span className={blockers.length ? "metric-danger" : ""}><b>{blockers.length}</b> 阻塞</span>
      </div>
    </section>
  );
}

function MemberStrip({ dashboard }: { dashboard: Dashboard }) {
  return (
    <section className="member-strip" aria-labelledby="members-title">
      <div className="section-heading compact">
        <div>
          <span className="section-kicker">团队</span>
          <h2 id="members-title">房间成员</h2>
        </div>
        <span className="quiet-count">{dashboard.members.length} 人</span>
      </div>
      <div className="member-list">
        {dashboard.members.map((member) => (
          <div className={`member-chip ${member.compatibility === "incompatible" ? "incompatible" : ""}`} key={member.id} title={`${member.name} · ${member.agent ?? "Agent 未上报"} · ${compatibilityLabel(member.compatibility)}`}>
            <span className={`presence ${member.status}`} />
            <span className="member-avatar">{member.name.slice(0, 1).toUpperCase()}</span>
            <span className="member-copy">
              <strong>{member.name}{member.id === dashboard.currentMember.id ? "（你）" : ""}</strong>
              <small>{member.role === "host" ? "房主" : member.agent ?? "成员"} · {member.clientVersion ? `v${member.clientVersion}` : compatibilityLabel(member.compatibility)}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function shortIdentifier(value?: string): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length <= 12) return normalized;
  return `${normalized.slice(0, 8)}…${normalized.slice(-4)}`;
}

function SessionIdentifier({
  label,
  value,
  missingLabel,
}: {
  label: string;
  value?: string;
  missingLabel: "未关联" | "客户端未提供";
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!value) return;
    const success = await copyText(value);
    setCopied(success);
    window.setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className={`session-identifier ${value ? "" : "missing"}`}>
      <span>{label}</span>
      <div>
        <code title={value}>{value ? shortIdentifier(value) : missingLabel}</code>
        {value && (
          <IconButton label={`复制${label}`} className="compact-copy" onClick={copy}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </IconButton>
        )}
      </div>
    </div>
  );
}

function SessionIdentityStrip({
  hubSessionId,
  codexSessionId,
  currentTurnId,
  className = "",
}: {
  hubSessionId?: string;
  codexSessionId?: string;
  currentTurnId?: string;
  className?: string;
}) {
  const clientMissingLabel = hubSessionId ? "客户端未提供" : "未关联";
  return (
    <div className={`work-session-identifiers ${className}`} aria-label="会话标识">
      <SessionIdentifier label="Codex Session ID" value={codexSessionId} missingLabel={clientMissingLabel} />
      <SessionIdentifier label="Hub Session ID" value={hubSessionId} missingLabel="未关联" />
      <SessionIdentifier label="当前 Turn ID" value={currentTurnId} missingLabel={clientMissingLabel} />
    </div>
  );
}

function leaseSourceLabel(source: Lease["createdVia"]): string {
  return { ui: "界面", mcp: "MCP", hook: "Hook", legacy: "旧版本" }[source];
}

function scopeEventLabel(event: LeaseScopeEvent): string {
  if (event.type === "lease.scope_expanded") return "范围已扩展";
  if (event.type === "lease.scope_covered") return "范围已覆盖";
  if (event.type === "lease.scope_observed") return "识别到调用范围";
  return event.title || "范围调用记录";
}

function ScopeEventPaths({ event }: { event: LeaseScopeEvent }) {
  const groups = [
    ["实际", event.metadata.actualPaths],
    ["新增", event.metadata.addedPaths],
    ["已覆盖", event.metadata.coveredPaths],
    ["已忽略", event.metadata.ignoredPaths],
    ["候选", event.metadata.requestedPaths],
  ] as const;
  return (
    <div className="scope-event-paths">
      {groups.filter(([, paths]) => paths.length > 0).map(([label, paths]) => (
        <div key={label}>
          <span>{label}</span>
          <div className="scope-list compact">{paths.map((path) => <span key={`${label}-${path}`} title={path}>{path}</span>)}</div>
        </div>
      ))}
    </div>
  );
}

export function ScopeEventRow({ event }: { event: LeaseScopeEvent }) {
  return (
    <article className="scope-event-row">
      <div className="scope-event-heading">
        <strong>{scopeEventLabel(event)}</strong>
        <time>{formatDate(event.createdAt)}</time>
      </div>
      <div className="scope-event-meta">
        {event.metadata.source && <span>来源 {leaseSourceLabel(event.metadata.source)}</span>}
        <span>{event.metadata.toolName || "工具未上报"}</span>
        <span>{event.metadata.stage === "pre" ? "调用前" : event.metadata.stage === "post" ? "调用后" : "阶段未上报"}</span>
        <code title={event.metadata.turnId}>{event.metadata.turnId ? `Turn ${shortIdentifier(event.metadata.turnId)}` : "Turn 未上报"}</code>
        {event.metadata.invocationId && <code title={event.metadata.invocationId}>调用 {shortIdentifier(event.metadata.invocationId)}</code>}
      </div>
      <ScopeEventPaths event={event} />
      {event.metadata.pathDiagnostics.length > 0 && (
        <div className="scope-event-diagnostics" aria-label="路径诊断">
          <span>诊断</span>
          <div>{event.metadata.pathDiagnostics.map((diagnostic, index) => (
            <p key={`${index}-${diagnostic}`}>{diagnostic}</p>
          ))}</div>
        </div>
      )}
    </article>
  );
}

function LeaseSessionDetails({
  lease,
  agentSession,
  access,
}: {
  lease: Lease;
  agentSession?: Dashboard["sessions"][number];
  access?: Session;
}) {
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<LeaseScopeEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const isAgentManaged = lease.managedBy === "agent";

  const loadEvents = async (before?: string) => {
    if (!access || loading) return;
    setLoading(true);
    setError(undefined);
    try {
      const page = await getLeaseScopeEvents(access, lease.id, { limit: 20, before });
      setEvents((current) => {
        const combined = before ? [...current, ...page.items] : page.items;
        return [...new Map(combined.map((event) => [event.id, event])).values()];
      });
      setNextBefore(page.nextBefore);
      setLoaded(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "调用历史加载失败。");
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded && !loaded && !loading) void loadEvents();
  };

  const epoch = isAgentManaged ? agentSession?.activityEpoch : undefined;
  const missingEpoch = isAgentManaged && lease.sessionId ? "客户端未提供" : "未关联";
  return (
    <div className={`work-session-detail ${expanded ? "expanded" : ""}`}>
      <button type="button" className="work-detail-toggle" onClick={toggle} aria-expanded={expanded}>
        <ChevronRight aria-hidden="true" />
        <span>会话详情</span>
      </button>
      <div className="work-detail-body" hidden={!expanded}>
        <div className="work-detail-facts">
          <span><strong>activityEpoch</strong><code>{epoch === undefined ? missingEpoch : epoch}</code></span>
          <span><strong>托管方式</strong>{isAgentManaged ? "Agent 托管" : "人工维护"}</span>
          <span><strong>领取来源</strong>{leaseSourceLabel(lease.createdVia)}</span>
        </div>
        <div className="scope-event-history" aria-label="历史调用归因">
          {events.map((event) => <ScopeEventRow event={event} key={event.id} />)}
          {loading && <div className="scope-history-state"><LoaderCircle className="spin" aria-hidden="true" />正在加载</div>}
          {!loading && loaded && events.length === 0 && <div className="scope-history-state">暂无调用记录</div>}
          {error && <div className="scope-history-state error"><AlertTriangle aria-hidden="true" />{error}<button type="button" className="text-button" onClick={() => void loadEvents(nextBefore)}>重试</button></div>}
          {!loading && !error && nextBefore && <button type="button" className="text-button scope-history-more" onClick={() => void loadEvents(nextBefore)}>加载更早记录</button>}
        </div>
      </div>
    </div>
  );
}

export function WorkItem({
  lease,
  agentSession,
  access,
  own,
  busy,
  now = Date.now(),
  onRenew,
  onClose,
}: {
  lease: Lease;
  agentSession?: Dashboard["sessions"][number];
  access?: Session;
  own: boolean;
  busy: boolean;
  now?: number;
  onRenew: (lease: Lease) => void;
  onClose: (lease: Lease) => void;
}) {
  const awaitingCommit = isAwaitingCommitLease(lease);
  const blocked = isBlockedLease(lease);
  const waiting = lease.phase === "waiting";
  const hubSessionId = lease.managedBy === "agent" ? lease.sessionId : undefined;
  return (
    <article className={`work-item ${own ? "own" : ""} ${awaitingCommit ? "awaiting-commit" : ""} ${blocked ? "blocked" : ""} ${waiting ? "waiting" : ""}`}>
      <div className="work-state" aria-hidden="true"><span /></div>
      <div className="work-main">
        <div className="work-title-row">
          <div>
            <div className="work-owner"><span>{lease.memberName}</span>{own && <em>你的工作</em>}<em className={lease.kind === "exclusive" ? "exclusive" : ""}>{lease.kind === "exclusive" ? "手动独占" : lease.managedBy === "agent" ? "Agent 托管" : "普通范围"}</em></div>
            <h3>{lease.title}</h3>
          </div>
          <span className="lease-time"><Clock3 aria-hidden="true" />{formatLeaseExpiryCountdown(lease.expiresAt, now)}</span>
        </div>
        {awaitingCommit && (
          <div className="awaiting-commit-state" role="status">
            <FileClock aria-hidden="true" />
            <strong>会话已结束，等待提交</strong>
          </div>
        )}
        {blocked && <div className="awaiting-commit-state" role="status"><AlertTriangle aria-hidden="true" /><strong>存在未提交改动，已停止续租，等待当前租约到期</strong></div>}
        {waiting && <div className="awaiting-commit-state" role="status"><Clock3 aria-hidden="true" /><strong>等待较早会话释放重叠范围</strong></div>}
        {lease.objective && <p className="work-objective">{lease.objective}</p>}
        <div className="scope-list" aria-label="涉及范围">
          {lease.paths.length ? lease.paths.map((path) => (
            <span className={lease.highRiskPaths.includes(path) ? "high-risk" : ""} key={path} title={path}>
              {lease.highRiskPaths.includes(path) && <ShieldCheck aria-hidden="true" />}
              {path}
            </span>
          )) : <span>范围由本地组件识别中</span>}
        </div>
        <div className="work-meta">
          <span><GitBranch aria-hidden="true" />{lease.branch || "分支未上报"}</span>
          <span>基于 {shortCommit(lease.baseCommit)}</span>
        </div>
        <SessionIdentityStrip
          hubSessionId={hubSessionId}
          codexSessionId={hubSessionId ? agentSession?.codexSessionId : undefined}
          currentTurnId={hubSessionId ? agentSession?.currentTurnId : undefined}
        />
        <LeaseSessionDetails lease={lease} agentSession={agentSession} access={access} />
      </div>
      {own && !awaitingCommit && !blocked && !waiting && (
        <div className="work-actions">
          <IconButton label="延长保护时间" onClick={() => onRenew(lease)} disabled={busy}>
            <RefreshCw className={busy ? "spin" : ""} aria-hidden="true" />
          </IconButton>
          <button type="button" className="secondary-button" onClick={() => onClose(lease)} disabled={busy}>
            <Check aria-hidden="true" />完成并释放
          </button>
        </div>
      )}
    </article>
  );
}

function SystemImpact({ dashboard, now }: { dashboard: Dashboard; now: number }) {
  const systems = useMemo(
    () => protectedSystemsForDashboard(dashboard, now),
    [dashboard, now],
  );

  return (
    <section className="section-block" aria-labelledby="impact-title">
      <div className="section-heading">
        <div>
          <span className="section-kicker">系统影响</span>
          <h2 id="impact-title">当前被保护的系统</h2>
        </div>
      </div>
      {systems.length ? (
        <div className="impact-list">
          {systems.map((system) => (
            <div className="impact-row" key={system.name}>
              <span className={`impact-icon ${system.highRisk ? "high" : ""}`}>
                <Layers3 aria-hidden="true" />
              </span>
              <div className="impact-copy">
                <strong>{system.name}</strong>
                <span>{[...system.members].join("、")}</span>
              </div>
              <span className="impact-count">{system.paths.size} 个范围</span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon={<Layers3 aria-hidden="true" />} title="暂时没有受影响系统" detail="Agent 开始工作后会自动显示在这里。" />
      )}
    </section>
  );
}

export function conflictStatusLabel(conflict: Pick<Conflict, "severity" | "decision">): string {
  if (conflict.decision === "deny") return "已阻止";
  if (conflict.severity === "blocking") return "高风险警告";
  if (conflict.severity === "warning") return "普通警告";
  return "提示";
}

export function ConflictList({ conflicts }: { conflicts: Conflict[] }) {
  return (
    <section className="section-block" aria-labelledby="conflict-title">
      <div className="section-heading">
        <div>
          <span className="section-kicker">风险控制</span>
          <h2 id="conflict-title">冲突与阻塞</h2>
        </div>
        {conflicts.length > 0 && <span className={`quiet-count ${conflicts.some((item) => item.severity === "blocking") ? "danger" : ""}`}>{conflicts.length} 项</span>}
      </div>
      {conflicts.length ? (
        <div className="conflict-list">
          {conflicts.map((conflict) => (
            <article className={`conflict-item ${conflict.severity}`} key={conflict.id}>
              <span className="conflict-icon">
                {conflict.decision === "deny" ? <XCircle aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
              </span>
              <div>
                <div className="conflict-title-line">
                  <strong>{conflict.title}</strong>
                  <span>{conflictStatusLabel(conflict)}</span>
                </div>
                <p>{conflict.summary}</p>
                {conflict.paths.length > 0 && <div className="scope-list compact">{conflict.paths.map((path) => <span key={path}>{path}</span>)}</div>}
                {conflict.memberNames.length > 0 && <small>相关成员：{[...new Set(conflict.memberNames)].join("、")}</small>}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState icon={<ShieldCheck aria-hidden="true" />} title="没有发现冲突" detail="当前工作范围可以并行推进。" />
      )}
    </section>
  );
}

function RecentActivity({ dashboard }: { dashboard: Dashboard }) {
  return (
    <section className="section-block" aria-labelledby="activity-title">
      <div className="section-heading">
        <div>
          <span className="section-kicker">实时同步</span>
          <h2 id="activity-title">最近动态</h2>
        </div>
      </div>
      {dashboard.activity.length ? (
        <div className="activity-list">
          {dashboard.activity.slice(0, 8).map((item) => (
            <div className="activity-row" key={item.id}>
              <span className="activity-dot" />
              <div>
                <strong>{item.title}</strong>
                {item.summary && <p>{item.summary}</p>}
                <small>{item.memberName && `${item.memberName} · `}{formatDate(item.createdAt)}</small>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon={<Activity aria-hidden="true" />} title="动态将在这里出现" detail="房间内的工作、验证和交接会自动记录。" />
      )}
    </section>
  );
}

export function WorkView({
  dashboard,
  access,
  busyLeaseId,
  transientConflicts,
  now,
  onClaim,
  onRenew,
  onClose,
}: {
  dashboard: Dashboard;
  access?: Session;
  busyLeaseId?: string;
  transientConflicts: Conflict[];
  now: number;
  onClaim: () => void;
  onRenew: (lease: Lease) => void;
  onClose: (lease: Lease) => void;
}) {
  const { working, waiting, blocked, awaitingCommit } = splitVisibleLeases(dashboard.leases, now);
  const isOwnLease = (lease: Lease) => lease.memberId === dashboard.currentMember.id || lease.memberName === dashboard.currentMember.name;
  const ownWorkingLeases = working.filter(isOwnLease);
  const otherWorkingLeases = working.filter((lease) => !isOwnLease(lease));
  const ownAwaitingLeases = awaitingCommit.filter(isOwnLease);
  const otherAwaitingLeases = awaitingCommit.filter((lease) => !isOwnLease(lease));
  const ownWaitingLeases = waiting.filter(isOwnLease);
  const otherWaitingLeases = waiting.filter((lease) => !isOwnLease(lease));
  const ownBlockedLeases = blocked.filter(isOwnLease);
  const otherBlockedLeases = blocked.filter((lease) => !isOwnLease(lease));
  const sessionsById = new Map(dashboard.sessions.map((session) => [session.id, session]));
  const boundSessionIds = new Set(
    [...working, ...waiting, ...blocked, ...awaitingCommit]
      .filter((lease) => lease.managedBy === "agent")
      .flatMap((lease) => lease.sessionId ? [lease.sessionId] : []),
  );
  // Hub Session ID 是任务与实时会话的唯一绑定键；已绑定行不再在卡片下方重复出现。
  const activeSessions = dashboard.sessions.filter((session) =>
    isRealtimeAgentSession(session, now) && !boundSessionIds.has(session.id));
  const renderWorkItem = (lease: Lease, own: boolean, busy: boolean) => (
    <WorkItem
      key={lease.id}
      lease={lease}
      agentSession={lease.sessionId ? sessionsById.get(lease.sessionId) : undefined}
      access={access}
      own={own}
      busy={busy}
      now={now}
      onRenew={onRenew}
      onClose={onClose}
    />
  );
  const conflicts = [...transientConflicts, ...dashboard.conflicts];
  return (
    <>
      <MemberStrip dashboard={dashboard} />
      <div className="content-grid wide-main">
        <div className="work-column">
          <section className="section-block" aria-labelledby="work-title">
            <div className="section-heading">
              <div>
                <span className="section-kicker">实时工作</span>
                <h2 id="work-title">团队当前正在做什么</h2>
              </div>
              <button type="button" className="secondary-button" onClick={onClaim}>
                <Plus aria-hidden="true" />手动领取
              </button>
            </div>
            {working.length || activeSessions.length ? (
              <>
                {working.length > 0 && <div className="work-list">
                  {ownWorkingLeases.map((lease) => renderWorkItem(lease, true, busyLeaseId === lease.id))}
                  {otherWorkingLeases.map((lease) => renderWorkItem(lease, false, false))}
                </div>}
                {activeSessions.length > 0 && (
                  <div className="session-list" aria-label="Agent 实时活动">
                    <span className="session-list-label"><Radio aria-hidden="true" />Agent 实时活动</span>
                    {activeSessions.map((agentSession) => {
                      const member = dashboard.members.find((item) => item.id === agentSession.memberId);
                      const sessionTask = agentSession.task?.trim();
                      const visibleTask = sessionTask && !/^Codex session [0-9a-f-]{16,}$/i.test(sessionTask)
                        ? sessionTask
                        : undefined;
                      return (
                        <div className="agent-session-row" key={agentSession.id}>
                          <span className="session-pulse" />
                          <div>
                            <strong>{member?.name ?? "团队成员"}</strong>
                            {visibleTask && <p>{visibleTask}</p>}
                          </div>
                          <small>{agentSession.agentName || agentSession.clientName || "本地组件"}{agentSession.branch ? ` · ${agentSession.branch}` : ""}{agentSession.activityEpoch === undefined ? "" : ` · Epoch ${agentSession.activityEpoch}`}</small>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <EmptyState icon={<Bot aria-hidden="true" />} title="当前没有 Agent 实时活动" detail="当前没有处于工作状态的 Agent 会话。" />
            )}
            <p className="automation-caption"><Bot aria-hidden="true" />日常范围由本地组件自动维护；需要提前声明工作范围或创建独占保护时，可使用“手动领取”。</p>
          </section>
          {(waiting.length > 0 || blocked.length > 0) && (
            <section className="section-block awaiting-protection-section" aria-labelledby="coordination-title">
              <div className="section-heading"><div><span className="section-kicker">租约协调</span><h2 id="coordination-title">等待与阻塞</h2></div><span className="quiet-count">{waiting.length + blocked.length} 项</span></div>
              <div className="work-list">
                {ownWaitingLeases.map((lease) => renderWorkItem(lease, true, false))}
                {otherWaitingLeases.map((lease) => renderWorkItem(lease, false, false))}
                {ownBlockedLeases.map((lease) => renderWorkItem(lease, true, false))}
                {otherBlockedLeases.map((lease) => renderWorkItem(lease, false, false))}
              </div>
            </section>
          )}
          {awaitingCommit.length > 0 && (
            <section className="section-block awaiting-protection-section" aria-labelledby="awaiting-protection-title">
              <div className="section-heading">
                <div>
                  <span className="section-kicker">等待保护</span>
                  <h2 id="awaiting-protection-title">等待提交的保护范围</h2>
                </div>
                <span className="quiet-count">{awaitingCommit.length} 项</span>
              </div>
              <div className="work-list">
                {ownAwaitingLeases.map((lease) => renderWorkItem(lease, true, false))}
                {otherAwaitingLeases.map((lease) => renderWorkItem(lease, false, false))}
              </div>
            </section>
          )}
        </div>
        <aside className="right-column">
          <SystemImpact dashboard={dashboard} now={now} />
          <RecentActivity dashboard={dashboard} />
        </aside>
      </div>
      <ConflictList conflicts={conflicts} />
    </>
  );
}

export function RecordsView({
  dashboard,
  onAdd,
  onReplaceDecision,
}: {
  dashboard: Dashboard;
  onAdd: (kind: Exclude<RecordKind, "context">) => void;
  onReplaceDecision: (decision: ProjectRecord) => void;
}) {
  const [filter, setFilter] = useState<RecordKind | "all">("all");
  const [expandedDecisionId, setExpandedDecisionId] = useState<string>();
  const currentRecords = visibleProjectRecords(dashboard.records);
  const records = filter === "all" ? currentRecords : currentRecords.filter((record) => record.kind === filter);
  const currentDecisionCount = currentRecords.filter((record) => record.kind === "decision").length;
  return (
    <section className="records-view">
      <div className="records-header">
        <div>
          <span className="section-kicker">共享项目上下文</span>
          <h2>决定、验证与交接</h2>
          <p>Agent 会优先读取与当前任务相关的记录，避免重复判断和遗漏验证。</p>
        </div>
        <div className="record-actions">
          <button type="button" className="secondary-button" onClick={() => onAdd("validation")}><FileCheck2 aria-hidden="true" />补充验证</button>
          <button type="button" className="primary-button" onClick={() => onAdd("decision")}><Plus aria-hidden="true" />记录决定</button>
        </div>
      </div>
      <div className="record-summary" aria-label="记录统计">
        <span><CheckCircle2 aria-hidden="true" /><b>{currentDecisionCount}</b> 项决定</span>
        <span><FileCheck2 aria-hidden="true" /><b>{dashboard.records.filter((item) => item.kind === "validation").length}</b> 项验证</span>
        <span><Handshake aria-hidden="true" /><b>{dashboard.records.filter((item) => item.kind === "handoff").length}</b> 项交接</span>
        <span><AlertTriangle aria-hidden="true" /><b>{dashboard.records.filter((item) => item.kind === "risk").length}</b> 项风险</span>
      </div>
      <div className="filter-bar" aria-label="记录筛选">
        {(["all", "decision", "validation", "handoff", "risk", "context"] as const).map((kind) => (
          <button key={kind} type="button" className={filter === kind ? "active" : ""} onClick={() => setFilter(kind)}>
            {kind === "all" ? "全部" : recordLabel(kind)}
          </button>
        ))}
      </div>
      {records.length ? (
        <div className="record-list">
          {records.map((record) => {
            const decisionHistory = record.kind === "decision"
              ? decisionHistoryStateFor(dashboard.records, record.id)
              : { records: [], incomplete: false };
            const expanded = record.kind === "decision" && expandedDecisionId === record.id;
            return (
              <RecordItem
                record={record}
                decisionHistory={decisionHistory.records}
                decisionHistoryIncomplete={decisionHistory.incomplete}
                historyExpanded={expanded}
                key={`${record.kind}-${record.id}`}
                onReplaceDecision={onReplaceDecision}
                onToggleHistory={() => setExpandedDecisionId((current) => current === record.id ? undefined : record.id)}
              />
            );
          })}
        </div>
      ) : (
        <EmptyState icon={<FileClock aria-hidden="true" />} title="当前筛选下没有记录" detail="相关决定和验证完成后会自动同步。" />
      )}
      <div className="quick-record-row">
        <button type="button" onClick={() => onAdd("handoff")}><Handshake aria-hidden="true" /><span><strong>补充交接</strong><small>记录已完成和待处理事项</small></span><ChevronRight aria-hidden="true" /></button>
        <button type="button" onClick={() => onAdd("risk")}><AlertTriangle aria-hidden="true" /><span><strong>登记风险</strong><small>让相关 Agent 提前获得提醒</small></span><ChevronRight aria-hidden="true" /></button>
      </div>
    </section>
  );
}

export function DecisionHistory({ records, incomplete = false }: { records: readonly ProjectRecord[]; incomplete?: boolean }) {
  return (
    <div className="decision-history" role="region" aria-label="决定历史">
      <strong><History aria-hidden="true" />决定历史</strong>
      <ol>
        {records.map((record, index) => {
          const current = index === 0 && isCurrentDecision(record);
          return (
            <li className={current ? "current" : "superseded"} key={record.id}>
              <div className="decision-history-heading">
                <span className={`record-status ${current ? "current" : "superseded"}`}>{current ? "当前决定" : "已替代"}</span>
                <time>{formatDate(record.createdAt, true)}</time>
              </div>
              <h4>{record.title}</h4>
              {record.summary && <p>{record.summary}</p>}
              {record.evidence && <small>判断依据：{record.evidence}</small>}
              {record.paths.length > 0 && <div className="scope-list compact">{record.paths.map((path) => <span key={path}>{path}</span>)}</div>}
              {record.memberName && <small className="record-author">由 {record.memberName} 记录</small>}
            </li>
          );
        })}
      </ol>
      {incomplete && (
        <p className="decision-history-incomplete"><AlertTriangle aria-hidden="true" />更早决定未包含在当前刷新结果中。</p>
      )}
    </div>
  );
}

export function RecordItem({
  record,
  decisionHistory = [],
  decisionHistoryIncomplete = false,
  historyExpanded = false,
  onReplaceDecision,
  onToggleHistory,
}: {
  record: ProjectRecord;
  decisionHistory?: ProjectRecord[];
  decisionHistoryIncomplete?: boolean;
  historyExpanded?: boolean;
  onReplaceDecision?: (decision: ProjectRecord) => void;
  onToggleHistory?: () => void;
}) {
  const isPassed = record.kind === "validation" && ["passed", "pass", "success"].includes(record.status ?? "");
  const isFailed = record.kind === "validation" && ["failed", "fail"].includes(record.status ?? "");
  const canUpdateDecision = Boolean(record.id) && isCurrentDecision(record);
  const hasDecisionHistory = canUpdateDecision && (
    decisionHistory.length > 1 || Boolean(record.supersedesDecisionId)
  );
  const historyId = `decision-history-${record.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return (
    <article className={`record-item ${record.kind}`}>
      <span className={`record-icon ${isPassed ? "passed" : ""} ${isFailed ? "failed" : ""}`}>{recordIcon(record.kind)}</span>
      <div className="record-main">
        <div className="record-title-row">
          <span className="record-kind">{recordLabel(record.kind)}</span>
          {record.status && <span className={`record-status ${isPassed ? "passed" : ""} ${isFailed ? "failed" : ""}`}>{statusLabel(record.status)}</span>}
          <time>{formatDate(record.createdAt, true)}</time>
        </div>
        <h3>{record.title}</h3>
        {record.summary && <p>{record.summary}</p>}
        {record.details?.map((detail) => <small className="record-detail" key={detail}>{detail}</small>)}
        {record.paths.length > 0 && <div className="scope-list compact">{record.paths.map((path) => <span key={path}>{path}</span>)}</div>}
        {(record.evidence || record.command || record.commitHash) && (
          <div className="evidence-line">
            {record.evidence && <span><FileCheck2 aria-hidden="true" />{record.evidence}</span>}
            {record.command && <code>{record.command}</code>}
            {record.commitHash && <code>{shortCommit(record.commitHash)}</code>}
          </div>
        )}
        {record.memberName && <small className="record-author">由 {record.memberName} 记录</small>}
        {canUpdateDecision && (
          <div className="record-item-actions">
            {hasDecisionHistory && (
              <button
                type="button"
                className="text-button"
                aria-controls={historyId}
                aria-expanded={historyExpanded}
                onClick={onToggleHistory}
              >
                <History aria-hidden="true" />{historyExpanded ? "收起历史" : "查看历史"}
              </button>
            )}
            <button type="button" className="text-button" onClick={() => onReplaceDecision?.(record)}>
              <PencilLine aria-hidden="true" />更新决定
            </button>
          </div>
        )}
        {historyExpanded && hasDecisionHistory && (
          <div id={historyId}><DecisionHistory records={decisionHistory} incomplete={decisionHistoryIncomplete} /></div>
        )}
      </div>
    </article>
  );
}

function CopyValue({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [revealed, setRevealed] = useState(!secret);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const success = await copyText(value);
    setCopied(success);
    window.setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="copy-value">
      <div>
        <span>{label}</span>
        <code>{revealed ? value : "••••••••••••••••••••"}</code>
      </div>
      {secret && (
        <button type="button" className="text-button" onClick={() => setRevealed(!revealed)}>
          {revealed ? "隐藏" : "显示"}
        </button>
      )}
      <IconButton label={`复制${label}`} onClick={copy}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </IconButton>
    </div>
  );
}

function ConnectionView({
  dashboard,
  session,
  syncState,
  now,
  deleting,
  onRemoveLocal,
}: {
  dashboard: Dashboard;
  session: Session;
  syncState: DashboardSyncState;
  now: number;
  deleting: boolean;
  onRemoveLocal: () => void;
}) {
  const currentSessions = dashboard.sessions.filter((item) =>
    item.memberId === dashboard.currentMember.id && isRealtimeAgentSession(item, now));
  const latestScan = dashboard.localScans
    .filter((item) => item.memberId === dashboard.currentMember.id)
    .sort((left, right) => (right.scannedAt ?? "").localeCompare(left.scannedAt ?? ""))[0];
  const agentOnline = currentSessions.length > 0;
  const connectedAgent = currentSessions[0]?.agentName || currentSessions[0]?.clientName || dashboard.currentMember.agent;
  const invite = session.roomToken || dashboard.room.code || "房间码暂不可用";
  const [inviteAddress, setInviteAddress] = useState(session.inviteServerUrl || session.serverUrl || window.location.origin);
  const [installing, setInstalling] = useState(false);
  const [installMessage, setInstallMessage] = useState("");
  const roomServiceConnected = syncState === "online" || syncState === "partial";
  const roomServiceState = roomServiceConnected ? "connected" : syncState === "offline" ? "disconnected" : "pending";
  const roomServiceDetail = syncState === "online"
    ? "已连接，团队状态正在同步"
    : syncState === "partial"
      ? "已连接，部分协作内容超出轮询展示上限"
      : syncState === "offline"
        ? "连接中断，正在自动重试"
        : syncState === "unauthorized"
          ? "成员凭证已失效，请重新加入房间"
          : "最近一次团队数据刷新失败，正在自动重试";
  const roomServiceLabel = roomServiceConnected ? "在线" : syncState === "offline" ? "离线" : syncState === "unauthorized" ? "需处理" : "待刷新";

  useEffect(() => {
    if (!isDesktopApp() || dashboard.currentMember.role !== "host" || session.inviteServerUrl) return;
    void getDesktopServerInfo()
      .then((info) => setInviteAddress(
        info?.lanUrls[0] ?? info?.localServerUrl ?? session.serverUrl ?? window.location.origin,
      ))
      .catch(() => undefined);
  }, [dashboard.currentMember.role, session.inviteServerUrl, session.serverUrl]);

  const installCodex = async () => {
    if (!session.connectionId) return;
    setInstalling(true);
    setInstallMessage("");
    try {
      setInstallMessage(await installCodexConnection(session.connectionId));
    } catch (caught) {
      setInstallMessage(caught instanceof Error ? caught.message : "Codex 连接安装失败。 ");
    } finally {
      setInstalling(false);
    }
  };

  return (
    <section className="connection-view">
      <div className="records-header">
        <div>
          <span className="section-kicker">一次连接，后台运行</span>
          <h2>连接设置</h2>
          <p>房主服务、本地组件和 Agent 连接后，成员不需要手动维护协作信息。</p>
        </div>
      </div>
      <div className="connection-health">
        <div className={roomServiceState}>
          <span><Server aria-hidden="true" /></span>
          <div><strong>房间服务</strong><small>{roomServiceDetail}</small></div>
          <em>{roomServiceLabel}</em>
        </div>
        <div className={agentOnline ? "connected" : "pending"}>
          <span><Bot aria-hidden="true" /></span>
          <div><strong>本地组件与 Agent</strong><small>{agentOnline ? `${connectedAgent || "Agent"} 已上报活动${latestScan?.scannedAt ? ` · 最近扫描 ${formatDate(latestScan.scannedAt)}` : ""}` : "等待本地组件上报 Agent 活动"}</small></div>
          <em>{agentOnline ? "已连接" : "等待"}</em>
        </div>
      </div>

      <section className="connection-section" aria-labelledby="invite-title">
        <div className="section-heading">
          <div><span className="section-kicker">邀请成员</span><h3 id="invite-title">房间访问信息</h3></div>
        </div>
        <CopyValue label="房主邀请地址" value={inviteAddress} />
        <CopyValue label="房间码" value={invite} secret />
        <p className="security-note"><KeyRound aria-hidden="true" />只发给参与此项目的成员。房间码用于加入，不能替代 Git 仓库权限。</p>
      </section>

      <section className="connection-section" aria-labelledby="agent-title">
        <div className="section-heading">
          <div><span className="section-kicker">Agent 接入</span><h3 id="agent-title">本机连接信息</h3></div>
        </div>
        <CopyValue label="MCP 地址" value={dashboard.server.mcpUrl} />
        {session.connectionId ? (
          <CopyValue label="本机连接标识" value={session.connectionId} />
        ) : session.memberToken ? (
          <CopyValue label="临时成员凭证" value={session.memberToken} secret />
        ) : null}
        {session.connectionId && (
          <div className="integration-action">
            <div><Bot aria-hidden="true" /><span><strong>Codex 自动接入</strong><small>写入本机 MCP 与协作 Hook 配置，不会发送源码。</small></span></div>
            <button type="button" className="primary-button" onClick={() => void installCodex()} disabled={installing}>
              {installing ? <LoaderCircle className="spin" aria-hidden="true" /> : <Link2 aria-hidden="true" />}
              安装连接
            </button>
          </div>
        )}
        {installMessage && <p className="integration-result" role="status">{installMessage}</p>}
        {session.connectionId && (
          <div className="local-removal-action">
            <div>
              <Trash2 aria-hidden="true" />
              <span>
                <strong>移除本机房间数据</strong>
                <small>删除这台电脑保存的连接、成员凭证和本地接入配置，不影响远端团队数据。</small>
              </span>
            </div>
            <button
              type="button"
              className="secondary-button danger-action-button"
              onClick={onRemoveLocal}
              disabled={deleting}
            >
              {deleting ? <LoaderCircle className="spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
              从本机移除
            </button>
          </div>
        )}
        <div className="connection-steps">
          <div><span>1</span><div><strong>保持房主服务运行</strong><p>房主电脑关机后房间会暂时离线，重新启动后自动恢复。</p></div></div>
          <div><span>2</span><div><strong>安装并连接本地组件</strong><p>组件只分析本地项目，向房间同步路径、摘要和验证结果。</p></div></div>
          <div><span>3</span><div><strong>让 Agent 使用房间上下文</strong><p>MCP 连接成功后，Agent 会在工作前读取相关约束并自动登记范围。</p></div></div>
        </div>
      </section>

      <section className="privacy-band">
        <ShieldCheck aria-hidden="true" />
        <div><strong>源码留在成员电脑与 Git 仓库中</strong><p>房间不共享私人聊天、隐藏思考、密钥或未授权的源码全文。</p></div>
      </section>
    </section>
  );
}

function ClaimLeaseModal({
  settings,
  onClose,
  onSubmit,
}: {
  settings: RoomSettings;
  onClose: () => void;
  onSubmit: (input: CreateLeaseInput) => Promise<void>;
}) {
  const [values, setValues] = useState({
    title: "",
    objective: "",
    branch: "",
    baseCommit: "",
    paths: "",
    ttlMinutes: Math.min(60, settings.maximumExclusiveLeaseMinutes),
    kind: "standard" as "standard" | "exclusive",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const paths = splitLines(values.paths);
    if (!paths.length) return setError("至少填写一个项目相对路径。 ");
    setBusy(true);
    setError("");
    try {
      await onSubmit({ ...values, paths });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "领取失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="手动领取工作范围" detail="普通范围跟随房间策略；独占范围始终需要租客批准后才能交接。" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <fieldset className="choice-field"><legend>领取模式</legend><div className="segmented-control">
          <button type="button" className={values.kind === "standard" ? "active" : ""} onClick={() => setValues({ ...values, kind: "standard" })}>普通工作范围</button>
          <button type="button" className={values.kind === "exclusive" ? "active" : ""} onClick={() => setValues({ ...values, kind: "exclusive" })}><KeyRound aria-hidden="true" />独占保护范围</button>
        </div></fieldset>
        <Field label="工作名称"><input required maxLength={120} placeholder="例如：调整背包与装备切换" value={values.title} onChange={(event) => setValues({ ...values, title: event.target.value })} /></Field>
        <Field label="目标"><textarea rows={3} maxLength={1000} placeholder="简要说明准备完成什么" value={values.objective} onChange={(event) => setValues({ ...values, objective: event.target.value })} /></Field>
        <div className="field-grid two-columns">
          <Field label="当前分支"><input placeholder="feature/inventory" value={values.branch} onChange={(event) => setValues({ ...values, branch: event.target.value })} /></Field>
          <Field label="基准提交"><input placeholder="提交哈希，可留空" value={values.baseCommit} onChange={(event) => setValues({ ...values, baseCommit: event.target.value })} /></Field>
        </div>
        <Field label="预计修改范围" hint="每行一个相对项目根目录的文件或目录。"><textarea className="path-input" required rows={5} placeholder={"Assets/Vanguard/Inventory\nAssets/Vanguard/Equipment/Weapon.cs"} value={values.paths} onChange={(event) => setValues({ ...values, paths: event.target.value })} /></Field>
        {values.kind === "exclusive" ? (
          <Field label="固定保护时长" hint={`5 至 ${settings.maximumExclusiveLeaseMinutes} 分钟；不会随 Agent 心跳自动延长。`}><span className="number-setting"><input type="number" min={5} max={settings.maximumExclusiveLeaseMinutes} step={5} required value={values.ttlMinutes} onChange={(event) => setValues({ ...values, ttlMinutes: Number(event.target.value) })} />分钟</span></Field>
        ) : (
          <div className="inline-note"><Clock3 aria-hidden="true" /><span>普通工作范围使用房间设定的 {settings.automaticLeaseTtlMinutes} 分钟租期，Agent 持续工作时自动续期。</span></div>
        )}
        {error && <div className="form-error"><AlertTriangle aria-hidden="true" />{error}</div>}
        <div className="modal-actions"><button type="button" className="text-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : values.kind === "exclusive" ? <KeyRound aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}{values.kind === "exclusive" ? "申请独占" : "检查并领取"}</button></div>
      </form>
    </Modal>
  );
}

function ReleaseRequestModal({
  request,
  onClose,
  onResolve,
}: {
  request: ReleaseRequest;
  onClose: () => void;
  onResolve: (decision: "approve" | "reject", reason?: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError("");
    try {
      await onResolve(decision, reason || undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "申请处理失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const approvalEffect = request.conflictingLeaseKind === "exclusive"
    ? "批准后，你的整份手动独占租约会结束，申请人的实际请求范围将立即交给对方。"
    : "批准后，只会把发生冲突的路径交给申请人；你租约中的其他路径继续保留。";
  return (
    <Modal title="有人申请交接保护范围" detail={`${request.requesterName} 需要修改你正在保护的范围。`} onClose={onClose}>
      <div className="modal-form release-request-form">
        <div className="release-request-summary"><Bell aria-hidden="true" /><div><strong>{request.requestTitle}</strong><p>{request.requestObjective || request.reason}</p></div></div>
        <div><span className="field-label">申请修改</span><div className="scope-list">{request.requestedPaths.map((path) => <span key={path}>{path}</span>)}</div></div>
        <div className="inline-note"><ShieldCheck aria-hidden="true" /><span>{approvalEffect}</span></div>
        <Field label="给申请人的说明" hint="拒绝时建议说明原因；批准时可留空。"><textarea rows={3} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
        {error && <div className="form-error"><AlertTriangle aria-hidden="true" />{error}</div>}
        <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void decide("reject")}><X aria-hidden="true" />拒绝</button><button type="button" className="primary-button" disabled={busy} onClick={() => void decide("approve")}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Handshake aria-hidden="true" />}批准并交接</button></div>
      </div>
    </Modal>
  );
}

function CloseLeaseModal({ lease, onClose, onSubmit }: { lease: Lease; onClose: () => void; onSubmit: (input: Parameters<typeof closeLease>[2]) => Promise<void> }) {
  const [values, setValues] = useState({ outcome: "", changedPaths: lease.paths.join("\n"), commitHash: "", validations: "", remainingRisks: "", handoff: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        outcome: values.outcome,
        changedPaths: splitLines(values.changedPaths),
        commitHash: values.commitHash || undefined,
        validations: splitLines(values.validations),
        remainingRisks: splitLines(values.remainingRisks),
        handoff: values.handoff || undefined,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "完成失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="完成工作并释放保护" detail={lease.title} onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <Field label="完成结果"><textarea required rows={3} placeholder="说明完成了什么，以及旧功能如何保持有效" value={values.outcome} onChange={(event) => setValues({ ...values, outcome: event.target.value })} /></Field>
        <Field label="实际改动范围"><textarea className="path-input" rows={4} value={values.changedPaths} onChange={(event) => setValues({ ...values, changedPaths: event.target.value })} /></Field>
        <div className="field-grid two-columns"><Field label="提交哈希"><input placeholder="可留空" value={values.commitHash} onChange={(event) => setValues({ ...values, commitHash: event.target.value })} /></Field><Field label="完成的验证"><textarea rows={2} placeholder="每行一项" value={values.validations} onChange={(event) => setValues({ ...values, validations: event.target.value })} /></Field></div>
        <Field label="遗留风险"><textarea rows={2} placeholder="没有可留空，每行一项" value={values.remainingRisks} onChange={(event) => setValues({ ...values, remainingRisks: event.target.value })} /></Field>
        <Field label="交接说明"><textarea rows={2} placeholder="给后续成员或 Agent 的信息" value={values.handoff} onChange={(event) => setValues({ ...values, handoff: event.target.value })} /></Field>
        {error && <div className="form-error"><AlertTriangle aria-hidden="true" />{error}</div>}
        <div className="modal-actions"><button type="button" className="text-button" onClick={onClose}>返回</button><button type="submit" className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}确认完成</button></div>
      </form>
    </Modal>
  );
}

export function RecordModal({ kind, leases, members, supersedesDecision, onClose, onSubmit }: { kind: Exclude<RecordKind, "context">; leases: Lease[]; members: Dashboard["members"]; supersedesDecision?: ProjectRecord; onClose: () => void; onSubmit: (input: CreateRecordInput) => Promise<void> }) {
  const effectiveKind = supersedesDecision ? "decision" : kind;
  const [values, setValues] = useState({
    title: supersedesDecision?.title ?? "",
    summary: supersedesDecision?.summary ?? "",
    paths: supersedesDecision?.paths.join("\n") ?? "",
    status: effectiveKind === "validation" ? "passed" : "",
    evidence: supersedesDecision?.evidence ?? "",
    command: "",
    leaseId: "",
    toMemberId: "",
    completed: "",
    remaining: "",
    risks: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const titles = { decision: "记录团队决定", validation: "补充验证结果", handoff: "补充工作交接", risk: "登记项目风险" };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        kind: effectiveKind,
        title: values.title || recordLabel(effectiveKind),
        summary: values.summary,
        paths: splitLines(values.paths),
        status: values.status || undefined,
        evidence: values.evidence || undefined,
        command: values.command || undefined,
        leaseId: values.leaseId || undefined,
        toMemberId: values.toMemberId || undefined,
        completed: splitLines(values.completed),
        remaining: splitLines(values.remaining),
        risks: splitLines(values.risks),
        supersedesDecisionId: supersedesDecision?.id,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={supersedesDecision ? "更新团队决定" : titles[effectiveKind]}
      detail={supersedesDecision
        ? "保存后，原决定会标记为已替代并保留在决定历史中。"
        : "这类信息通常由 Agent 自动记录，必要时可以在这里补充。"}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit}>
        {supersedesDecision && (
          <div className="decision-replacement-summary">
            <History aria-hidden="true" />
            <div><strong>正在更新既有决定</strong><span>{supersedesDecision.title}</span></div>
          </div>
        )}
        {effectiveKind === "validation" ? (
          <Field label="验证类型">
            <select required value={values.title} onChange={(event) => setValues({ ...values, title: event.target.value })}>
              <option value="">请选择</option>
              <option value="static">静态检查</option>
              <option value="automated_test">自动化测试</option>
              <option value="unity_edit_mode">Unity Edit Mode</option>
              <option value="unity_play_mode">Unity Play Mode</option>
              <option value="manual">人工验收</option>
            </select>
          </Field>
        ) : (
          <Field label="标题"><input required={effectiveKind !== "handoff"} maxLength={160} placeholder="简短描述这条记录" value={values.title} onChange={(event) => setValues({ ...values, title: event.target.value })} /></Field>
        )}
        <Field label={effectiveKind === "decision" ? "最终决定" : effectiveKind === "validation" ? "验证结果摘要" : effectiveKind === "handoff" ? "交接摘要" : "风险说明"}><textarea required rows={4} value={values.summary} onChange={(event) => setValues({ ...values, summary: event.target.value })} /></Field>
        {effectiveKind === "validation" && <div className="field-grid two-columns"><Field label="结果"><select value={values.status} onChange={(event) => setValues({ ...values, status: event.target.value })}><option value="passed">通过</option><option value="failed">失败</option><option value="pending">待验证</option></select></Field><Field label="关联工作"><select value={values.leaseId} onChange={(event) => setValues({ ...values, leaseId: event.target.value })}><option value="">不指定</option>{leases.map((lease) => <option value={lease.id} key={lease.id}>{lease.title}</option>)}</select></Field></div>}
        {effectiveKind === "handoff" && <><div className="field-grid two-columns"><Field label="交接给"><select value={values.toMemberId} onChange={(event) => setValues({ ...values, toMemberId: event.target.value })}><option value="">整个团队</option>{members.map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}</select></Field><Field label="关联工作"><select value={values.leaseId} onChange={(event) => setValues({ ...values, leaseId: event.target.value })}><option value="">不指定</option>{leases.map((lease) => <option value={lease.id} key={lease.id}>{lease.title}</option>)}</select></Field></div><Field label="已完成"><textarea rows={2} placeholder="每行一项" value={values.completed} onChange={(event) => setValues({ ...values, completed: event.target.value })} /></Field><div className="field-grid two-columns"><Field label="待处理"><textarea rows={2} value={values.remaining} onChange={(event) => setValues({ ...values, remaining: event.target.value })} /></Field><Field label="风险"><textarea rows={2} value={values.risks} onChange={(event) => setValues({ ...values, risks: event.target.value })} /></Field></div></>}
        {effectiveKind !== "handoff" && <Field label="涉及范围" hint="可留空；每行一个相对路径。"><textarea className="path-input" rows={3} value={values.paths} onChange={(event) => setValues({ ...values, paths: event.target.value })} /></Field>}
        {(effectiveKind === "decision" || effectiveKind === "validation") && <Field label={effectiveKind === "decision" ? "判断依据" : "证据或观察"}><textarea required={Boolean(supersedesDecision)} rows={2} value={values.evidence} onChange={(event) => setValues({ ...values, evidence: event.target.value })} /></Field>}
        {effectiveKind === "validation" && <Field label="执行命令"><input placeholder="没有命令可留空" value={values.command} onChange={(event) => setValues({ ...values, command: event.target.value })} /></Field>}
        {error && <div className="form-error"><AlertTriangle aria-hidden="true" />{error}</div>}
        <div className="modal-actions"><button type="button" className="text-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}{supersedesDecision ? "保存更新" : "保存记录"}</button></div>
      </form>
    </Modal>
  );
}

function DashboardApp({
  session,
  initialNotice = null,
  deletingCurrentConnection,
  onLeave,
  onDeleteCurrentConnection,
}: {
  session: Session;
  initialNotice?: Notice | null;
  deletingCurrentConnection: boolean;
  onLeave: () => Promise<void>;
  onDeleteCurrentConnection: () => void;
}) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [view, setView] = useState<View>("work");
  const [navOpen, setNavOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [syncState, setSyncState] = useState<DashboardSyncState>("online");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(initialNotice);
  const [activeModal, setActiveModal] = useState<DashboardModal | null>(null);
  const [busyLeaseId, setBusyLeaseId] = useState<string>();
  const [transientConflicts, setTransientConflicts] = useState<Conflict[]>([]);
  const [dismissedReleaseRequestIds, setDismissedReleaseRequestIds] = useState<Set<string>>(() => new Set());
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(0);
  const [leaseNow, setLeaseNow] = useState(() => Date.now());
  const closingLease = activeModal?.type === "close" ? activeModal.lease : null;
  const releaseRequestId = activeModal?.type === "release" ? activeModal.requestId : undefined;

  const openModal = (modal: DashboardModal) => {
    setActiveModal((current) => current ?? modal);
  };

  const refresh = useCallback(async (quiet = false) => {
    if (leaving) return false;
    if (!quiet) setRefreshing(true);
    try {
      const next = await getDashboard(session, session.roomToken);
      if (!next.currentMember.id) next.currentMember = session.member;
      if (!next.members.some((member) => member.id === next.currentMember.id)) next.members.unshift(next.currentMember);
      const localObservedAt = Date.now();
      const nextClockOffsetMs = dashboardClockOffsetMs(next.generatedAt, localObservedAt);
      setDashboard(next);
      setServerClockOffsetMs(nextClockOffsetMs);
      setLeaseNow(localObservedAt + nextClockOffsetMs);
      const partialSections = next.partialSections ?? [];
      const partial = partialSections.length > 0;
      // 容量受控的部分响应仍代表连接成功；只有传输或数据契约失败才进入陈旧状态。
      setSyncState(dashboardSyncStateForPartialSections(partialSections));
      setError(partial ? dashboardPartialRefreshMessage(partialSections) : "");
      return true;
    } catch (caught) {
      // 数据契约或响应体错误只会让缓存数据变旧，不能伪装成房间断线。
      const failureState = classifyDashboardRefreshFailure(caught);
      setSyncState(failureState);
      setError(dashboardRefreshErrorMessage(caught, failureState));
      return false;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [leaving, session]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(true), 15_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  useEffect(() => {
    const updateClock = () => setLeaseNow(Date.now() + serverClockOffsetMs);
    updateClock();
    const interval = window.setInterval(updateClock, 1_000);
    return () => window.clearInterval(interval);
  }, [serverClockOffsetMs]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (initialNotice) setNotice(initialNotice);
  }, [initialNotice]);

  const requestLeave = () => {
    if (leaving) return;
    setLeaving(true);
    void onLeave().catch((caught) => {
      setLeaving(false);
      const message = caught instanceof Error ? caught.message : "无法暂停本机房间连接，请重试。";
      if (dashboard) setNotice({ tone: "danger", message });
      else setError(message);
    });
  };

  useEffect(() => {
    if (!dashboard) return;
    const requestId = nextPendingReleaseRequestId(
      activeModal,
      dashboard.releaseRequests,
      dashboard.currentMember.id,
      dismissedReleaseRequestIds,
    );
    if (requestId) setActiveModal((current) => current ?? { type: "release", requestId });
  }, [activeModal, dashboard, dismissedReleaseRequestIds]);

  useEffect(() => {
    if (!dashboard || activeModal?.type !== "release") return;
    const stillPending = dashboard.releaseRequests.some((request) =>
      request.id === activeModal.requestId && request.status === "pending"
    );
    if (!stillPending) setActiveModal(null);
  }, [activeModal, dashboard]);

  const handleClaim = async (input: CreateLeaseInput) => {
    const result = await createLease(session, input);
    setTransientConflicts(result.conflicts);
    if (result.decision === "wait") {
      setNotice({ tone: "warning", message: `已进入等待队列，优先租约由 ${result.waitingFor?.memberName ?? "较早会话"} 持有；当前任务不会反向阻塞它。` });
    } else if (result.decision === "deny") {
      setNotice({ tone: "danger", message: result.releaseRequests.length ? "范围已被占用，释放申请已经发送给当前持有人。" : "范围已被占用，工作没有被登记。冲突详情已显示在当前页面。" });
    } else if (!result.acquired) {
      setNotice({ tone: "warning", message: "范围暂未登记，但服务端没有返回阻止决定；本次只显示风险提醒。" });
    } else {
      setNotice({ tone: result.decision === "warn" ? "warning" : "success", message: result.decision === "warn" ? "范围已登记，同时发现需要关注的重叠。" : "工作范围已登记并开始保护。" });
    }
    await refresh(true);
  };

  const handleRenew = async (lease: Lease) => {
    setBusyLeaseId(lease.id);
    try {
      await renewLease(session, lease.id);
      setNotice({ tone: "success", message: "保护时间已延长。" });
      await refresh(true);
    } catch (caught) {
      setNotice({ tone: "danger", message: caught instanceof Error ? caught.message : "续期失败。" });
    } finally {
      setBusyLeaseId(undefined);
    }
  };

  const handleClose = async (input: Parameters<typeof closeLease>[2]) => {
    if (!closingLease) return;
    setBusyLeaseId(closingLease.id);
    try {
      await closeLease(session, closingLease.id, input);
      setNotice({ tone: "success", message: "工作已完成，保护范围已释放。" });
      setActiveModal(null);
      await refresh(true);
    } finally {
      setBusyLeaseId(undefined);
    }
  };

  const handleRecord = async (input: CreateRecordInput) => {
    try {
      await createRecord(session, input);
      setNotice({ tone: "success", message: input.supersedesDecisionId ? "新决定已生效，原决定已保留到历史中。" : "记录已同步给房间内的 Agent。" });
      await refresh(true);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "decision_already_superseded") {
        const refreshed = await refresh(true);
        const recovery = decisionReplacementConflictRecovery(caught, refreshed);
        if (!recovery) throw caught;
        if (recovery.closeModal) setActiveModal(null);
        setNotice(recovery.notice);
        return;
      }
      throw caught;
    }
  };

  const handleReleaseRequest = async (requestId: string, decision: "approve" | "reject", reason?: string) => {
    await resolveReleaseRequest(session, requestId, decision, reason);
    setActiveModal(null);
    setNotice({
      tone: decision === "approve" ? "success" : "warning",
      message: decision === "approve" ? "保护范围已安全交接给申请人。" : "申请已拒绝，原保护范围继续有效。",
    });
    await refresh(true);
  };

  if (loading && !dashboard) {
    return <main className="loading-screen"><div className="brand-mark large"><Network /></div><LoaderCircle className="spin" /><strong>正在同步团队现场</strong><span>正在获取工作范围、决定与验证状态</span></main>;
  }

  if (!dashboard) {
    return <main className="fatal-screen"><AlertTriangle aria-hidden="true" /><h1>暂时无法进入房间</h1><p>{error || "房主服务可能尚未启动。"}</p><div><button type="button" className="primary-button" onClick={() => void refresh()} disabled={leaving || deletingCurrentConnection}><RefreshCw aria-hidden="true" />重新连接</button><button type="button" className="secondary-button" onClick={requestLeave} disabled={leaving || deletingCurrentConnection}>{leaving ? <LoaderCircle className="spin" aria-hidden="true" /> : <LogOut aria-hidden="true" />}返回登录</button>{session.connectionId && <button type="button" className="secondary-button danger-action-button" onClick={onDeleteCurrentConnection} disabled={leaving || deletingCurrentConnection}>{deletingCurrentConnection ? <LoaderCircle className="spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}从本机移除</button>}</div></main>;
  }

  const ownedReleaseRequests = dashboard.releaseRequests.filter((request) => request.status === "pending" && request.holderMemberId === dashboard.currentMember.id);
  const activeReleaseRequest = dashboard.releaseRequests.find((request) => request.id === releaseRequestId && request.status === "pending");
  const dismissReleaseRequest = () => {
    if (releaseRequestId) setDismissedReleaseRequestIds((current) => new Set(current).add(releaseRequestId));
    setActiveModal(null);
  };

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="top-brand">
          <IconButton label="打开导航" className="menu-button" onClick={() => setNavOpen(true)}><Menu aria-hidden="true" /></IconButton>
          <span className="brand-mark"><Network aria-hidden="true" /></span>
          <div><strong>Agent Hub</strong><span>{dashboard.room.projectName}</span></div>
        </div>
        <div className="room-identity">
          <span>{dashboard.room.name}</span>
          <small><GitBranch aria-hidden="true" />{dashboard.room.defaultBranch}</small>
        </div>
        <div className="top-actions">
          <span className={`connection-pill ${syncState === "online" || syncState === "partial" ? "online" : "offline"}`}><span />{syncState === "online" || syncState === "partial" ? "已连接" : syncState === "offline" ? "连接中" : syncState === "unauthorized" ? "凭证失效" : "待刷新"}</span>
          <IconButton label="刷新团队状态" onClick={() => void refresh()} disabled={refreshing || leaving}><RefreshCw className={refreshing ? "spin" : ""} aria-hidden="true" /></IconButton>
          <div className="current-user" title={dashboard.currentMember.name}><span>{dashboard.currentMember.name.slice(0, 1).toUpperCase()}</span><div><strong>{dashboard.currentMember.name}</strong><small>{dashboard.currentMember.role === "host" ? "房主" : "成员"}</small></div></div>
          <IconButton label="离开当前房间" onClick={requestLeave} disabled={leaving}>{leaving ? <LoaderCircle className="spin" aria-hidden="true" /> : <LogOut aria-hidden="true" />}</IconButton>
        </div>
      </header>
      <div className="app-body">
        <AppNav view={view} onChange={setView} open={navOpen} onClose={() => setNavOpen(false)} blockingProtectionEnabled={dashboard.settings.blockingProtectionEnabled} />
        <main className="workspace">
          {ownedReleaseRequests.length > 0 && <div className="release-request-banner" role="status"><Bell aria-hidden="true" /><div><strong>{ownedReleaseRequests.length} 个范围交接申请等待你处理</strong><span>{ownedReleaseRequests[0].requesterName} 需要修改你正在保护的路径。</span></div><button type="button" className="primary-button" onClick={() => openModal({ type: "release", requestId: ownedReleaseRequests[0].id })}>查看申请</button></div>}
          <StatusSummary dashboard={dashboard} syncState={syncState} now={leaseNow} conflicts={[...transientConflicts, ...dashboard.conflicts]} />
          <DesktopUpdateControl onNotice={(message, tone = "success") => setNotice({ message, tone })} />
          {error && <div className="inline-alert"><AlertTriangle aria-hidden="true" />{error}</div>}
          {view === "work" && <WorkView dashboard={dashboard} access={session} busyLeaseId={busyLeaseId} transientConflicts={transientConflicts} now={leaseNow} onClaim={() => openModal({ type: "claim" })} onRenew={handleRenew} onClose={(lease) => openModal({ type: "close", lease })} />}
          {view === "records" && <RecordsView dashboard={dashboard} onAdd={(recordKind) => openModal({ type: "record", recordKind })} onReplaceDecision={(decision) => openModal({ type: "replace-decision", decision })} />}
          {view === "management" && <ManagementView dashboard={dashboard} session={session} onRefresh={async () => { await refresh(true); }} onNotice={(message, tone = "success") => setNotice({ message, tone })} />}
          {view === "connection" && <ConnectionView dashboard={dashboard} session={session} syncState={syncState} now={leaseNow} deleting={deletingCurrentConnection} onRemoveLocal={onDeleteCurrentConnection} />}
        </main>
      </div>
      {activeModal?.type === "claim" && <ClaimLeaseModal settings={dashboard.settings} onClose={() => setActiveModal(null)} onSubmit={handleClaim} />}
      {activeModal?.type === "release" && activeReleaseRequest && <ReleaseRequestModal request={activeReleaseRequest} onClose={dismissReleaseRequest} onResolve={(decision, reason) => handleReleaseRequest(activeReleaseRequest.id, decision, reason)} />}
      {activeModal?.type === "close" && <CloseLeaseModal lease={activeModal.lease} onClose={() => setActiveModal(null)} onSubmit={handleClose} />}
      {activeModal?.type === "record" && <RecordModal kind={activeModal.recordKind} leases={dashboard.leases} members={dashboard.members} onClose={() => setActiveModal(null)} onSubmit={handleRecord} />}
      {activeModal?.type === "replace-decision" && <RecordModal kind="decision" leases={dashboard.leases} members={dashboard.members} supersedesDecision={activeModal.decision} onClose={() => setActiveModal(null)} onSubmit={handleRecord} />}
      {notice && <div className={`toast ${notice.tone}`} role="status">{notice.tone === "success" ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}<span>{notice.message}</span><IconButton label="关闭提示" onClick={() => setNotice(null)}><X aria-hidden="true" /></IconButton></div>}
    </div>
  );
}

export function noticeForDeletedConnection(result: DeleteRoomConnectionResult): Notice {
  const warnings = [...result.warnings];
  if (result.remoteCleanup === "pending") {
    warnings.unshift("房间服务当前不可用，远端会话或租约可能要等到过期后才会清理。");
  }
  if (result.codexRestartRequired) {
    warnings.push("Codex 接入配置已经更新，请重启 Codex 使变更完全生效。");
  }
  return {
    tone: warnings.length > 0 ? "warning" : "success",
    message: [
      "房间已从本机移除，本机保存的成员凭证和接入数据已删除。",
      ...warnings,
    ].join(" "),
  };
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [entryNotice, setEntryNotice] = useState<Notice | null>(null);
  const [dashboardNotice, setDashboardNotice] = useState<Notice | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteConnectionTarget | null>(null);
  const [deletingConnectionId, setDeletingConnectionId] = useState<string>();
  const [deleteError, setDeleteError] = useState("");
  const [connectionsRevision, setConnectionsRevision] = useState(0);
  const leave = async () => {
    const connectionId = session?.connectionId;
    let cleanupError: string | undefined;
    if (connectionId && isDesktopApp()) {
      const paused = await pauseSavedConnection(connectionId);
      cleanupError = paused.cleanupError;
    }
    clearSession();
    setSession(null);
    setDashboardNotice(null);
    setEntryNotice(cleanupError
      ? {
          tone: "warning",
          message: `本机 Agent Hub 接入已经暂停，但房间中的会话或租约未能立即清理。请稍后重新进入房间重试，或联系房主确认。原因：${cleanupError}`,
        }
      : null);
  };

  const requestDelete = (connection: DeleteConnectionTarget) => {
    setDeleteError("");
    setDeleteTarget(connection);
  };

  const requestDeleteCurrent = () => {
    if (!session?.connectionId) return;
    requestDelete({
      id: session.connectionId,
      roomName: session.room.name,
      memberName: session.member.name,
      serverUrl: session.serverUrl ?? "",
      repositoryPath: session.repositoryPath ?? "",
    });
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deletingConnectionId) return;
    const target = deleteTarget;
    const deletingCurrent = session?.connectionId === target.id;
    setDeletingConnectionId(target.id);
    setDeleteError("");
    try {
      const result = await deleteSavedConnection(target.id);
      const notice = noticeForDeletedConnection(result);
      setDeleteTarget(null);
      setConnectionsRevision((current) => current + 1);
      if (deletingCurrent) {
        clearSession();
        setSession(null);
        setDashboardNotice(null);
        setEntryNotice(notice);
      } else if (session) {
        setDashboardNotice(notice);
      } else {
        setEntryNotice(notice);
      }
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : "无法从本机移除房间，请重试。");
    } finally {
      setDeletingConnectionId(undefined);
    }
  };

  const content = session
    ? (
        <DashboardApp
          session={session}
          initialNotice={dashboardNotice}
          deletingCurrentConnection={deletingConnectionId === session.connectionId}
          onLeave={leave}
          onDeleteCurrentConnection={requestDeleteCurrent}
        />
      )
    : (
        <EntryScreen
          initialNotice={entryNotice}
          connectionsRevision={connectionsRevision}
          deletingConnectionId={deletingConnectionId}
          onRequestDelete={requestDelete}
          onConnected={(next, notice) => {
            setEntryNotice(null);
            setDashboardNotice(notice ?? null);
            setSession(next);
          }}
        />
      );

  return (
    <>
      {content}
      {deleteTarget && (
        <DeleteConnectionModal
          connection={deleteTarget}
          busy={deletingConnectionId === deleteTarget.id}
          error={deleteError}
          onClose={() => {
            if (deletingConnectionId) return;
            setDeleteTarget(null);
            setDeleteError("");
          }}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </>
  );
}
