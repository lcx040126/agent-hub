import express, { type NextFunction, type Request, type Response } from "express";
import type { RecordKind } from "./domain.js";
import { AgentHubDatabase } from "./db.js";
import { createMcpServiceAdapter } from "./mcp-adapter.js";
import { createMcpRouter } from "./mcp.js";
import {
  AgentHubError,
  AgentHubService,
  type AddRecordInput,
  type CloseLeaseReportInput,
} from "./service.js";
import { UpdateCoordinator } from "./update-coordinator.js";

export interface CreateAgentHubAppOptions {
  database?: AgentHubDatabase;
  databasePath?: string;
  dataDir?: string;
  service?: AgentHubService;
  mcpUrl?: string;
  includeNotFound?: boolean;
  updateCoordinator?: UpdateCoordinator;
}

export function createAgentHubApp(options: CreateAgentHubAppOptions = {}): express.Express {
  const database =
    options.database ??
    options.service?.database ??
    new AgentHubDatabase({
      path: options.databasePath,
      dataDir: options.dataDir,
    });
  const service = options.service ?? new AgentHubService(database);
  const app = express();
  app.locals.agentHubService = service;
  app.locals.agentHubDatabase = database;
  const updates = options.updateCoordinator;

  app.use((request, response, next) => {
    const origin = request.header("origin");
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: "256kb" }));
  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok", service: "agent-hub", version: "0.1.0", protocolVersion: 1, schemaVersion: 2, update: updates?.getStatus() ?? { state: "unconfigured" } });
  });

  app.get("/api/update/status", (request, response) => {
    service.authenticateMemberToken(bearerToken(request));
    response.json({ update: updates?.getStatus() ?? { state: "unconfigured" } });
  });

  app.post("/api/update/check", async (request, response) => {
    const auth = service.authenticateMemberToken(bearerToken(request));
    if (auth.member.role !== "host") throw new AgentHubError("owner_required", "Only the room owner can check for updates.", 403);
    if (!updates) throw new AgentHubError("update_unconfigured", "No update source is configured.", 503);
    response.json({ update: await updates.check() });
  });

  app.post("/api/update/stage", async (request, response) => {
    const auth = service.authenticateMemberToken(bearerToken(request));
    if (auth.member.role !== "host") throw new AgentHubError("owner_required", "Only the room owner can stage updates.", 403);
    if (!updates) throw new AgentHubError("update_unconfigured", "No update source is configured.", 503);
    response.json({ update: await updates.stage(), backup: await updates.backupDatabase() });
  });

  app.post("/api/rooms", (request, response) => {
    const body = bodyObject(request);
    const result = service.createRoom({
      name: value(body, "roomName", "name"),
      projectName: optionalValue(body, "projectName", "project"),
      repository: value(body, "repository", "repositoryUrl"),
      defaultBranch: optionalValue(body, "defaultBranch"),
      hostName: value(body, "ownerName", "hostName"),
      hostAgent: optionalValue(body, "clientName", "hostAgent"),
    });
    response.status(201).json({
      token: result.memberToken,
      memberToken: result.memberToken,
      inviteCode: result.roomToken,
      room: roomResponse(result.room),
      member: memberResponse(result.member),
    });
  });

  app.post("/api/rooms/join", (request, response) => {
    const body = bodyObject(request);
    const result = service.joinRoom({
      roomToken: value(body, "inviteCode", "roomToken", "code"),
      displayName: value(body, "memberName", "displayName"),
      agent: optionalValue(body, "clientName", "agent"),
    });
    response.status(201).json({
      token: result.memberToken,
      memberToken: result.memberToken,
      room: roomResponse(result.room),
      member: memberResponse(result.member),
    });
  });

  app.get("/api/dashboard", (request, response) => {
    const token = bearerToken(request);
    const dashboard = service.getDashboard(token);
    response.json({
      room: roomResponse(dashboard.room),
      currentMember: memberResponse(dashboard.currentMember),
      members: dashboard.members.map(memberResponse),
      leases: dashboard.leases.map(leaseResponse),
      conflicts: dashboard.conflicts.map(conflictResponse),
      records: dashboard.records.map(recordResponse),
      activity: dashboard.activity.map(activityResponse),
      sessions: dashboard.sessions,
      localScans: dashboard.localScans,
      server: { mcpUrl: resolveMcpUrl(request, options.mcpUrl) },
    });
  });

  app.get("/api/snapshot", (request, response) => {
    response.json(service.getSnapshot(bearerToken(request)));
  });

  app.get("/api/room/settings", (request, response) => {
    response.json({ settings: service.getRoomSettings(bearerToken(request)) });
  });

  app.post("/api/room/settings", (request, response) => {
    const body = bodyObject(request);
    response.json({ settings: service.updateRoomSettings({ memberToken: bearerToken(request), autoLockAfterAutoClaim: Boolean(body.autoLockAfterAutoClaim) }) });
  });

  app.post("/api/room/members/:id/role", (request, response) => {
    const body = bodyObject(request);
    response.json({ member: memberResponse(service.changeMemberRole({ memberToken: bearerToken(request), targetMemberId: parameter(request, "id"), isAdmin: Boolean(body.isAdmin) })) });
  });

  app.post("/api/room/members/:id/remove", (request, response) => {
    service.removeMember({ memberToken: bearerToken(request), targetMemberId: parameter(request, "id") });
    response.status(204).end();
  });

  app.post("/api/room/transfer", (request, response) => {
    const body = bodyObject(request);
    response.json({ member: memberResponse(service.transferOwnership({ memberToken: bearerToken(request), targetMemberId: value(body, "targetMemberId") })) });
  });

  app.post("/api/room/dissolve", (request, response) => {
    service.dissolveRoom(bearerToken(request));
    response.status(204).end();
  });

  app.get("/api/room/context/export", (request, response) => {
    response.json(service.exportContext(bearerToken(request)));
  });

  app.post("/api/room/context/import", (request, response) => {
    response.json(service.importContext({ memberToken: bearerToken(request), payload: request.body }));
  });

  app.get("/api/context", (request, response) => {
    response.json(service.getRelevantContext(bearerToken(request), queryPaths(request)));
  });

  app.post("/api/context", (request, response) => {
    const body = bodyObject(request);
    const entry = service.addContextEntry({
      memberToken: bearerToken(request),
      kind: value(body, "kind") as Parameters<AgentHubService["addContextEntry"]>[0]["kind"],
      title: value(body, "title"),
      content: value(body, "content", "summary"),
      paths: stringArrayValue(body.paths),
    });
    response.status(201).json({ entry });
  });

  app.post("/api/leases", (request, response) => {
    const body = bodyObject(request);
    const ttlMinutes = optionalNumber(body.ttlMinutes);
    const result = service.claimLease({
      memberToken: bearerToken(request),
      sessionId: optionalValue(body, "sessionId"),
      title: value(body, "title"),
      objective: optionalValue(body, "intent", "objective", "description"),
      branch: optionalValue(body, "branch"),
      baseCommit: optionalValue(body, "baseCommit"),
      paths: stringArrayValue(body.paths),
      mode: optionalValue(body, "mode") as "read" | "write" | undefined,
      overrideReason: optionalValue(body, "overrideReason"),
      autoClaim: body.autoClaim === true,
      ttlMs: ttlMinutes === undefined ? optionalNumber(body.ttlMs) : ttlMinutes * 60_000,
    });
    response.status(result.acquired ? 201 : 200).json({
      acquired: result.acquired,
      decision: result.decision,
      lease: result.acquired ? leaseResponse(result.lease) : undefined,
      conflicts: result.conflicts.map(conflictResponse),
    });
  });

  app.post("/api/leases/:id/renew", (request, response) => {
    const body = optionalBodyObject(request);
    const ttlMinutes = optionalNumber(body.ttlMinutes);
    const lease = service.renewLease({
      memberToken: bearerToken(request),
      leaseId: parameter(request, "id"),
      sessionId: optionalValue(body, "sessionId"),
      ttlMs: ttlMinutes === undefined ? optionalNumber(body.ttlMs) : ttlMinutes * 60_000,
    });
    response.json({ lease: leaseResponse(lease) });
  });

  app.post("/api/leases/:id/close", (request, response) => {
    const body = bodyObject(request);
    const input: CloseLeaseReportInput = {
      memberToken: bearerToken(request),
      leaseId: parameter(request, "id"),
      sessionId: optionalValue(body, "sessionId"),
      status: body.status === "cancelled" ? "cancelled" : "completed",
      summary: optionalValue(body, "summary"),
      outcome: optionalValue(body, "outcome"),
      changedPaths: stringArrayValue(body.changedPaths),
      commitHash: optionalValue(body, "commitHash"),
      validations: stringArrayValue(body.validations),
      remainingRisks: stringArrayValue(body.remainingRisks),
      handoff: optionalValue(body, "handoff"),
    };
    const result = service.closeLease(input);
    response.json({
      lease: leaseResponse(result.lease),
      records: result.records.map(recordResponse),
    });
  });

  app.post("/api/edits/check", (request, response) => {
    const body = bodyObject(request);
    response.json(
      service.checkEdits({
        memberToken: bearerToken(request),
        sessionId: optionalValue(body, "sessionId"),
        paths: stringArrayValue(body.paths),
        leaseId: optionalValue(body, "leaseId"),
      }),
    );
  });

  app.post("/api/records", (request, response) => {
    const body = bodyObject(request);
    const rawEvidence = body.evidence;
    const input: AddRecordInput = {
      memberToken: bearerToken(request),
      kind: value(body, "kind", "type") as RecordKind,
      title: value(body, "title"),
      summary: value(body, "summary", "content"),
      paths: stringArrayValue(body.paths),
      status: optionalValue(body, "status"),
      evidence:
        typeof rawEvidence === "string"
          ? rawEvidence.trim()
            ? [rawEvidence]
            : []
          : stringArrayValue(rawEvidence),
      commitHash: optionalValue(body, "commitHash"),
    };
    response.status(201).json({ record: recordResponse(service.addRecord(input)) });
  });

  app.post("/api/decisions", (request, response) => {
    const body = bodyObject(request);
    const decision = service.addDecision({
      memberToken: bearerToken(request),
      title: value(body, "title"),
      decision: value(body, "decision", "summary"),
      rationale: optionalValue(body, "rationale"),
      paths: stringArrayValue(body.paths),
    });
    response.status(201).json({ decision });
  });

  app.post("/api/verifications", (request, response) => {
    const body = bodyObject(request);
    const verification = service.addVerification({
      memberToken: bearerToken(request),
      leaseId: optionalValue(body, "leaseId"),
      kind: value(body, "kind") as Parameters<AgentHubService["addVerification"]>[0]["kind"],
      result: value(body, "result") as Parameters<AgentHubService["addVerification"]>[0]["result"],
      summary: value(body, "summary"),
      command: optionalValue(body, "command"),
      evidence: optionalValue(body, "evidence"),
    });
    response.status(201).json({ verification });
  });

  app.post("/api/handoffs", (request, response) => {
    const body = bodyObject(request);
    const handoff = service.addHandoff({
      memberToken: bearerToken(request),
      leaseId: optionalValue(body, "leaseId"),
      toMemberId: optionalValue(body, "toMemberId"),
      summary: value(body, "summary"),
      completed: stringArrayValue(body.completed),
      remaining: stringArrayValue(body.remaining),
      risks: stringArrayValue(body.risks),
    });
    response.status(201).json({ handoff });
  });

  app.get("/api/activity", (request, response) => {
    const limit = optionalNumber(request.query.limit);
    const after = typeof request.query.after === "string" ? request.query.after : undefined;
    response.json({
      activity: service.listActivity({ memberToken: bearerToken(request), limit, after }),
    });
  });

  app.post("/api/sessions", (request, response) => {
    const body = bodyObject(request);
    const session = service.openSession({
      memberToken: bearerToken(request),
      clientName: optionalValue(body, "clientName"),
      agentName: optionalValue(body, "agentName"),
      repository: optionalValue(body, "repository"),
      branch: optionalValue(body, "branch"),
      worktree: optionalValue(body, "worktree"),
      baseCommit: optionalValue(body, "baseCommit"),
      task: optionalValue(body, "task"),
      metadata: objectOrUndefined(body.metadata),
    });
    response.status(201).json({ session });
  });

  app.get("/api/sessions", (request, response) => {
    response.json(service.listRoomSessions(bearerToken(request)));
  });

  app.post("/api/sessions/:id/scan", (request, response) => {
    const body = bodyObject(request);
    const scan = service.recordLocalScan({
      memberToken: bearerToken(request),
      sessionId: parameter(request, "id"),
      repository: optionalValue(body, "repository"),
      branch: optionalValue(body, "branch"),
      worktree: optionalValue(body, "worktree"),
      baseCommit: optionalValue(body, "baseCommit"),
      changedPaths: stringArrayValue(body.changedPaths),
      ruleFiles: stringArrayValue(body.ruleFiles),
      systems: stringArrayValue(body.systems),
      metadata: objectOrUndefined(body.metadata),
    });
    response.status(201).json({ scan });
  });

  app.post("/api/sessions/:id/sync", (request, response) => {
    const body = bodyObject(request);
    response.json({ session: service.syncSessionBranch({ memberToken: bearerToken(request), sessionId: parameter(request, "id"), branch: optionalValue(body, "branch"), baseCommit: optionalValue(body, "baseCommit") }) });
  });

  app.post("/api/sessions/:id/rebaseline", (request, response) => {
    const body = bodyObject(request);
    response.json({ session: service.rebaselineSession({ memberToken: bearerToken(request), sessionId: parameter(request, "id"), branch: optionalValue(body, "branch"), baseCommit: optionalValue(body, "baseCommit") }) });
  });

  app.post("/api/sessions/:id/close", (request, response) => {
    const body = bodyObject(request);
    const session = service.closeSession({
      memberToken: bearerToken(request),
      sessionId: parameter(request, "id"),
      summary: optionalValue(body, "summary"),
    });
    response.json({ session });
  });

  app.use("/mcp", createMcpRouter(createMcpServiceAdapter(service)));
  if (options.includeNotFound !== false) {
    app.use((_request, response) => {
      response.status(404).json({ error: "not_found", message: "Endpoint not found." });
    });
  }
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof AgentHubError) {
      response.status(error.status).json({
        error: error.code,
        message: error.message,
        details: error.details,
      });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "invalid_json", message: "The request body is invalid JSON." });
      return;
    }
    console.error(error);
    response.status(500).json({ error: "internal_error", message: "The request could not be completed." });
  });

  return app;
}

