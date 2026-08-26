import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
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
  KeyRound,
  Layers3,
  Link2,
  LoaderCircle,
  LogOut,
  Menu,
  Network,
  Plus,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
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
  clearSession,
  chooseRepository,
  closeLease,
  createLease,
  createRecord,
  createRoom,
  getDashboard,
  manageMember,
  transferOwnership,
  dissolveRoom,
  exportRoomContext,
  importRoomContext,
  rebaselineSession,
  checkForUpdate,
  stageUpdate,
  applyRoomServerUpdate,
  updateRoomSettings,
  getDesktopServerInfo,
  installCodexConnection,
  isDesktopApp,
  joinRoom,
  listSavedConnections,
  loadSession,
  renewLease,
  resumeSavedConnection,
  saveSession,
  secureDesktopSession,
  type Conflict,
  type CreateRecordInput,
  type Dashboard,
  type Lease,
  type ProjectRecord,
  type RecordKind,
  type SavedRoomConnection,
  type Session,
} from "./api";

type View = "work" | "records" | "connection" | "management";
type Notice = { tone: "success" | "warning" | "danger"; message: string };

const ACTIVE_STATUSES = new Set(["active", "pending", "working"]);

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

function timeUntil(value?: string): string {
  if (!value) return "持续保护";
  const remaining = new Date(value).getTime() - Date.now();
  if (remaining <= 0) return "等待刷新";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes} 分钟后续期`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时后续期`;
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
}: {
  title: string;
  detail?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
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
          <IconButton label="关闭" onClick={onClose}>
            <X aria-hidden="true" />
          </IconButton>
        </header>
        {children}
      </section>
    </div>
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

function EntryScreen({ onConnected }: { onConnected: (session: Session) => void }) {
  const desktop = isDesktopApp();
  const [mode, setMode] = useState<"create" | "join">("create");
  const [busy, setBusy] = useState(false);
  const [repoBusy, setRepoBusy] = useState(false);
  const [error, setError] = useState("");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [savedConnections, setSavedConnections] = useState<SavedRoomConnection[]>([]);
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
  }, [desktop]);

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

  const enterSession = (session: Session) => {
    saveSession(session);
    onConnected(session);
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
      if (desktop) session = await secureDesktopSession(session, session.serverUrl!, repositoryPath);
      enterSession(session);
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
      if (desktop) session = await secureDesktopSession(session, joinValues.serverUrl, repositoryPath);
      enterSession(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加入失败，请检查邀请地址和房间码。");
    } finally {
      setBusy(false);
    }
  };

  const openSaved = (connection: SavedRoomConnection) => {
    const session = resumeSavedConnection(connection);
    enterSession(session);
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
          {desktop && savedConnections.length > 0 && (
            <section className="saved-connections" aria-labelledby="saved-title">
              <div><span className="section-kicker">快速返回</span><h2 id="saved-title">已保存的房间</h2></div>
              <div className="saved-connection-list">
                {savedConnections.slice(0, 3).map((connection) => (
                  <button type="button" key={connection.id} onClick={() => openSaved(connection)}>
                    <span><Server aria-hidden="true" /></span>
                    <div><strong>{connection.roomName || "项目协作房间"}</strong><small>{connection.memberName || "已保存成员"} · {connection.serverUrl}</small></div>
                    <ChevronRight aria-hidden="true" />
                  </button>
                ))}
              </div>
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
    </main>
  );
}

function AppNav({ view, onChange, open, onClose }: { view: View; onChange: (view: View) => void; open: boolean; onClose: () => void }) {
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
        <div className="automation-note">
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>自动保护已开启</strong>
            <span>日常无需手动维护范围</span>
          </div>
        </div>
      </aside>
    </>
  );
}

