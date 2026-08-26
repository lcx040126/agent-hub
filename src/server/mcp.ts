import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response, type Router } from "express";
import * as z from "zod/v4";
import { AGENT_HUB_VERSION } from "../shared/version.js";

const SERVER_INSTRUCTIONS = [
  "Agent Hub is an automatic collaboration guard. Follow this workflow for every coding task:",
  "1. If Codex SessionStart context supplies an Agent Hub sessionId, reuse that exact Hook session for every MCP tool and do not call session_open. Otherwise call session_open once, retain its returned session.id, then call context_query for the paths and systems involved.",
  "2. Call lease_acquire with that sessionId before writing. If the lease is denied or blocking conflicts are returned, do not edit those paths.",
  "3. Call edit_check with the same sessionId before touching newly discovered paths, and call lease_renew with it while long-running work is active.",
  "4. Use event_append with the same sessionId to record decisions, verification evidence, risks, and handoffs as they occur.",
  "5. Use feature_context_query during planning and before related edits. When edit_check requires historical confirmation, ask the current member and call feature_change_confirm only after an explicit answer.",
  "6. Submit a structured feature revision before closing completed coding work, then call session_close even when work is incomplete. Never claim compatibility without relevant verification.",
  "Handle technical coordination automatically. Ask a human only when requirements or business rules genuinely conflict.",
].join("\n");

const pathSchema = z
  .string()
  .trim()
  .min(1, "A repository-relative path is required.")
  .max(1024);
const optionalShortText = z.string().trim().min(1).max(500).optional();
const optionalLongText = z.string().trim().min(1).max(10_000).optional();
const pathsSchema = z.array(pathSchema).max(100);
const sessionIdSchema = z.string().trim().min(1).max(128);
const budgetTokensSchema = z.number().int().min(256).max(3_000).optional();
const cursorSchema = z.string().trim().min(1).max(2_048).optional();

const sessionOpenInputSchema = z.object({
  clientName: z.string().trim().min(1).max(120).optional(),
  clientVersion: z.string().trim().min(1).max(80).optional(),
  objective: optionalLongText,
  branch: optionalShortText,
  baseCommit: z.string().trim().min(4).max(128).optional(),
  paths: pathsSchema.optional(),
  budgetTokens: budgetTokensSchema,
  limit: z.number().int().min(1).max(50).optional(),
  cursor: cursorSchema,
});

const contextQueryInputSchema = z.object({
  paths: pathsSchema.optional(),
  query: z.string().trim().min(1).max(500).optional(),
  kinds: z
    .array(
      z.enum([
        "rule",
        "architecture",
        "risk",
        "note",
        "dependency",
        "decision",
        "verification",
        "handoff",
        "lease",
        "activity",
      ]),
    )
    .max(10)
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
  budgetTokens: budgetTokensSchema,
  cursor: cursorSchema,
});

const leaseAcquireInputSchema = z.object({
  sessionId: sessionIdSchema,
  title: z.string().trim().min(1).max(200),
  objective: optionalLongText,
  branch: optionalShortText,
  baseCommit: z.string().trim().min(4).max(128).optional(),
  paths: pathsSchema.min(1),
  overrideReason: z.string().trim().min(1).max(1_000).optional(),
  ttlSeconds: z.number().int().min(60).max(86_400).optional(),
});

const leaseRenewInputSchema = z.object({
  sessionId: sessionIdSchema,
  leaseId: z.string().trim().min(1).max(128),
  ttlSeconds: z.number().int().min(60).max(86_400).optional(),
});

const editCheckInputSchema = z.object({
  sessionId: sessionIdSchema,
  paths: pathsSchema.min(1),
  leaseId: z.string().trim().min(1).max(128).optional(),
  proposedEdits: z.array(z.object({
    path: pathSchema,
    precision: z.enum(["symbol", "resource", "path"]).optional(),
    symbols: z.array(z.string().trim().min(1).max(1_000)).max(100).optional(),
    operation: z.enum(["add", "update", "delete", "move", "unknown"]).optional(),
  })).max(100).optional(),
});

