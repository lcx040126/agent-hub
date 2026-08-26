import type {
  AgentHubMemberIdentity,
  AgentHubServiceLike,
  ContextQueryInput,
  EditCheckInput,
  EventAppendInput,
  LeaseAcquireInput,
  LeaseRenewInput,
  SessionCloseInput,
  SessionOpenInput,
} from "./mcp.js";
import { AgentHubError, AgentHubService } from "./service.js";

export function createMcpServiceAdapter(service: AgentHubService): AgentHubServiceLike {
  return {
    authenticateMemberToken(memberToken) {
      try {
        const authenticated = service.authenticateMemberToken(memberToken);
        return memberIdentity(authenticated.member);
      } catch (error) {
        if (error instanceof AgentHubError && error.status === 401) return null;
        throw error;
      }
    },

    sessionOpen(context, input) {
      return openSession(service, context.memberToken, input);
    },

    contextQuery(context, input) {
      return queryContext(service, context.memberToken, input);
    },

    leaseAcquire(context, input) {
      requireActiveMcpSession(service, context, input.sessionId);
      return service.claimLease({
        memberToken: context.memberToken,
        sessionId: input.sessionId,
        title: input.title,
        objective: input.objective,
        branch: input.branch,
        baseCommit: input.baseCommit,
        paths: input.paths,
        mode: "write",
        overrideReason: input.overrideReason,
        ttlMs: input.ttlSeconds === undefined ? undefined : input.ttlSeconds * 1000,
      });
    },

    leaseRenew(context, input) {
      requireActiveMcpSession(service, context, input.sessionId);
      return renewLease(service, context.memberToken, input);
    },

    editCheck(context, input) {
      requireActiveMcpSession(service, context, input.sessionId);
      return checkEdits(service, context.memberToken, input);
    },

    eventAppend(context, input) {
      requireActiveMcpSession(service, context, input.sessionId);
      return appendEvent(service, context.memberToken, input);
    },

    sessionClose(context, input) {
      return closeSession(service, context, input);
    },
  };
}

function memberIdentity(member: {
  id: string;
  roomId: string;
  displayName: string;
  role: string;
  agent: string | null;
}): AgentHubMemberIdentity {
  return {
    id: member.id,
    roomId: member.roomId,
    displayName: member.displayName,
    role: member.role,
    agent: member.agent,
  };
}

function openSession(service: AgentHubService, memberToken: string, input: SessionOpenInput) {
  const session = service.openSession({
    memberToken,
    clientName: input.clientName,
    agentName: input.clientName,
    branch: input.branch,
    baseCommit: input.baseCommit,
    task: input.objective,
    metadata: {
      clientVersion: input.clientVersion,
      intendedPaths: input.paths ?? [],
      source: "mcp",
    },
  });
  return {
    session,
    context: service.getRelevantContext(memberToken, input.paths ?? []),
  };
}

function queryContext(service: AgentHubService, memberToken: string, input: ContextQueryInput) {
  const context = service.getRelevantContext(memberToken, input.paths ?? []);
  const limit = input.limit ?? 50;
  const query = input.query?.toLocaleLowerCase("en-US");
  if (!query) return context;

  const matches = (value: unknown) =>
    JSON.stringify(value).toLocaleLowerCase("en-US").includes(query);
  return {
    ...context,
    contextEntries: context.contextEntries.filter(matches).slice(0, limit),
    decisions: context.decisions.filter(matches).slice(0, limit),
    verifications: context.verifications.filter(matches).slice(0, limit),
    handoffs: context.handoffs.filter(matches).slice(0, limit),
    records: context.records.filter(matches).slice(0, limit),
    activeLeases: context.activeLeases.filter(matches).slice(0, limit),
    localScans: context.localScans.filter(matches).slice(0, limit),
  };
}

function renewLease(service: AgentHubService, memberToken: string, input: LeaseRenewInput) {
  return service.renewLease({
    memberToken,
    leaseId: input.leaseId,
    sessionId: input.sessionId,
    ttlMs: input.ttlSeconds === undefined ? undefined : input.ttlSeconds * 1000,
  });
}

function checkEdits(service: AgentHubService, memberToken: string, input: EditCheckInput) {
  return service.checkEdits({
    memberToken,
    sessionId: input.sessionId,
    paths: input.paths,
    leaseId: input.leaseId,
  });
}

function appendEvent(service: AgentHubService, memberToken: string, input: EventAppendInput) {
  switch (input.eventType) {
    case "context":
      return service.addContextEntry({
        memberToken,
        kind: input.kind,
        title: input.title,
        content: input.content,
        paths: input.paths,
      });
    case "decision":
      return service.addDecision({
        memberToken,
        title: input.title,
        decision: input.decision,
        rationale: input.rationale,
        paths: input.paths,
      });
    case "verification":
      return service.addVerification({
        memberToken,
        sessionId: input.sessionId,
        leaseId: input.leaseId,
        kind: input.kind,
        result: input.result,
        summary: input.summary,
        command: input.command,
        evidence: input.evidence,
      });
    case "handoff":
      return service.addHandoff({
        memberToken,
        sessionId: input.sessionId,
        leaseId: input.leaseId,
        toMemberId: input.toMemberId,
        summary: input.summary,
        completed: input.completed,
        remaining: input.remaining,
        risks: input.risks,
      });
  }
}

function closeSession(
  service: AgentHubService,
  context: { memberToken: string; member: AgentHubMemberIdentity },
  input: SessionCloseInput,
) {
  requireActiveMcpSession(service, context, input.sessionId);
  const memberToken = context.memberToken;
  if (input.leaseId) {
    const result = service.closeLease({
      memberToken,
      leaseId: input.leaseId,
      sessionId: input.sessionId,
      status: input.status,
      summary: input.summary,
      outcome: input.summary,
      changedPaths: input.actualPaths,
      remainingRisks: [...(input.remaining ?? []), ...(input.risks ?? [])],
      handoff: input.remaining?.length
        ? `Remaining: ${input.remaining.join("; ")}`
        : undefined,
    });
    return {
      ...result,
      session: service.closeSession({
        memberToken,
        sessionId: input.sessionId,
        summary: input.summary,
      }),
    };
  }
  if (input.summary || input.remaining?.length || input.risks?.length) {
    const handoff = service.addHandoff({
      memberToken,
      sessionId: input.sessionId,
      summary: input.summary ?? "Session closed without an active lease.",
      completed: input.status === "completed" ? [input.summary ?? "Work completed."] : [],
      remaining: input.remaining,
      risks: input.risks,
    });
    return {
      ...handoff,
      session: service.closeSession({
        memberToken,
        sessionId: input.sessionId,
        summary: input.summary,
      }),
    };
  }
  return {
    status: input.status,
    closed: true,
    session: service.closeSession({
      memberToken,
      sessionId: input.sessionId,
      summary: input.summary,
    }),
  };
}

function requireActiveMcpSession(
  service: AgentHubService,
  context: { memberToken: string; member: AgentHubMemberIdentity },
  sessionId: string,
): void {
  const session = service.listRoomSessions(context.memberToken).sessions.find((item) => item.id === sessionId);
  if (
    !session
    || session.memberId !== context.member.id
    || session.status !== "active"
    || session.metadata.source !== "mcp"
  ) {
    throw new AgentHubError(
      "mcp_session_not_active",
      "sessionId must identify an active MCP session opened by this member.",
      409,
    );
  }
}
