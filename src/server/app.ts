import express, { type NextFunction, type Request, type Response } from "express";
import type {
  FeatureContractChange,
  FeatureRevisionRelation,
  FeatureRevisionStatus,
  FeatureTargetInput,
  FeatureVerificationEvidence,
  LeaseKind,
  ProposedFeatureEdit,
  RecordKind,
  ReleaseRequestStatus,
} from "./domain.js";
import type { RiskPolicyRule } from "./risk-policy.js";
import {
  AGENT_HUB_PROTOCOL_VERSION,
  AGENT_HUB_SCHEMA_VERSION,
  AGENT_HUB_VERSION,
} from "../shared/version.js";
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

const DASHBOARD_RESPONSE_TARGET_BYTES = 768 * 1024;
const DASHBOARD_RESPONSE_METADATA_RESERVE_BYTES = 4 * 1024;

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
    // 同时核对迁移版本和核心表可读性，避免只靠静态版本常量误报健康。
    const databaseSchema = database.connection.prepare("PRAGMA user_version").get() as {
      user_version?: number;
    };
    if (databaseSchema.user_version !== AGENT_HUB_SCHEMA_VERSION) {
      throw new Error(
        `Agent Hub database schema mismatch: expected ${AGENT_HUB_SCHEMA_VERSION}, received ${String(databaseSchema.user_version)}.`,
      );
    }
    database.connection.prepare("SELECT 1 FROM rooms LIMIT 1").all();
    response.json({
      status: "ok",
      service: "agent-hub",
      version: AGENT_HUB_VERSION,
      protocolVersion: AGENT_HUB_PROTOCOL_VERSION,
      schemaVersion: AGENT_HUB_SCHEMA_VERSION,
      database: { status: "ok", schemaVersion: databaseSchema.user_version },
      update: updates?.getStatus() ?? { state: "unconfigured" },
    });
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
      clientVersion: optionalValue(body, "clientVersion"),
      protocolVersion: optionalNumber(body.protocolVersion),
      schemaVersion: optionalNumber(body.schemaVersion),
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
      clientVersion: optionalValue(body, "clientVersion"),
      protocolVersion: optionalNumber(body.protocolVersion),
      schemaVersion: optionalNumber(body.schemaVersion),
    });
    response.status(201).json({
      token: result.memberToken,
      memberToken: result.memberToken,
      room: roomResponse(result.room),
      member: memberResponse(result.member),
    });
  });

  app.post("/api/member/pause", (request, response) => {
    const body = bodyObject(request);
    response.json(service.pauseMember({
      memberToken: bearerToken(request),
      reason: value(body, "reason"),
      cutoffAt: value(body, "cutoffAt"),
      requestId: value(body, "requestId"),
    }));
  });

  app.get("/api/dashboard", (request, response) => {
    const token = bearerToken(request);
    const dashboard = service.getDashboard(token);
    const body = JSON.stringify(dashboardResponse(
      dashboard,
      resolveMcpUrl(request, options.mcpUrl),
    ));
    if (Buffer.byteLength(body, "utf8") > DASHBOARD_RESPONSE_TARGET_BYTES) {
      response.status(507).json({
        error: "dashboard_capacity_exceeded",
        message: "The dashboard core state exceeds the safe desktop response budget.",
      });
      return;
    }
    response.type("application/json").send(body);
  });

  app.get("/api/snapshot", (request, response) => {
    response.json(service.getSnapshot(bearerToken(request)));
  });

  app.get("/api/room/settings", (request, response) => {
    response.json({ settings: service.getRoomSettings(bearerToken(request)) });
  });

  app.post("/api/room/settings", (request, response) => {
    const body = bodyObject(request);
    response.json({
      settings: service.updateRoomSettings({
        memberToken: bearerToken(request),
        autoLockAfterAutoClaim: optionalBoolean(body.autoLockAfterAutoClaim),
        blockingProtectionEnabled: optionalBoolean(body.blockingProtectionEnabled),
        automaticLeaseTtlMinutes: optionalNumber(body.automaticLeaseTtlMinutes),
        maximumExclusiveLeaseMinutes: optionalNumber(body.maximumExclusiveLeaseMinutes),
        riskRules: body.riskRules === undefined
          ? undefined
          : objectArrayValue(body.riskRules) as unknown as RiskPolicyRule[],
        resetRiskPolicy: optionalBoolean(body.resetRiskPolicy),
      }),
    });
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
    // schema 5 及更早的 Hook 会在这个旧入口发送 autoClaim；来源固定记为 legacy，
    // 新版 UI 仍只能创建人工租约，且不能伪造 mcp/hook 来源。
    const legacyAgentClaim = body.autoClaim === true;
    const result = service.claimLease({
      memberToken: bearerToken(request),
      sessionId: optionalValue(body, "sessionId"),
      title: value(body, "title"),
      objective: optionalValue(body, "intent", "objective", "description"),
      branch: optionalValue(body, "branch"),
      baseCommit: optionalValue(body, "baseCommit"),
      paths: stringArrayValue(body.paths),
      mode: optionalValue(body, "mode") as "read" | "write" | undefined,
      kind: legacyAgentClaim ? "automatic" : optionalValue(body, "kind") as LeaseKind | undefined,
      overrideReason: optionalValue(body, "overrideReason"),
      managedBy: legacyAgentClaim ? "agent" : "manual",
      createdVia: legacyAgentClaim ? "legacy" : "ui",
      ttlMinutes,
      ttlMs: optionalNumber(body.ttlMs),
    });
    response.status(result.acquired ? 201 : 200).json({
      acquired: result.acquired,
      decision: result.decision,
      lease: result.acquired ? leaseResponse(result.lease) : undefined,
      conflicts: result.conflicts.map(conflictResponse),
      releaseRequests: result.releaseRequests,
      coverage: result.coverage,
      waitingFor: "waitingFor" in result ? result.waitingFor : undefined,
    });
  });

  app.get("/api/leases/:id/scope-events", (request, response) => {
    const limit = optionalNumber(request.query.limit);
    const before = typeof request.query.before === "string" ? request.query.before : undefined;
    const result = service.listLeaseScopeEvents(
      bearerToken(request),
      parameter(request, "id"),
      limit,
      before,
    );
    response.json({
      items: result.items.map(activityResponse),
      nextBefore: result.nextBefore,
    });
  });

  app.post("/api/leases/:id/renew", (request, response) => {
    const body = optionalBodyObject(request);
    const ttlMinutes = optionalNumber(body.ttlMinutes);
    const lease = service.renewLease({
      memberToken: bearerToken(request),
      leaseId: parameter(request, "id"),
      sessionId: optionalValue(body, "sessionId"),
      ttlMinutes,
      ttlMs: optionalNumber(body.ttlMs),
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
        proposedEdits: objectArrayValue(body.proposedEdits) as unknown as ProposedFeatureEdit[],
      }),
    );
  });

  app.post("/api/edits/prepare", (request, response) => {
    const body = bodyObject(request);
    const result = service.prepareEdits({
      memberToken: bearerToken(request),
      sessionId: optionalValue(body, "sessionId"),
      title: value(body, "title"),
      objective: optionalValue(body, "intent", "objective", "description"),
      branch: optionalValue(body, "branch"),
      baseCommit: optionalValue(body, "baseCommit"),
      paths: stringArrayValue(body.paths),
      leaseId: optionalValue(body, "leaseId"),
      proposedEdits: objectArrayValue(body.proposedEdits) as unknown as ProposedFeatureEdit[],
      operationId: optionalValue(body, "operationId"),
      turnId: optionalValue(body, "turnId"),
      activityEpoch: optionalNumber(body.activityEpoch),
      invocationId: optionalValue(body, "invocationId"),
      toolName: optionalValue(body, "toolName"),
      stage: optionalValue(body, "stage") as "pre" | "post" | undefined,
      ignoredPaths: stringArrayValue(body.ignoredPaths),
      actualPaths: stringArrayValue(body.actualPaths),
      pathDiagnostics: stringArrayValue(body.pathDiagnostics),
    });
    response.json({
      check: result.check,
      renewedLeases: result.renewedLeases.map(leaseResponse),
      activity: result.activity,
      claim: result.claim ? {
        acquired: result.claim.acquired,
        decision: result.claim.decision,
        lease: result.claim.acquired ? leaseResponse(result.claim.lease) : undefined,
        conflicts: result.claim.conflicts.map(conflictResponse),
        releaseRequests: result.claim.releaseRequests,
        coverage: result.claim.coverage,
        waitingFor: "waitingFor" in result.claim ? result.claim.waitingFor : undefined,
      } : undefined,
      managedLease: result.managedLease ? leaseResponse(result.managedLease) : undefined,
    });
  });

  app.post("/api/sessions/:id/write-blocked", (request, response) => {
    const body = bodyObject(request);
    response.json(service.markWriteBlocked({
      memberToken: bearerToken(request),
      sessionId: parameter(request, "id"),
      dirty: body.dirty === true,
      reason: optionalValue(body, "reason"),
      paths: stringArrayValue(body.paths),
    }));
  });

  app.get("/api/release-requests", (request, response) => {
    const rawStatus = typeof request.query.status === "string" ? request.query.status : undefined;
    const token = bearerToken(request);
    response.json({
      currentMemberId: service.authenticateMemberToken(token).member.id,
      releaseRequests: service.listReleaseRequests({
        memberToken: token,
        status: rawStatus as ReleaseRequestStatus | "all" | undefined,
      }),
    });
  });

  app.post("/api/release-requests/:id/resolve", (request, response) => {
    const body = bodyObject(request);
    const decision = value(body, "decision");
    response.json({
      releaseRequest: service.resolveReleaseRequest({
        memberToken: bearerToken(request),
        requestId: parameter(request, "id"),
        decision: decision as "approve" | "reject",
        reason: optionalValue(body, "reason"),
      }),
    });
  });

  app.post("/api/features/query", (request, response) => {
    const body = bodyObject(request);
    response.json(service.queryFeatureMemories({
      memberToken: bearerToken(request),
      sessionId: optionalValue(body, "sessionId"),
      finalizationId: optionalValue(body, "finalizationId"),
      level: body.level === "detail" ? "detail" : "cards",
      query: optionalValue(body, "query"),
      featureIds: stringArrayValue(body.featureIds),
      paths: stringArrayValue(body.paths),
      systems: stringArrayValue(body.systems),
      symbols: stringArrayValue(body.symbols),
      statuses: stringArrayValue(body.statuses) as FeatureRevisionStatus[],
      limit: optionalNumber(body.limit),
      cursor: optionalValue(body, "cursor"),
    }));
  });

  app.get("/api/features/:id/history", (request, response) => {
    response.json(service.getFeatureHistory(bearerToken(request), parameter(request, "id")));
  });

  app.post("/api/features/revisions", (request, response) => {
    const body = bodyObject(request);
    const revision = service.submitFeatureRevision({
      memberToken: bearerToken(request),
      sessionId: value(body, "sessionId"),
      finalizationId: optionalValue(body, "finalizationId"),
      featureKey: value(body, "featureKey"),
      name: value(body, "name"),
      systemId: value(body, "systemId"),
      parentRevisionId: optionalValue(body, "parentRevisionId"),
      relation: optionalValue(body, "relation") as Exclude<FeatureRevisionRelation, "rollback"> | undefined,
      objective: value(body, "objective"),
      changeSummary: value(body, "changeSummary"),
      contractChanges: objectArrayValue(body.contractChanges) as unknown as FeatureContractChange[],
      constraints: stringArrayValue(body.constraints),
      dependencies: stringArrayValue(body.dependencies),
      targets: objectArrayValue(body.targets) as unknown as FeatureTargetInput[],
      finalCommit: optionalValue(body, "finalCommit"),
      completed: body.completed === true,
      verifications: objectArrayValue(body.verifications) as unknown as FeatureVerificationEvidence[],
      remainingRisks: stringArrayValue(body.remainingRisks),
      gitEvidence: objectOrUndefined(body.gitEvidence),
    });
    response.status(201).json({ revision });
  });

  app.post("/api/features/:id/rollback", (request, response) => {
    const body = bodyObject(request);
    const revision = service.rollbackFeatureRevision({
      memberToken: bearerToken(request),
      sessionId: value(body, "sessionId"),
      finalizationId: optionalValue(body, "finalizationId"),
      featureId: parameter(request, "id"),
      targetRevisionId: value(body, "targetRevisionId"),
      changeSummary: value(body, "changeSummary"),
      finalCommit: optionalValue(body, "finalCommit"),
      completed: body.completed === true,
      verifications: objectArrayValue(body.verifications) as unknown as FeatureVerificationEvidence[],
      gitEvidence: objectOrUndefined(body.gitEvidence),
    });
    response.status(201).json({ revision });
  });

  app.post("/api/feature-confirmations/:id/resolve", (request, response) => {
    const body = bodyObject(request);
    const decision = value(body, "decision");
    if (decision !== "approved" && decision !== "rejected") {
      throw new AgentHubError(
        "invalid_feature_confirmation_decision",
        "Feature confirmation decision must be explicitly approved or rejected.",
        400,
      );
    }
    response.json({
      confirmation: service.resolveFeatureConfirmation({
        memberToken: bearerToken(request),
        sessionId: value(body, "sessionId"),
        confirmationId: parameter(request, "id"),
        decision,
        reason: optionalValue(body, "reason"),
      }),
    });
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
      sessionId: optionalValue(body, "sessionId"),
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
      clientVersion: optionalValue(body, "clientVersion"),
      protocolVersion: optionalNumber(body.protocolVersion),
      schemaVersion: optionalNumber(body.schemaVersion),
      codexSessionId: optionalValue(body, "codexSessionId"),
      turnId: optionalValue(body, "turnId"),
      activityEpoch: optionalNumber(body.activityEpoch),
    });
    response.status(201).json({ session });
  });

  app.get("/api/sessions", (request, response) => {
    response.json(service.listRoomSessions(bearerToken(request)));
  });

  app.post("/api/sessions/:id/heartbeat", (request, response) => {
    const body = optionalBodyObject(request);
    const result = service.heartbeatSession({
      memberToken: bearerToken(request),
      sessionId: parameter(request, "id"),
      clientVersion: optionalValue(body, "clientVersion"),
      protocolVersion: optionalNumber(body.protocolVersion),
      schemaVersion: optionalNumber(body.schemaVersion),
      turnId: optionalValue(body, "turnId"),
      activityEpoch: optionalNumber(body.activityEpoch),
    });
    response.json({
      session: result.session,
      renewedLeases: result.renewedLeases.map(leaseResponse),
      managedLease: result.managedLease ? leaseResponse(result.managedLease) : undefined,
    });
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
      finalizationId: optionalValue(body, "finalizationId"),
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

  app.post("/api/sessions/:id/stop", (request, response) => {
    const body = bodyObject(request);
    response.json(service.stopSessionActivity({
      memberToken: bearerToken(request),
      sessionId: parameter(request, "id"),
      operationId: value(body, "operationId"),
      turnId: value(body, "turnId"),
      activityEpoch: optionalNumber(body.activityEpoch) as number,
    }));
  });

  app.post("/api/sessions/:id/resume", (request, response) => {
    const body = bodyObject(request);
    response.json(service.resumeSessionActivity({
      memberToken: bearerToken(request),
      sessionId: parameter(request, "id"),
      operationId: value(body, "operationId"),
      turnId: value(body, "turnId"),
      activityEpoch: optionalNumber(body.activityEpoch) as number,
    }));
  });

  app.post("/api/sessions/:id/completion/check", (request, response) => {
    const body = bodyObject(request);
    response.json(service.completeSessionActivity({
      memberToken: bearerToken(request),
      sessionId: parameter(request, "id"),
      operationId: value(body, "operationId"),
      turnId: value(body, "turnId"),
      activityEpoch: optionalNumber(body.activityEpoch) as number,
      outcome: value(body, "outcome") as "committed" | "reverted",
      leaseIds: body.leaseIds === undefined ? undefined : stringArrayValue(body.leaseIds),
      attributedPaths: stringArrayValue(body.attributedPaths),
      baseCommit: optionalValue(body, "baseCommit"),
      headCommit: optionalValue(body, "headCommit", "commitHash"),
    }));
  });

  app.post("/api/sessions/:id/finalize/start", (request, response) => {
    const body = bodyObject(request);
    const session = service.startSessionFinalization({
      memberToken: bearerToken(request),
      sessionId: parameter(request, "id"),
      finalizationId: value(body, "finalizationId"),
      summary: optionalValue(body, "summary"),
    });
    response.json({ session });
  });

  app.post("/api/sessions/:id/finalize/complete", (request, response) => {
    const body = bodyObject(request);
    const session = service.completeSessionFinalization({
      memberToken: bearerToken(request),
      sessionId: parameter(request, "id"),
      finalizationId: value(body, "finalizationId"),
      summary: optionalValue(body, "summary"),
      evidenceError: optionalValue(body, "evidenceError"),
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
    clientVersion: member.clientVersion,
    protocolVersion: member.protocolVersion,
    schemaVersion: member.schemaVersion,
    compatibility: member.compatibility,
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
    highRiskPaths: lease.paths.filter((path) => path.risk === "high").map((path) => path.path),
    mode: lease.mode,
    kind: lease.kind,
    managedBy: lease.managedBy,
    createdVia: lease.createdVia,
    phase: lease.phase,
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
    title: conflict.severity === "blocking" ? "Critical scope risk" : "Registered scope overlap",
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
    existingLeaseKind: conflict.existingLeaseKind,
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

function dashboardActivityResponse(
  activity: ReturnType<AgentHubService["getDashboard"]>["activity"][number],
) {
  return {
    id: activity.id,
    type: activity.type,
    actorName: activity.actorName ?? "Agent Hub",
    memberName: activity.actorName ?? undefined,
    title: activity.summary,
    summary: activity.summary,
    createdAt: activity.createdAt,
  };
}

function dashboardSessionResponse(
  session: ReturnType<AgentHubService["getDashboard"]>["sessions"][number],
) {
  return {
    id: session.id,
    memberId: session.memberId,
    clientName: session.clientName ?? undefined,
    agentName: session.agentName ?? undefined,
    task: session.task ?? undefined,
    branch: session.branch ?? undefined,
    baseCommit: session.baseCommit ?? undefined,
    status: session.status,
    lastSeenAt: session.lastSeenAt,
    turnStoppedAt: session.turnStoppedAt ?? undefined,
    clientVersion: session.clientVersion ?? undefined,
    protocolVersion: session.protocolVersion ?? undefined,
    schemaVersion: session.schemaVersion ?? undefined,
    codexSessionId: session.codexSessionId ?? undefined,
    currentTurnId: session.currentTurnId ?? undefined,
    activityEpoch: session.activityEpoch,
  };
}

function dashboardReleaseRequestResponse(
  request: ReturnType<AgentHubService["getDashboard"]>["releaseRequests"][number],
) {
  // 弹窗处理申请只需要实际请求范围。合法申请也可能展开为很大的重叠路径笛卡尔积，
  // 这部分完整证据留在专用接口，避免挤掉仪表盘中的可操作申请。
  return { ...request, overlapPaths: [] };
}

function dashboardResponse(
  dashboard: ReturnType<AgentHubService["getDashboard"]>,
  mcpUrl: string,
) {
  const members: unknown[] = [];
  const leases: unknown[] = [];
  const conflicts: unknown[] = [];
  const releaseRequests: unknown[] = [];
  const sessions: unknown[] = [];
  const activity: unknown[] = [];
  const records: unknown[] = [];
  const partialSections: string[] = [];
  const sectionTotals = dashboard.sectionTotals;
  const payload = {
    room: roomResponse(dashboard.room),
    currentMember: memberResponse(dashboard.currentMember),
    members,
    leases,
    conflicts,
    records,
    activity,
    sessions,
    localScans: dashboard.localScans,
    // 风险规则会被管理页整表保存，必须作为不可裁剪的核心状态完整返回。
    settings: dashboard.settings,
    releaseRequests,
    generatedAt: dashboard.generatedAt,
    server: { mcpUrl },
    partialSections,
    sectionTotals,
  };
  let payloadBytes = jsonByteLength(payload);
  const contentBudget = DASHBOARD_RESPONSE_TARGET_BYTES - DASHBOARD_RESPONSE_METADATA_RESERVE_BYTES;
  const markPartial = (section: string) => {
    if (!partialSections.includes(section)) partialSections.push(section);
  };
  const appendWithinBudget = (section: string, target: unknown[], values: unknown[]) => {
    for (const value of values) {
      const addedBytes = jsonByteLength(value) + (target.length > 0 ? 1 : 0);
      if (payloadBytes + addedBytes > contentBudget) {
        markPartial(section);
        return;
      }
      target.push(value);
      payloadBytes += addedBytes;
    }
  };

  // 协作安全状态优先于历史展示；达到预算时返回结构化 partialSections，
  // 让客户端保持在线并明确提示部分展示，而不是被桌面代理按断线拒绝整个响应。
  const sourceLengths: Record<keyof typeof sectionTotals, number> = {
    leases: dashboard.leases.length,
    conflicts: dashboard.conflicts.length,
    releaseRequests: dashboard.releaseRequests.length,
    members: dashboard.members.length,
    sessions: dashboard.sessions.length,
    activity: dashboard.activity.length,
    records: dashboard.records.length,
    settings: dashboard.settings.riskRules.length,
  };
  for (const [section, total] of Object.entries(sectionTotals)) {
    if (total > sourceLengths[section as keyof typeof sectionTotals]) markPartial(section);
  }
  // 即使大型租约范围耗尽后续轮询预算，持有人也必须能处理最新交接申请。
  appendWithinBudget(
    "releaseRequests",
    releaseRequests,
    dashboard.releaseRequests.map(dashboardReleaseRequestResponse),
  );
  appendWithinBudget("leases", leases, dashboard.leases.map(leaseResponse));
  appendWithinBudget("conflicts", conflicts, dashboard.conflicts.map(conflictResponse));
  appendWithinBudget("members", members, dashboard.members.map(memberResponse));
  appendWithinBudget("sessions", sessions, dashboard.sessions.map(dashboardSessionResponse));
  appendWithinBudget("activity", activity, dashboard.activity.map(dashboardActivityResponse));
  appendWithinBudget("records", records, dashboard.records.map(recordResponse));
  return payload;
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
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

function objectArrayValue(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
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

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "boolean") {
    throw new AgentHubError("invalid_input", "Expected a boolean value.");
  }
  return value;
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