function roomResponse(room: ReturnType<AgentHubService["authenticateMemberToken"]>["room"]) {
  return {
    id: room.id,
    code: room.code,
    inviteCode: room.code,
    name: room.name,
    roomName: room.name,
    projectName: room.projectName,
    repository: room.repository,
    defaultBranch: room.defaultBranch,
    createdAt: room.createdAt,
    status: room.status,
    autoLockAfterAutoClaim: room.autoLockAfterAutoClaim,
  };
}

function memberResponse(member: ReturnType<AgentHubService["authenticateMemberToken"]>["member"]) {
  return {
    id: member.id,
    name: member.displayName,
    displayName: member.displayName,
    role: member.role === "host" ? "owner" : member.isAdmin ? "admin" : "member",
    isAdmin: member.isAdmin,
    removedAt: member.removedAt ?? undefined,
    clientName: member.agent ?? undefined,
    agent: member.agent,
    lastSeenAt: member.lastSeenAt,
    joinedAt: member.createdAt,
  };
}

function leaseResponse(lease: ReturnType<AgentHubService["renewLease"]>) {
  return {
    id: lease.id,
    sessionId: lease.sessionId ?? undefined,
    memberId: lease.memberId,
    memberName: lease.memberName,
    title: lease.title,
    intent: lease.objective ?? "",
    objective: lease.objective,
    branch: lease.branch ?? "",
    baseCommit: lease.baseCommit ?? undefined,
    paths: lease.paths.map((path) => path.path),
    pathDetails: lease.paths,
    mode: lease.mode,
    status: lease.status === "cancelled" ? "released" : lease.status,
    decision: lease.decision,
    overrideReason: lease.overrideReason ?? undefined,
    expiresAt: lease.expiresAt,
    createdAt: lease.createdAt,
    updatedAt: lease.updatedAt,
  };
}