const featureTargetSchema = z.object({
  kind: z.enum(["system", "path", "symbol", "interface", "resource", "test"]),
  role: z.enum(["implementation", "contract", "dependency", "verification"]).optional(),
  path: pathSchema.optional(),
  symbol: z.string().trim().min(1).max(1_000).optional(),
  signature: z.string().trim().min(1).max(2_000).optional(),
  label: z.string().trim().min(1).max(1_000).optional(),
});

const featureContractChangeSchema = z.object({
  operation: z.enum(["add", "update", "remove"]),
  key: z.string().trim().min(1).max(240),
  behavior: z.string().trim().min(1).max(10_000).optional(),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
});

const featureVerificationSchema = z.object({
  testKey: z.string().trim().min(1).max(500),
  result: z.enum(["passed", "failed", "pending"]),
  summary: z.string().trim().min(1).max(10_000),
  command: z.string().trim().min(1).max(4_000).optional(),
  evidence: z.string().trim().min(1).max(10_000).optional(),
});

const featureContextQueryInputSchema = z.object({
  sessionId: sessionIdSchema,
  level: z.enum(["cards", "detail"]).default("cards"),
  query: z.string().trim().min(1).max(500).optional(),
  objective: optionalLongText,
  featureIds: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
  paths: pathsSchema.optional(),
  systems: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  symbols: z.array(z.string().trim().min(1).max(1_000)).max(100).optional(),
  tests: z.array(pathSchema).max(100).optional(),
  statuses: z.array(z.enum(["draft", "candidate", "current", "conflict", "superseded", "deprecated"])).max(6).optional(),
  sections: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  knownVersions: z.record(
    z.string().trim().min(1).max(128),
    z.union([
      z.string().trim().min(1).max(128),
      z.object({
        versionId: z.string().trim().min(1).max(128),
        sectionHashes: z.record(
          z.string().trim().min(1).max(100),
          z.string().trim().min(1).max(128),
        ).optional(),
      }),
    ]),
  ).optional(),
  budgetTokens: budgetTokensSchema,
  limit: z.number().int().min(1).max(8).optional(),
  cursor: cursorSchema,
});

const featureHistoryInputSchema = z.object({
  sessionId: sessionIdSchema,
  featureId: z.string().trim().min(1).max(128),
});

const featureRevisionSubmitInputSchema = z.object({
  sessionId: sessionIdSchema,
  featureKey: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(240),
  systemId: z.string().trim().min(1).max(500),
  parentRevisionId: z.string().trim().min(1).max(128).optional(),
  relation: z.enum(["add", "extend", "replace", "deprecate", "conflict"]).default("add"),
  objective: z.string().trim().min(1).max(10_000),
  changeSummary: z.string().trim().min(1).max(10_000),
  contractChanges: z.array(featureContractChangeSchema).max(100),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(200).optional(),
  dependencies: z.array(z.string().trim().min(1).max(2_000)).max(200).optional(),
  targets: z.array(featureTargetSchema).min(1).max(300),
  finalCommit: z.string().trim().min(4).max(255).optional(),
  completed: z.boolean().default(false),
  verifications: z.array(featureVerificationSchema).max(100).optional(),
  remainingRisks: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  gitEvidence: z.record(z.string(), z.unknown()).optional(),
});

const featureRollbackInputSchema = z.object({
  sessionId: sessionIdSchema,
  featureId: z.string().trim().min(1).max(128),
  targetRevisionId: z.string().trim().min(1).max(128),
  changeSummary: z.string().trim().min(1).max(10_000),
  finalCommit: z.string().trim().min(4).max(255).optional(),
  completed: z.boolean().default(false),
  verifications: z.array(featureVerificationSchema).max(100).optional(),
  gitEvidence: z.record(z.string(), z.unknown()).optional(),
});

const featureChangeConfirmInputSchema = z.object({
  sessionId: sessionIdSchema,
  confirmationId: z.string().trim().min(1).max(128),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(1).max(2_000).optional(),
});

const contextEventSchema = z.object({
  sessionId: sessionIdSchema,
  eventType: z.literal("context"),
  kind: z.enum(["rule", "architecture", "risk", "note", "dependency"]),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(20_000),
  paths: pathsSchema.optional(),
});