function ManagementView({ dashboard, session, onRefresh, onNotice }: { dashboard: Dashboard; session: Session; onRefresh: () => Promise<void>; onNotice: (message: string, tone?: Notice["tone"]) => void }) {
  const canManage = dashboard.currentMember.role === "host" || dashboard.currentMember.isAdmin;
  const isOwner = dashboard.currentMember.role === "host";
  const [busy, setBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<Record<string, unknown> | null>(null);
  if (!canManage) return <EmptyState icon={<Settings aria-hidden="true" />} title="没有房间管理权限" detail="只有房主和管理员可以查看这里。" />;
  const run = async (operation: () => Promise<void>, success: string) => { setBusy(true); try { await operation(); onNotice(success); await onRefresh(); } catch (error) { onNotice(error instanceof Error ? error.message : "操作失败。", "danger"); } finally { setBusy(false); } };
  const download = async () => { const payload = await exportRoomContext(session); const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${dashboard.room.name}-context.json`; anchor.click(); URL.revokeObjectURL(url); onNotice("房间上下文已导出。"); };
  const checkUpdate = () => void run(async () => { setUpdateStatus(await checkForUpdate(session)); }, "更新检查完成。");
  const stageUpdatePackage = () => void run(async () => { setUpdateStatus(await stageUpdate(session)); }, "更新包已校验并准备就绪。");
  const applyUpdate = () => void run(async () => { await applyRoomServerUpdate(); setUpdateStatus({ state: "restarted" }); }, "房间服务已重启，连接将自动恢复。");
  return <div className="content-grid wide-main"><section className="section-block" aria-labelledby="management-title"><div className="section-heading"><div><span className="section-kicker">房间管理</span><h2 id="management-title">成员与房间设置</h2></div></div><div className="management-settings"><label className="toggle-row"><span><strong>自动领取后强制锁定范围</strong><small>开启后，自动领取的重叠范围会直接阻止写入。</small></span><input type="checkbox" checked={dashboard.room.autoLockAfterAutoClaim !== false} disabled={busy} onChange={(event) => void run(() => updateRoomSettings(session, event.target.checked), "房间设置已更新。")} /></label></div><div className="management-actions"><button type="button" className="secondary-button" onClick={() => void download()}><Download aria-hidden="true" />导出上下文</button><label className="secondary-button"><Upload aria-hidden="true" />导入上下文<input type="file" accept="application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; void file.text().then((text) => { try { return run(() => importRoomContext(session, JSON.parse(text)).then(() => undefined), "上下文已追加导入。"); } catch (error) { onNotice(error instanceof Error ? error.message : "导入文件格式不正确。", "danger"); } }); }} /></label>{isOwner && <><button type="button" className="secondary-button" disabled={busy} onClick={checkUpdate}><RefreshCw aria-hidden="true" />检查更新</button>{updateStatus?.state === "available" && <button type="button" className="secondary-button" disabled={busy} onClick={stageUpdatePackage}><Download aria-hidden="true" />准备更新</button>}</>}</div>{updateStatus && <div className="update-status" role="status">更新状态：{String(updateStatus.state)}{updateStatus.availableVersion ? ` · ${String(updateStatus.availableVersion)}` : ""}{updateStatus.error ? ` · ${String(updateStatus.error)}` : ""}</div>}<div className="member-management-list">{dashboard.members.map((member) => <div className="member-management-row" key={member.id}><div><strong>{member.name}</strong><small>{member.role === "host" ? "房主" : member.isAdmin ? "管理员" : "成员"}</small></div>{member.id !== dashboard.currentMember.id && member.role !== "host" && <div className="member-management-actions">{isOwner && <button type="button" className="text-button" disabled={busy} onClick={() => void run(() => manageMember(session, member.id, "admin", !member.isAdmin), member.isAdmin ? "管理员权限已撤销。" : "管理员权限已授予。")}>{member.isAdmin ? "撤销管理员" : "设为管理员"}</button>}{(isOwner || (!member.isAdmin && dashboard.currentMember.isAdmin)) && <button type="button" className="text-button danger" disabled={busy} onClick={() => void run(() => manageMember(session, member.id, "remove"), "成员已移出房间。")}>踢出</button>}{isOwner && <button type="button" className="text-button" disabled={busy} onClick={() => void run(() => transferOwnership(session, member.id), "房主已交接。")}>交接房主</button>}</div>}</div>)}</div><div className="member-management-list">{dashboard.sessions.filter((item) => item.status === "frozen").map((item) => <div className="member-management-row" key={item.id}><div><strong>会话已冻结</strong><small>{item.branch || "新分支"} · {item.baseCommit || "未记录基线"}</small></div><button type="button" className="text-button" disabled={busy} onClick={() => void run(() => rebaselineSession(session, item.id, item.branch || dashboard.room.defaultBranch, item.baseCommit || "0000000"), "会话已重新建立基线。")}>重新建立基线</button></div>)}</div>{isOwner && <button type="button" className="danger-button" disabled={busy} onClick={() => { if (window.confirm("确定解散房间吗？")) void run(() => dissolveRoom(session), "房间已解散。"); }}><XCircle aria-hidden="true" />解散房间</button>}</section></div>;
}

function UpdateControl({ session, onNotice }: { session: Session; onNotice: (message: string, tone?: Notice["tone"]) => void }) {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (operation: () => Promise<Record<string, unknown> | void>, success: string) => {
    setBusy(true);
    try { setStatus((await operation()) as Record<string, unknown> | undefined ?? status); onNotice(success); }
    catch (error) { onNotice(error instanceof Error ? error.message : "更新操作失败。", "danger"); }
    finally { setBusy(false); }
  };
  return <div className="update-control"><button type="button" className="secondary-button" disabled={busy} onClick={() => void run(() => checkForUpdate(session), "更新检查完成。")}><RefreshCw aria-hidden="true" />检查更新</button>{status?.state === "available" && <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(() => stageUpdate(session), "更新包已准备。")}><Download aria-hidden="true" />准备更新</button>}{status?.state === "staged" && isDesktopApp() && <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(async () => { await applyRoomServerUpdate(); return { state: "restarted" }; }, "房间服务已重启，连接将自动恢复。")}><RefreshCw aria-hidden="true" />应用更新</button>}{status && <small>更新状态：{String(status.state)}{status.availableVersion ? ` · ${String(status.availableVersion)}` : ""}</small>}</div>;
}

function StatusSummary({ dashboard, online, conflicts }: { dashboard: Dashboard; online: boolean; conflicts?: Conflict[] }) {
  const activeLeases = dashboard.leases.filter((lease) => ACTIVE_STATUSES.has(lease.status));
  const blockers = (conflicts ?? dashboard.conflicts).filter((item) => item.severity === "blocking");
  const onlineMembers = dashboard.members.filter((member) => member.status === "online").length;
  return (
    <section className={`status-summary ${online ? "healthy" : "offline"}`} aria-label="协作状态">
      <div className="status-primary">
        <span className="status-signal"><Radio aria-hidden="true" /></span>
        <div>
          <strong>{online ? (blockers.length ? "需要处理协作阻塞" : "团队协作正常") : "正在重新连接房间"}</strong>
          <span>
            {online
              ? blockers.length
                ? `${blockers.length} 项阻塞尚未解决，相关工作不会进入共享结果`
                : "系统正在后台同步工作范围与项目上下文"
              : "已保留最近一次同步内容，不会丢失本地工作"}
          </span>
        </div>
      </div>
      <div className="status-metrics">
        <span><b>{activeLeases.length}</b> 进行中</span>
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
          <div className="member-chip" key={member.id} title={`${member.name} · ${member.agent ?? "Agent 未上报"}`}>
            <span className={`presence ${member.status}`} />
            <span className="member-avatar">{member.name.slice(0, 1).toUpperCase()}</span>
            <span className="member-copy">
              <strong>{member.name}{member.id === dashboard.currentMember.id ? "（你）" : ""}</strong>
              <small>{member.role === "host" ? "房主" : member.agent ?? "成员"}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function WorkItem({
  lease,
  own,
  busy,
  onRenew,
  onClose,
}: {
  lease: Lease;
  own: boolean;
  busy: boolean;
  onRenew: (lease: Lease) => void;
  onClose: (lease: Lease) => void;
}) {
  return (
    <article className={`work-item ${own ? "own" : ""}`}>
      <div className="work-state" aria-hidden="true"><span /></div>
      <div className="work-main">
        <div className="work-title-row">
          <div>
            <div className="work-owner"><span>{lease.memberName}</span>{own && <em>你的工作</em>}</div>
            <h3>{lease.title}</h3>
          </div>
          <span className="lease-time"><Clock3 aria-hidden="true" />{timeUntil(lease.expiresAt)}</span>
        </div>
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
      </div>
      {own && (
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

function SystemImpact({ dashboard }: { dashboard: Dashboard }) {
  const systems = useMemo(() => {
    const map = new Map<string, { paths: Set<string>; members: Set<string>; highRisk: boolean }>();
    for (const lease of dashboard.leases.filter((item) => ACTIVE_STATUSES.has(item.status))) {
      for (const path of lease.paths.length ? lease.paths : ["整个项目"] ) {
        const name = getSystemName(path);
        const item = map.get(name) ?? { paths: new Set(), members: new Set(), highRisk: false };
        item.paths.add(path);
        item.members.add(lease.memberName);
        item.highRisk ||= lease.highRiskPaths.includes(path);
        map.set(name, item);
      }
    }
    for (const scan of dashboard.localScans) {
      const memberName = dashboard.members.find((member) => member.id === scan.memberId)?.name ?? "本地组件";
      const discovered = scan.systems.length ? scan.systems : scan.changedPaths.map(getSystemName);
      for (const name of discovered) {
        const item = map.get(name) ?? { paths: new Set(), members: new Set(), highRisk: false };
        const relatedPaths = scan.changedPaths.filter((path) => getSystemName(path) === name);
        for (const path of relatedPaths.length ? relatedPaths : [name]) item.paths.add(path);
        item.members.add(memberName);
        item.highRisk ||= relatedPaths.some((path) => /\.(unity|prefab|asset|meta|controller|xlsx|csv)$/i.test(path) || /^ProjectSettings\//i.test(path));
        map.set(name, item);
      }
    }
    return [...map.entries()].map(([name, item]) => ({ name, ...item }));
  }, [dashboard]);

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

function ConflictList({ conflicts }: { conflicts: Conflict[] }) {
  return (
    <section className="section-block" aria-labelledby="conflict-title">
      <div className="section-heading">
        <div>
          <span className="section-kicker">风险控制</span>
          <h2 id="conflict-title">冲突与阻塞</h2>
        </div>
        {conflicts.length > 0 && <span className="quiet-count danger">{conflicts.length} 项</span>}
      </div>
      {conflicts.length ? (
        <div className="conflict-list">
          {conflicts.map((conflict) => (
            <article className={`conflict-item ${conflict.severity}`} key={conflict.id}>
              <span className="conflict-icon">
                {conflict.severity === "blocking" ? <XCircle aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
              </span>
              <div>
                <div className="conflict-title-line">
                  <strong>{conflict.title}</strong>
                  <span>{conflict.severity === "blocking" ? "已阻止" : "需要关注"}</span>
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

function WorkView({
  dashboard,
  busyLeaseId,
  transientConflicts,
  onClaim,
  onRenew,
  onClose,
}: {
  dashboard: Dashboard;
  busyLeaseId?: string;
  transientConflicts: Conflict[];
  onClaim: () => void;
  onRenew: (lease: Lease) => void;
  onClose: (lease: Lease) => void;
}) {
  const leases = dashboard.leases.filter((lease) => ACTIVE_STATUSES.has(lease.status));
  const ownLeases = leases.filter((lease) => lease.memberId === dashboard.currentMember.id || lease.memberName === dashboard.currentMember.name);
  const otherLeases = leases.filter((lease) => !ownLeases.includes(lease));
  const activeSessions = dashboard.sessions.filter((session) => session.status === "active");
  const conflicts = [...transientConflicts, ...dashboard.conflicts];
  return (
    <>
      <MemberStrip dashboard={dashboard} />
      <div className="content-grid wide-main">
        <section className="section-block" aria-labelledby="work-title">
          <div className="section-heading">
            <div>
              <span className="section-kicker">实时工作</span>
              <h2 id="work-title">团队当前正在做什么</h2>
            </div>
            <button type="button" className="secondary-button" onClick={onClaim}>
              <Plus aria-hidden="true" />诊断领取
            </button>
          </div>
          {leases.length || activeSessions.length ? (
            <>
              {leases.length > 0 && <div className="work-list">
              {ownLeases.map((lease) => <WorkItem key={lease.id} lease={lease} own busy={busyLeaseId === lease.id} onRenew={onRenew} onClose={onClose} />)}
              {otherLeases.map((lease) => <WorkItem key={lease.id} lease={lease} own={false} busy={false} onRenew={onRenew} onClose={onClose} />)}
              </div>}
              {activeSessions.length > 0 && (
                <div className="session-list" aria-label="Agent 实时活动">
                  <span className="session-list-label"><Radio aria-hidden="true" />Agent 实时活动</span>
                  {activeSessions.map((agentSession) => {
                    const member = dashboard.members.find((item) => item.id === agentSession.memberId);
                    return (
                      <div className="agent-session-row" key={agentSession.id}>
                        <span className="session-pulse" />
                        <div>
                          <strong>{member?.name ?? "团队成员"}</strong>
                          <p>{agentSession.task || "正在分析项目与同步工作范围"}</p>
                        </div>
                        <small>{agentSession.agentName || agentSession.clientName || "本地组件"}{agentSession.branch ? ` · ${agentSession.branch}` : ""}</small>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <EmptyState icon={<Bot aria-hidden="true" />} title="团队还没有开始登记工作" detail="本地组件连接后，Agent 的任务会自动出现在这里。" />
          )}
          <p className="automation-caption"><Bot aria-hidden="true" />正常情况下由本地组件自动领取、续期和释放。手动入口只用于诊断或离线补登记。</p>
        </section>
        <aside className="right-column">
          <SystemImpact dashboard={dashboard} />
          <RecentActivity dashboard={dashboard} />
        </aside>
      </div>
      <ConflictList conflicts={conflicts} />
    </>
  );
}

function RecordsView({ dashboard, onAdd }: { dashboard: Dashboard; onAdd: (kind: Exclude<RecordKind, "context">) => void }) {
  const [filter, setFilter] = useState<RecordKind | "all">("all");
  const records = filter === "all" ? dashboard.records : dashboard.records.filter((record) => record.kind === filter);
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
        <span><CheckCircle2 aria-hidden="true" /><b>{dashboard.records.filter((item) => item.kind === "decision").length}</b> 项决定</span>
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
          {records.map((record) => <RecordItem record={record} key={`${record.kind}-${record.id}`} />)}
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

function RecordItem({ record }: { record: ProjectRecord }) {
  const isPassed = record.kind === "validation" && ["passed", "pass", "success"].includes(record.status ?? "");
  const isFailed = record.kind === "validation" && ["failed", "fail"].includes(record.status ?? "");
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

function ConnectionView({ dashboard, session, online }: { dashboard: Dashboard; session: Session; online: boolean }) {
  const currentSessions = dashboard.sessions.filter((item) => item.memberId === dashboard.currentMember.id && item.status === "active");
  const latestScan = dashboard.localScans
    .filter((item) => item.memberId === dashboard.currentMember.id)
    .sort((left, right) => (right.scannedAt ?? "").localeCompare(left.scannedAt ?? ""))[0];
  const agentOnline = currentSessions.length > 0;
  const connectedAgent = currentSessions[0]?.agentName || currentSessions[0]?.clientName || dashboard.currentMember.agent;
  const invite = session.roomToken || dashboard.room.code || "房间码暂不可用";
  const [inviteAddress, setInviteAddress] = useState(session.inviteServerUrl || session.serverUrl || window.location.origin);
  const [installing, setInstalling] = useState(false);
  const [installMessage, setInstallMessage] = useState("");

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
        <div className={online ? "connected" : "disconnected"}>
          <span><Server aria-hidden="true" /></span>
          <div><strong>房间服务</strong><small>{online ? "已连接，团队状态正在同步" : "连接中断，正在自动重试"}</small></div>
          <em>{online ? "在线" : "离线"}</em>
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
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (input: { title: string; objective: string; branch: string; baseCommit: string; paths: string[]; ttlMinutes: number }) => Promise<void>;
}) {
  const [values, setValues] = useState({ title: "", objective: "", branch: "", baseCommit: "", paths: "", ttlMinutes: 120 });
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
    <Modal title="手动领取工作范围" detail="用于本地组件尚未连接时的诊断与兜底。" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <Field label="工作名称"><input required maxLength={120} placeholder="例如：调整背包与装备切换" value={values.title} onChange={(event) => setValues({ ...values, title: event.target.value })} /></Field>
        <Field label="目标"><textarea rows={3} maxLength={1000} placeholder="简要说明准备完成什么" value={values.objective} onChange={(event) => setValues({ ...values, objective: event.target.value })} /></Field>
        <div className="field-grid two-columns">
          <Field label="当前分支"><input placeholder="feature/inventory" value={values.branch} onChange={(event) => setValues({ ...values, branch: event.target.value })} /></Field>
          <Field label="基准提交"><input placeholder="提交哈希，可留空" value={values.baseCommit} onChange={(event) => setValues({ ...values, baseCommit: event.target.value })} /></Field>
        </div>
        <Field label="预计修改范围" hint="每行一个相对项目根目录的文件或目录。"><textarea className="path-input" required rows={5} placeholder={"Assets/Vanguard/Inventory\nAssets/Vanguard/Equipment/Weapon.cs"} value={values.paths} onChange={(event) => setValues({ ...values, paths: event.target.value })} /></Field>
        <fieldset className="choice-field"><legend>保护时长</legend><div className="segmented-control compact">{[60, 120, 240].map((minutes) => <button type="button" key={minutes} className={values.ttlMinutes === minutes ? "active" : ""} onClick={() => setValues({ ...values, ttlMinutes: minutes })}>{minutes / 60} 小时</button>)}</div></fieldset>
        {error && <div className="form-error"><AlertTriangle aria-hidden="true" />{error}</div>}
        <div className="modal-actions"><button type="button" className="text-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}检查并领取</button></div>
      </form>
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

function RecordModal({ kind, leases, members, onClose, onSubmit }: { kind: Exclude<RecordKind, "context">; leases: Lease[]; members: Dashboard["members"]; onClose: () => void; onSubmit: (input: CreateRecordInput) => Promise<void> }) {
  const [values, setValues] = useState({ title: "", summary: "", paths: "", status: kind === "validation" ? "passed" : "", evidence: "", command: "", leaseId: "", toMemberId: "", completed: "", remaining: "", risks: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const titles = { decision: "记录团队决定", validation: "补充验证结果", handoff: "补充工作交接", risk: "登记项目风险" };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        kind,
        title: values.title || recordLabel(kind),
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
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={titles[kind]} detail="这类信息通常由 Agent 自动记录，必要时可以在这里补充。" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        {kind === "validation" ? (
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
          <Field label="标题"><input required={kind !== "handoff"} maxLength={160} placeholder="简短描述这条记录" value={values.title} onChange={(event) => setValues({ ...values, title: event.target.value })} /></Field>
        )}
        <Field label={kind === "decision" ? "最终决定" : kind === "validation" ? "验证结果摘要" : kind === "handoff" ? "交接摘要" : "风险说明"}><textarea required rows={4} value={values.summary} onChange={(event) => setValues({ ...values, summary: event.target.value })} /></Field>
        {kind === "validation" && <div className="field-grid two-columns"><Field label="结果"><select value={values.status} onChange={(event) => setValues({ ...values, status: event.target.value })}><option value="passed">通过</option><option value="failed">失败</option><option value="pending">待验证</option></select></Field><Field label="关联工作"><select value={values.leaseId} onChange={(event) => setValues({ ...values, leaseId: event.target.value })}><option value="">不指定</option>{leases.map((lease) => <option value={lease.id} key={lease.id}>{lease.title}</option>)}</select></Field></div>}
        {kind === "handoff" && <><div className="field-grid two-columns"><Field label="交接给"><select value={values.toMemberId} onChange={(event) => setValues({ ...values, toMemberId: event.target.value })}><option value="">整个团队</option>{members.map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}</select></Field><Field label="关联工作"><select value={values.leaseId} onChange={(event) => setValues({ ...values, leaseId: event.target.value })}><option value="">不指定</option>{leases.map((lease) => <option value={lease.id} key={lease.id}>{lease.title}</option>)}</select></Field></div><Field label="已完成"><textarea rows={2} placeholder="每行一项" value={values.completed} onChange={(event) => setValues({ ...values, completed: event.target.value })} /></Field><div className="field-grid two-columns"><Field label="待处理"><textarea rows={2} value={values.remaining} onChange={(event) => setValues({ ...values, remaining: event.target.value })} /></Field><Field label="风险"><textarea rows={2} value={values.risks} onChange={(event) => setValues({ ...values, risks: event.target.value })} /></Field></div></>}
        {kind !== "handoff" && <Field label="涉及范围" hint="可留空；每行一个相对路径。"><textarea className="path-input" rows={3} value={values.paths} onChange={(event) => setValues({ ...values, paths: event.target.value })} /></Field>}
        {(kind === "decision" || kind === "validation") && <Field label={kind === "decision" ? "判断依据" : "证据或观察"}><textarea rows={2} value={values.evidence} onChange={(event) => setValues({ ...values, evidence: event.target.value })} /></Field>}
        {kind === "validation" && <Field label="执行命令"><input placeholder="没有命令可留空" value={values.command} onChange={(event) => setValues({ ...values, command: event.target.value })} /></Field>}
        {error && <div className="form-error"><AlertTriangle aria-hidden="true" />{error}</div>}
        <div className="modal-actions"><button type="button" className="text-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}保存记录</button></div>
      </form>
    </Modal>
  );
}

function DashboardApp({ session, onLeave }: { session: Session; onLeave: () => void }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [view, setView] = useState<View>("work");
  const [navOpen, setNavOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [online, setOnline] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [claimOpen, setClaimOpen] = useState(false);
  const [closingLease, setClosingLease] = useState<Lease | null>(null);
  const [recordKind, setRecordKind] = useState<Exclude<RecordKind, "context"> | null>(null);
  const [busyLeaseId, setBusyLeaseId] = useState<string>();
  const [transientConflicts, setTransientConflicts] = useState<Conflict[]>([]);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const next = await getDashboard(session, session.roomToken);
      if (!next.currentMember.id) next.currentMember = session.member;
      if (!next.members.some((member) => member.id === next.currentMember.id)) next.members.unshift(next.currentMember);
      setDashboard(next);
      setOnline(true);
      setError("");
    } catch (caught) {
      setOnline(false);
      if (caught instanceof ApiError && caught.status === 401) {
        setError("成员凭证已失效，请重新加入房间。");
      } else if (!quiet) {
        setError(caught instanceof Error ? caught.message : "房间状态加载失败。");
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [session]);

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
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const handleClaim = async (input: { title: string; objective: string; branch: string; baseCommit: string; paths: string[]; ttlMinutes: number }) => {
    const result = await createLease(session, input);
    setTransientConflicts(result.conflicts);
    if (!result.acquired || result.decision === "deny") {
      setNotice({ tone: "danger", message: "范围已被占用，工作没有被登记。冲突详情已显示在当前页面。" });
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
      setClosingLease(null);
      await refresh(true);
    } finally {
      setBusyLeaseId(undefined);
    }
  };

  const handleRecord = async (input: CreateRecordInput) => {
    await createRecord(session, input);
    setNotice({ tone: "success", message: "记录已同步给房间内的 Agent。" });
    await refresh(true);
  };

  if (loading && !dashboard) {
    return <main className="loading-screen"><div className="brand-mark large"><Network /></div><LoaderCircle className="spin" /><strong>正在同步团队现场</strong><span>正在获取工作范围、决定与验证状态</span></main>;
  }

  if (!dashboard) {
    return <main className="fatal-screen"><AlertTriangle aria-hidden="true" /><h1>暂时无法进入房间</h1><p>{error || "房主服务可能尚未启动。"}</p><div><button type="button" className="primary-button" onClick={() => void refresh()}><RefreshCw aria-hidden="true" />重新连接</button><button type="button" className="secondary-button" onClick={onLeave}><LogOut aria-hidden="true" />返回登录</button></div></main>;
  }

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
          <span className={`connection-pill ${online ? "online" : "offline"}`}><span />{online ? "已连接" : "连接中"}</span>
          <IconButton label="刷新团队状态" onClick={() => void refresh()} disabled={refreshing}><RefreshCw className={refreshing ? "spin" : ""} aria-hidden="true" /></IconButton>
          <div className="current-user" title={dashboard.currentMember.name}><span>{dashboard.currentMember.name.slice(0, 1).toUpperCase()}</span><div><strong>{dashboard.currentMember.name}</strong><small>{dashboard.currentMember.role === "host" ? "房主" : "成员"}</small></div></div>
          <IconButton label="离开当前房间" onClick={onLeave}><LogOut aria-hidden="true" /></IconButton>
        </div>
      </header>
      <div className="app-body">
        <AppNav view={view} onChange={setView} open={navOpen} onClose={() => setNavOpen(false)} />
        <main className="workspace">
          <StatusSummary dashboard={dashboard} online={online} conflicts={[...transientConflicts, ...dashboard.conflicts]} />
          {error && <div className="inline-alert"><AlertTriangle aria-hidden="true" />{error}</div>}
          {view === "work" && <WorkView dashboard={dashboard} busyLeaseId={busyLeaseId} transientConflicts={transientConflicts} onClaim={() => setClaimOpen(true)} onRenew={handleRenew} onClose={setClosingLease} />}
          {view === "records" && <RecordsView dashboard={dashboard} onAdd={setRecordKind} />}
          {view === "management" && <><ManagementView dashboard={dashboard} session={session} onRefresh={() => refresh(true)} onNotice={(message, tone = "success") => setNotice({ message, tone })} />{dashboard.currentMember.role === "host" && <UpdateControl session={session} onNotice={(message, tone = "success") => setNotice({ message, tone })} />}</>}
          {view === "connection" && <ConnectionView dashboard={dashboard} session={session} online={online} />}
        </main>
      </div>
      {claimOpen && <ClaimLeaseModal onClose={() => setClaimOpen(false)} onSubmit={handleClaim} />}
      {closingLease && <CloseLeaseModal lease={closingLease} onClose={() => setClosingLease(null)} onSubmit={handleClose} />}
      {recordKind && <RecordModal kind={recordKind} leases={dashboard.leases} members={dashboard.members} onClose={() => setRecordKind(null)} onSubmit={handleRecord} />}
      {notice && <div className={`toast ${notice.tone}`} role="status">{notice.tone === "success" ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}<span>{notice.message}</span><IconButton label="关闭提示" onClick={() => setNotice(null)}><X aria-hidden="true" /></IconButton></div>}
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const leave = () => {
    clearSession();
    setSession(null);
  };
  return session ? <DashboardApp session={session} onLeave={leave} /> : <EntryScreen onConnected={setSession} />;
}