function conflictResponse(conflict: ReturnType<AgentHubService["claimLease"]>["conflicts"][number]) {
  const severity = conflict.severity === "blocking" ? "critical" : "warning";
  return {
    id: conflict.id,
    title: conflict.severity === "blocking" ? "Exclusive scope overlap" : "Registered scope overlap",
    summary: conflict.reason,
    severity,
    decision: conflict.decision,
    requestedPath: conflict.requestedPath,
    conflictingPath: conflict.existingPath,
    paths: [conflict.requestedPath, conflict.existingPath],
    leaseId: conflict.leaseId,
    memberId: conflict.memberId,
    memberName: conflict.memberName,
    memberNames: [conflict.memberName],
    reason: conflict.reason,
    expiresAt: conflict.expiresAt,
    status: conflict.decision,
  };
}

function recordResponse(record: ReturnType<AgentHubService["addRecord"]>) {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    summary: record.summary,
    paths: record.paths,
    status: record.status,
    evidence: record.evidence,
    commitHash: record.commitHash ?? undefined,
    memberId: record.memberId,
    memberName: record.memberName,
    createdAt: record.createdAt,
  };
}

function activityResponse(activity: ReturnType<AgentHubService["listActivity"]>[number]) {
  return {
    id: activity.id,
    type: activity.type,
    actorName: activity.actorName ?? "Agent Hub",
    memberName: activity.actorName ?? undefined,
    title: activity.summary,
    summary: activity.summary,
    metadata: activity.metadata,
    createdAt: activity.createdAt,
  };
}

function bodyObject(request: Request): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new AgentHubError("invalid_input", "A JSON object body is required.");
  }
  return request.body as Record<string, unknown>;
}

function optionalBodyObject(request: Request): Record<string, unknown> {
  if (request.body === undefined || request.body === null) return {};
  return bodyObject(request);
}

function value(body: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof body[key] === "string") return body[key];
  }
  return "";
}

function optionalValue(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof body[key] === "string") return body[key];
  }
  return undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new AgentHubError("invalid_input", "Expected a finite number.");
  }
  return number;
}

function bearerToken(request: Request): string {
  const authorization = request.header("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new AgentHubError("unauthorized", "A Bearer member token is required.", 401);
  }
  return match[1].trim();
}

function parameter(request: Request, name: string): string {
  const raw = request.params[name];
  return Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
}

function queryPaths(request: Request): string[] {
  const raw = request.query.paths ?? request.query.path;
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return values.flatMap((entry) =>
    typeof entry === "string" ? entry.split(",").map((value) => value.trim()).filter(Boolean) : [],
  );
}

function resolveMcpUrl(request: Request, configured?: string): string {
  if (configured) return configured;
  return `${request.protocol}://${request.get("host") ?? "127.0.0.1"}/mcp`;
}