const decisionEventSchema = z.object({
  sessionId: sessionIdSchema,
  eventType: z.literal("decision"),
  title: z.string().trim().min(1).max(200),
  decision: z.string().trim().min(1).max(20_000),
  rationale: optionalLongText,
  paths: pathsSchema.optional(),
});

const verificationEventSchema = z.object({
  sessionId: sessionIdSchema,
  eventType: z.literal("verification"),
  leaseId: z.string().trim().min(1).max(128).optional(),
  kind: z.enum([
    "static",
    "automated_test",
    "unity_edit_mode",
    "unity_play_mode",
    "manual",
  ]),
  result: z.enum(["passed", "failed", "pending"]),
  summary: z.string().trim().min(1).max(10_000),
  command: optionalLongText,
  evidence: optionalLongText,
});

const handoffEventSchema = z.object({
  sessionId: sessionIdSchema,
  eventType: z.literal("handoff"),
  leaseId: z.string().trim().min(1).max(128).optional(),
  toMemberId: z.string().trim().min(1).max(128).optional(),
  summary: z.string().trim().min(1).max(10_000),
  completed: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  remaining: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  risks: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
});

const eventAppendInputSchema = z.discriminatedUnion("eventType", [
  contextEventSchema,
  decisionEventSchema,
  verificationEventSchema,
  handoffEventSchema,
]);

const eventAppendDiscoverableSchema = z.object({
  sessionId: sessionIdSchema,
  eventType: z.enum(["context", "decision", "verification", "handoff"]),
  kind: z.enum([
    "rule",
    "architecture",
    "risk",
    "note",
    "dependency",
    "static",
    "automated_test",
    "unity_edit_mode",
    "unity_play_mode",
    "manual",
  ]).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(20_000).optional(),
  paths: pathsSchema.optional(),
  decision: z.string().trim().min(1).max(20_000).optional(),
  rationale: optionalLongText,
  leaseId: z.string().trim().min(1).max(128).optional(),
  result: z.enum(["passed", "failed", "pending"]).optional(),
  summary: z.string().trim().min(1).max(10_000).optional(),
  command: optionalLongText,
  evidence: optionalLongText,
  toMemberId: z.string().trim().min(1).max(128).optional(),
  completed: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  remaining: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  risks: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
}).superRefine((input, context) => {
  const result = eventAppendInputSchema.safeParse(input);
  if (result.success) return;
  for (const issue of result.error.issues) {
    context.addIssue({
      code: "custom",
      path: issue.path,
      message: issue.message,
    });
  }
}) as z.ZodType<z.infer<typeof eventAppendInputSchema>>;

const sessionCloseInputSchema = z.object({
  sessionId: sessionIdSchema,
  leaseId: z.string().trim().min(1).max(128).optional(),
  status: z.enum(["completed", "cancelled"]).default("completed"),
  summary: optionalLongText,
  actualPaths: pathsSchema.optional(),
  remaining: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  risks: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
});

export type SessionOpenInput = z.infer<typeof sessionOpenInputSchema>;
export type ContextQueryInput = z.infer<typeof contextQueryInputSchema>;
export type LeaseAcquireInput = z.infer<typeof leaseAcquireInputSchema>;
export type LeaseRenewInput = z.infer<typeof leaseRenewInputSchema>;
export type EditCheckInput = z.infer<typeof editCheckInputSchema>;
export type EventAppendInput = z.infer<typeof eventAppendInputSchema>;
export type SessionCloseInput = z.infer<typeof sessionCloseInputSchema>;
export type FeatureContextQueryInput = z.infer<typeof featureContextQueryInputSchema>;
export type FeatureHistoryInput = z.infer<typeof featureHistoryInputSchema>;
export type FeatureRevisionSubmitInput = z.infer<typeof featureRevisionSubmitInputSchema>;
export type FeatureRollbackInput = z.infer<typeof featureRollbackInputSchema>;
export type FeatureChangeConfirmInput = z.infer<typeof featureChangeConfirmInputSchema>;

export interface AgentHubMemberIdentity {
  id: string;
  roomId: string;
  displayName: string;
  role?: string;
  agent?: string | null;
}

export interface AgentHubToolContext {
  memberToken: string;
  member: AgentHubMemberIdentity;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Deliberately small boundary between the MCP protocol and Agent Hub's domain service.
 * An adapter can map these calls to persistence-backed room, lease, and event methods.
 */
export interface AgentHubServiceLike {
  authenticateMemberToken(
    memberToken: string,
  ): MaybePromise<AgentHubMemberIdentity | null>;
  sessionOpen(
    context: AgentHubToolContext,
    input: SessionOpenInput,
  ): MaybePromise<unknown>;
  contextQuery(
    context: AgentHubToolContext,
    input: ContextQueryInput,
  ): MaybePromise<unknown>;
  leaseAcquire(
    context: AgentHubToolContext,
    input: LeaseAcquireInput,
  ): MaybePromise<unknown>;
  leaseRenew(
    context: AgentHubToolContext,
    input: LeaseRenewInput,
  ): MaybePromise<unknown>;
  editCheck(
    context: AgentHubToolContext,
    input: EditCheckInput,
  ): MaybePromise<unknown>;
  featureContextQuery(
    context: AgentHubToolContext,
    input: FeatureContextQueryInput,
  ): MaybePromise<unknown>;
  featureHistory(
    context: AgentHubToolContext,
    input: FeatureHistoryInput,
  ): MaybePromise<unknown>;
  featureRevisionSubmit(
    context: AgentHubToolContext,
    input: FeatureRevisionSubmitInput,
  ): MaybePromise<unknown>;
  featureRollback(
    context: AgentHubToolContext,
    input: FeatureRollbackInput,
  ): MaybePromise<unknown>;
  featureChangeConfirm(
    context: AgentHubToolContext,
    input: FeatureChangeConfirmInput,
  ): MaybePromise<unknown>;
  eventAppend(
    context: AgentHubToolContext,
    input: EventAppendInput,
  ): MaybePromise<unknown>;
  sessionClose(
    context: AgentHubToolContext,
    input: SessionCloseInput,
  ): MaybePromise<unknown>;
}

function asStructuredResult(value: unknown) {
  const data =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value: value ?? null };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function createServer(service: AgentHubServiceLike, context: AgentHubToolContext) {
  const server = new McpServer(
    { name: "agent-hub", version: AGENT_HUB_VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "session_open",
    {
      title: "Open Agent Hub work session",
      description:
        "Start coordination for a task and retrieve the initial room state. Call this before planning or editing.",
      inputSchema: sessionOpenInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => asStructuredResult(await service.sessionOpen(context, input)),
  );

  server.registerTool(
    "context_query",
    {
      title: "Query relevant shared context",
      description:
        "Read current leases, rules, architecture, dependencies, decisions, verification, handoffs, and activity relevant to a task or path set.",
      inputSchema: contextQueryInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => asStructuredResult(await service.contextQuery(context, input)),
  );

  server.registerTool(
    "lease_acquire",
    {
      title: "Acquire a work-scope lease",
      description:
        "Claim repository paths for the session_open session before writing. Pass its session.id and do not edit when a blocking conflict prevents acquisition.",
      inputSchema: leaseAcquireInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => asStructuredResult(await service.leaseAcquire(context, input)),
  );

  server.registerTool(
    "lease_renew",
    {
      title: "Renew an active lease",
      description:
        "Extend an active work-scope lease owned by the specified session so other agents keep seeing the scope as occupied.",
      inputSchema: leaseRenewInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => asStructuredResult(await service.leaseRenew(context, input)),
  );

  server.registerTool(
    "edit_check",
    {
      title: "Check paths before editing",
      description:
        "Verify that proposed edits are covered by the specified session's lease and do not conflict with another active lease.",
      inputSchema: editCheckInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => asStructuredResult(await service.editCheck(context, input)),
  );

  server.registerTool(
    "feature_context_query",
    {
      title: "Query versioned feature memory",
      description:
        "Retrieve a small set of relevant current feature-memory cards or details by task, path, system, or symbol. Empty selectors never return the whole room history.",
      inputSchema: featureContextQueryInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => asStructuredResult(await service.featureContextQuery(context, input)),
  );

  server.registerTool(
    "feature_history",
    {
      title: "Read feature revision history",
      description:
        "Read the immutable revision chain for one feature when auditing, resolving a conflict, or preparing a rollback.",
      inputSchema: featureHistoryInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => asStructuredResult(await service.featureHistory(context, input)),
  );

  server.registerTool(
    "feature_revision_submit",
    {
      title: "Submit a feature-memory revision",
      description:
        "Submit structured behavior contracts, implementation targets, Git evidence, and regression results before closing completed coding work. Unverified or non-default-branch work remains draft or candidate.",
      inputSchema: featureRevisionSubmitInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => asStructuredResult(await service.featureRevisionSubmit(context, input)),
  );

  server.registerTool(
    "feature_revision_rollback",
    {
      title: "Create a feature rollback revision",
      description:
        "Create a new immutable revision that restores an earlier effective feature snapshot. History is preserved and normal commit and verification promotion rules still apply.",
      inputSchema: featureRollbackInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => asStructuredResult(await service.featureRollback(context, input)),
  );

  server.registerTool(
    "feature_change_confirm",
    {
      title: "Resolve an exact historical feature change",
      description:
        "Approve or reject the exact proposal returned by edit_check. Call this only after the current member explicitly answers in the active conversation; approval is session-bound and expires when the proposal changes.",
      inputSchema: featureChangeConfirmInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => asStructuredResult(await service.featureChangeConfirm(context, input)),
  );

  server.registerTool(
    "event_append",
    {
      title: "Append collaboration evidence",
      description:
        "Record a context note, technical decision, verification result, or handoff in the shared room timeline.",
      inputSchema: eventAppendDiscoverableSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => asStructuredResult(await service.eventAppend(context, input)),
  );

  server.registerTool(
    "session_close",
    {
      title: "Close Agent Hub work session",
      description:
        "Finish or cancel work, close the session_open session, release its lease, and publish remaining work and risks. Pass the session.id returned by session_open, and call this even when the task is incomplete.",
      inputSchema: sessionCloseInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => asStructuredResult(await service.sessionClose(context, input)),
  );

  return server;
}

function bearerToken(request: Request): string | null {
  const authorization = request.header("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token && !token.includes(",") ? token : null;
}

function sendProtocolError(
  response: Response,
  status: number,
  code: number,
  message: string,
) {
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

async function authenticate(
  request: Request,
  response: Response,
  service: AgentHubServiceLike,
): Promise<AgentHubToolContext | null> {
  const memberToken = bearerToken(request);
  if (!memberToken) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="Agent Hub MCP"');
    sendProtocolError(response, 401, -32_001, "A valid Agent Hub member token is required.");
    return null;
  }

  let member: AgentHubMemberIdentity | null;
  try {
    member = await service.authenticateMemberToken(memberToken);
  } catch {
    sendProtocolError(response, 500, -32_603, "Member authentication failed.");
    return null;
  }

  if (!member) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="Agent Hub MCP", error="invalid_token"');
    sendProtocolError(response, 401, -32_001, "A valid Agent Hub member token is required.");
    return null;
  }

  return { memberToken, member };
}

/**
 * Mount with `app.use("/mcp", createMcpRouter(service))`.
 * Each request is stateless and re-authenticated with its Bearer member token.
 */
export function createMcpRouter(service: AgentHubServiceLike): Router {
  const router = express.Router();
  router.use(express.json({ limit: "256kb" }));

  router.post("/", async (request, response) => {
    const context = await authenticate(request, response, service);
    if (!context) {
      return;
    }

    const server = createServer(service, context);
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) {
        sendProtocolError(response, 500, -32_603, "Agent Hub could not process the MCP request.");
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  router.all("/", async (request, response) => {
    const context = await authenticate(request, response, service);
    if (!context) {
      return;
    }
    response.setHeader("Allow", "POST");
    sendProtocolError(response, 405, -32_000, "Method not allowed. Use Streamable HTTP POST.");
  });

  return router;
}

export { SERVER_INSTRUCTIONS };
