import type {
  AgentHubMemberIdentity,
  AgentHubServiceLike,
  ContextQueryInput,
  EditCheckInput,
  EventAppendInput,
  FeatureChangeConfirmInput,
  FeatureContextQueryInput,
  FeatureHistoryInput,
  FeatureRevisionSubmitInput,
  FeatureRollbackInput,
  LeaseAcquireInput,
  LeaseRenewInput,
  SessionCloseInput,
  SessionOpenInput,
} from "./mcp.js";
import {
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  MAX_CONTEXT_TOKEN_BUDGET,
  estimateContextTokens,
  packContextByBudget,
  type ContextBudgetCandidate,
} from "./context-budget.js";
import type {
  FeatureMemoryRetrievalItem,
  KnownFeatureMemoryVersion,
} from "./context-retrieval.js";
import { pathsOverlap } from "./domain.js";
import { FeatureMemoryError, FeatureMemoryStore } from "./feature-memory.js";
import { AgentHubError, AgentHubService, type RelevantContextResult } from "./service.js";

export function createMcpServiceAdapter(service: AgentHubService): AgentHubServiceLike {
  const featureMemory = new FeatureMemoryStore(service.database);
  const loadedFeatures = new Map<string, Map<string, LoadedFeatureState>>();
  const cursorKnownVersions = new Map<string, Readonly<Record<string, string | KnownFeatureMemoryVersion>>>();
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

    featureContextQuery(context, input) {
      requireActiveMcpSession(service, context, input.sessionId);
      return queryFeatureContext(
        service,
        featureMemory,
        loadedFeatures,
        cursorKnownVersions,
        context,
        input,
      );
    },

    featureHistory(context, input) {
      requireActiveMcpSession(service, context, input.sessionId);
      return service.getFeatureHistory(context.memberToken, input.featureId);
    },

    featureRevisionSubmit(context, input) {
      requireActiveMcpSession(service, context, input.sessionId);
      return submitFeatureRevision(service, context.memberToken, input);
    },

    featureRollback(context, input) {
      requireActiveMcpSession(service, context, input.sessionId);
      return rollbackFeatureRevision(service, context.memberToken, input);
    },

    featureChangeConfirm(context, input) {
      requireActiveMcpSession(service, context, input.sessionId);
      return confirmFeatureChange(service, context.memberToken, input);
    },

    eventAppend(context, input) {
      requireActiveMcpSession(service, context, input.sessionId);
      return appendEvent(service, context.memberToken, input);
    },

    sessionClose(context, input) {
      const result = closeSession(service, context, input);
      forgetLoadedFeatures(loadedFeatures, cursorKnownVersions, context, input.sessionId);
      return result;
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
    context: retrieveSharedContext(service, memberToken, {
      paths: input.paths,
      searchText: input.objective,
      searchKind: "objective",
      budgetTokens: input.budgetTokens,
      limit: input.limit,
      cursor: input.cursor,
      reservedTokens: estimateContextTokens(JSON.stringify({ session })),
    }),
  };
}

function queryContext(service: AgentHubService, memberToken: string, input: ContextQueryInput) {
  return retrieveSharedContext(service, memberToken, {
    paths: input.paths,
    searchText: input.query,
    searchKind: "query",
    kinds: input.kinds,
    budgetTokens: input.budgetTokens,
    limit: input.limit,
    cursor: input.cursor,
  });
}

type SharedContextCollection =
  | "activeLeases"
  | "contextEntries"
  | "decisions"
  | "verifications"
  | "handoffs"
  | "records"
  | "sessions"
  | "localScans";

type SharedContextKind = NonNullable<ContextQueryInput["kinds"]>[number];

interface SharedContextOptions {
  paths?: readonly string[];
  searchText?: string;
  searchKind: "query" | "objective";
  kinds?: readonly SharedContextKind[];
  budgetTokens?: number;
  limit?: number;
  cursor?: string;
  reservedTokens?: number;
}

interface RankedSharedContextItem {
  collection: SharedContextCollection;
  kind: SharedContextKind;
  id: string;
  score: number;
  hitReasons: string[];
  value: unknown;
}

function retrieveSharedContext(
  service: AgentHubService,
  memberToken: string,
  options: SharedContextOptions,
) {
  const requestedPaths = (options.paths ?? []).map(normalizedPath).filter(Boolean);
  const searchText = options.searchText?.trim() ?? "";
  const hasSelectors = requestedPaths.length > 0 || Boolean(searchText);
  const context = service.getRelevantContext(memberToken, [...requestedPaths]);
  const selectedKinds = new Set(options.kinds ?? []);
  const candidates: RankedSharedContextItem[] = [];

  const add = (
    collection: SharedContextCollection,
    kind: SharedContextKind,
    id: string,
    value: unknown,
    paths: readonly string[],
    priority: number,
    startupRelevant = false,
    highRisk = false,
  ) => {
    if (selectedKinds.size > 0 && !selectedKinds.has(kind)) return;
    if (!hasSelectors && !startupRelevant) return;
    const normalizedPaths = paths.map(normalizedPath).filter(Boolean);
    const pathMatches = requestedPaths.flatMap((requested) => normalizedPaths
      .filter((candidate) => pathsOverlap(candidate, requested))
      .map((candidate) => ({ requested, candidate })));
    const globalRule = collection === "contextEntries"
      && (kind === "rule" || kind === "risk")
      && normalizedPaths.length === 0;
    if (requestedPaths.length > 0 && pathMatches.length === 0 && !globalRule) return;
    const searchMatched = searchText ? relevantTextMatch(value, searchText, options.searchKind) : false;
    if (searchText && !searchMatched) return;

    const hitReasons: string[] = [];
    if (!hasSelectors) hitReasons.push(highRisk ? "high-risk startup summary" : "live startup coordination");
    if (globalRule) hitReasons.push("global project rule");
    if (pathMatches.length > 0) {
      const first = pathMatches[0]!;
      hitReasons.push(`path overlap: ${first.requested} -> ${first.candidate}`);
    }
    if (searchMatched) hitReasons.push(`${options.searchKind} terms matched`);
    if (highRisk) hitReasons.push("high-risk scope");
    candidates.push({
      collection,
      kind,
      id,
      score: priority + (pathMatches.length > 0 ? 120 : 0) + (searchMatched ? 80 : 0) + (highRisk ? 60 : 0),
      hitReasons,
      value,
    });
  };

  for (const entry of context.contextEntries) {
    add(
      "contextEntries",
      entry.kind,
      entry.id,
      entry,
      entry.paths,
      entry.kind === "rule" ? 1_000 : entry.kind === "risk" ? 950 : 650,
      entry.kind === "rule" || entry.kind === "risk",
      entry.kind === "risk",
    );
  }
  for (const lease of context.activeLeases) {
    const highRisk = lease.kind === "exclusive" || lease.paths.some((path) => path.risk === "high");
    add(
      "activeLeases",
      "lease",
      lease.id,
      lease,
      lease.paths.map((path) => path.path),
      900,
      true,
      highRisk,
    );
  }
  for (const record of context.records) {
    const kind = record.kind === "validation"
      ? "verification"
      : record.kind === "handoff"
        ? "handoff"
        : record.kind;
    add("records", kind, record.id, record, record.paths, record.kind === "risk" ? 800 : 520, record.kind === "risk", record.kind === "risk");
  }
  for (const decision of context.decisions) {
    add("decisions", "decision", decision.id, decision, decision.paths, 620);
  }
  for (const verification of context.verifications) {
    add("verifications", "verification", verification.id, verification, [], 540);
  }
  for (const handoff of context.handoffs) {
    add("handoffs", "handoff", handoff.id, handoff, [], handoff.risks.length > 0 ? 610 : 500, false, handoff.risks.length > 0);
  }
  for (const scan of context.localScans) {
    add("localScans", "activity", scan.id, scan, scan.changedPaths, 300);
  }
  for (const session of context.sessions) {
    add("sessions", "activity", session.id, session, [], 250);
  }

  const effectiveBudget = Math.min(options.budgetTokens ?? DEFAULT_CONTEXT_TOKEN_BUDGET, MAX_CONTEXT_TOKEN_BUDGET);
  const defaultLimit = hasSelectors ? 50 : 12;
  const effectiveLimit = Math.min(options.limit ?? defaultLimit, hasSelectors ? 200 : 12);
  const summary = sharedContextSummary(context);
  const emptyPayload = emptySharedContextPayload(context, summary, effectiveBudget, effectiveLimit);
  const baseTokens = (options.reservedTokens ?? 0)
    + estimateContextTokens(JSON.stringify(emptyPayload))
    + 48;
  if (baseTokens >= effectiveBudget) {
    throw new AgentHubError(
      "context_budget_too_small",
      "The requested context budget is too small for the session and retrieval metadata.",
      400,
    );
  }
  const availableTokens = effectiveBudget - baseTokens;
  const budgetCandidates: Array<ContextBudgetCandidate<RankedSharedContextItem>> = [];
  let oversizedItemCount = 0;
  for (const candidate of candidates) {
    const serialized = JSON.stringify(candidate);
    if (estimateContextTokens(serialized) > availableTokens) {
      oversizedItemCount += 1;
      continue;
    }
    budgetCandidates.push({
      id: `${candidate.collection}:${candidate.id}`,
      priority: candidate.score,
      value: candidate,
      text: serialized,
    });
  }
  const packed = packContextByBudget(budgetCandidates, {
    budgetTokens: effectiveBudget,
    baseTokens,
    limit: effectiveLimit,
    cursor: options.cursor,
  });
  const result = emptySharedContextPayload(context, summary, packed.budgetTokens, effectiveLimit);
  for (const item of packed.items) {
    (result[item.collection] as unknown[]).push(item.value);
  }
  result.retrieval = {
    ...result.retrieval,
    estimatedTokens: packed.estimatedTokens,
    returnedCount: packed.items.length,
    matchedCount: candidates.length,
    oversizedItemCount,
    truncated: packed.truncated,
    nextCursor: packed.nextCursor,
    matches: packed.items.map(({ collection, kind, id, score, hitReasons }) => ({
      collection,
      kind,
      id,
      score,
      hitReasons,
    })),
  };
  return result;
}

function emptySharedContextPayload(
  context: RelevantContextResult,
  summary: ReturnType<typeof sharedContextSummary>,
  budgetTokens: number,
  limit: number,
) {
  return {
    room: context.room,
    members: [],
    activeLeases: [] as unknown[],
    contextEntries: [] as unknown[],
    decisions: [] as unknown[],
    verifications: [] as unknown[],
    handoffs: [] as unknown[],
    records: [] as unknown[],
    sessions: [] as unknown[],
    localScans: [] as unknown[],
    generatedAt: context.generatedAt,
    summary,
    retrieval: {
      budgetTokens,
      estimatedTokens: 0,
      limit,
      returnedCount: 0,
      matchedCount: 0,
      oversizedItemCount: 0,
      truncated: false,
      nextCursor: null as string | null,
      matches: [] as Array<{
        collection: SharedContextCollection;
        kind: SharedContextKind;
        id: string;
        score: number;
        hitReasons: string[];
      }>,
    },
  };
}

function sharedContextSummary(context: RelevantContextResult) {
  return {
    activeLeaseCount: context.activeLeases.length,
    highRiskLeaseCount: context.activeLeases.filter((lease) =>
      lease.kind === "exclusive" || lease.paths.some((path) => path.risk === "high"),
    ).length,
    ruleCount: context.contextEntries.filter((entry) => entry.kind === "rule").length,
    riskCount: context.contextEntries.filter((entry) => entry.kind === "risk").length
      + context.records.filter((record) => record.kind === "risk").length,
  };
}

function relevantTextMatch(value: unknown, requested: string, mode: "query" | "objective"): boolean {
  const haystack = normalizedText(JSON.stringify(value));
  const needle = normalizedText(requested);
  if (!needle) return true;
  if (haystack.includes(needle)) return true;
  if (mode === "query") return false;
  const terms = searchTerms(needle);
  if (terms.length === 0) return false;
  const matched = terms.filter((term) => haystack.includes(term)).length;
  return matched >= Math.max(1, Math.ceil(terms.length * 0.35));
}

function searchTerms(value: string): string[] {
  const result = new Set<string>();
  for (const match of value.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const segment = match[0]!;
    if (/\p{Script=Han}/u.test(segment)) {
      const characters = [...segment];
      for (let index = 0; index + 1 < characters.length; index += 1) {
        result.add(`${characters[index]}${characters[index + 1]}`);
      }
    } else if (segment.length > 1) {
      result.add(segment);
    }
  }
  return [...result];
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function normalizedPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

interface LoadedFeatureState {
  planningVersionId?: string;
  detailVersionId?: string;
  detailSectionHashes?: Record<string, string>;
}

function queryFeatureContext(
  service: AgentHubService,
  featureMemory: FeatureMemoryStore,
  loadedFeatures: Map<string, Map<string, LoadedFeatureState>>,
  cursorKnownVersions: Map<string, Readonly<Record<string, string | KnownFeatureMemoryVersion>>>,
  context: { memberToken: string; member: AgentHubMemberIdentity },
  input: FeatureContextQueryInput,
) {
  const auth = service.authenticateMemberToken(context.memberToken);
  const key = loadedFeatureSessionKey(context, input.sessionId);
  const loaded = loadedFeatures.get(key) ?? new Map<string, LoadedFeatureState>();
  loadedFeatures.set(key, loaded);
  const automaticKnown = input.cursor
    ? cursorKnownVersions.get(`${key}:${input.cursor}`) ?? knownFeatureVersions(loaded, input.level)
    : knownFeatureVersions(loaded, input.level);
  const effectiveKnown = {
    ...automaticKnown,
    ...(input.knownVersions ?? {}),
  };
  let result;
  try {
    result = featureMemory.retrieve({
      roomId: auth.room.id,
      memberId: auth.member.id,
      memberName: auth.member.displayName,
      defaultBranch: auth.room.defaultBranch,
    }, {
      mode: input.level === "detail" ? "detail" : "planning",
      objective: input.objective ?? input.query,
      featureIds: input.featureIds,
      paths: input.paths,
      systems: input.systems,
      symbols: input.symbols,
      tests: input.tests,
      statuses: input.statuses,
      sections: input.sections,
      knownVersions: effectiveKnown,
      budgetTokens: input.budgetTokens,
      baseTokens: 180,
      limit: input.limit,
      cursor: input.cursor,
    });
  } catch (error) {
    if (error instanceof FeatureMemoryError) {
      throw new AgentHubError(error.code, error.message, error.status, error.details);
    }
    throw error;
  }
  if (input.cursor) cursorKnownVersions.delete(`${key}:${input.cursor}`);
  if (result.nextCursor) {
    cursorKnownVersions.set(`${key}:${result.nextCursor}`, effectiveKnown);
  }
  rememberFeatureItems(loaded, result.items);
  return compatibleFeatureResult(input.level, result);
}

function knownFeatureVersions(
  loaded: ReadonlyMap<string, LoadedFeatureState>,
  level: "cards" | "detail",
): Record<string, string | KnownFeatureMemoryVersion> {
  const result: Record<string, string | KnownFeatureMemoryVersion> = {};
  for (const [featureId, state] of loaded) {
    if (level === "cards" && state.planningVersionId) {
      result[featureId] = state.planningVersionId;
    } else if (level === "detail" && state.detailVersionId) {
      result[featureId] = {
        versionId: state.detailVersionId,
        sectionHashes: state.detailSectionHashes,
      };
    }
  }
  return result;
}

function rememberFeatureItems(
  loaded: Map<string, LoadedFeatureState>,
  items: readonly FeatureMemoryRetrievalItem[],
): void {
  for (const item of items) {
    const state = loaded.get(item.memoryId) ?? {};
    if (item.kind === "detail") {
      const previousHashes = state.detailSectionHashes ?? {};
      state.detailVersionId = item.versionId;
      state.detailSectionHashes = { ...previousHashes, ...item.sectionHashes };
    } else if (item.kind !== "evidence") {
      state.planningVersionId = item.versionId;
    }
    loaded.set(item.memoryId, state);
  }
}

function compatibleFeatureResult(
  level: "cards" | "detail",
  result: {
    items: FeatureMemoryRetrievalItem[];
    unchangedMemoryIds: string[];
    matchedCount: number;
    estimatedTokens: number;
    budgetTokens: number;
    truncated: boolean;
    nextCursor: string | null;
  },
) {
  const cards = result.items
    .filter((item) => item.kind === "card" || item.kind === "stub" || item.kind === "status")
    .map((item) => ({
      featureId: item.memoryId,
      revisionId: item.versionId,
      name: item.featureName,
      systemId: item.systemId,
      status: item.state,
      coreContract: item.kind === "card" ? item.behaviorContract : undefined,
      paths: item.kind === "card" ? item.keyPaths : [],
      symbols: item.kind === "card" ? item.keySymbols : [],
      tests: item.kind === "card" ? item.linkedTests : [],
      verificationStatus: item.validationStatus ?? "missing",
      hitReasons: item.hitReasons.map(hitReasonText),
      matchReasons: item.hitReasons,
      candidate: item.kind === "stub" ? true : undefined,
      statusOnly: item.kind === "status" ? true : undefined,
      versionChangedFrom: item.versionChangedFrom,
    }));
  const details = result.items
    .filter((item): item is Extract<FeatureMemoryRetrievalItem, { kind: "detail" }> => item.kind === "detail")
    .map((item) => ({
      id: item.versionId,
      featureId: item.memoryId,
      name: item.featureName,
      systemId: item.systemId,
      status: item.state,
      behaviorContract: item.behaviorContract,
      paths: item.paths,
      symbols: item.symbols,
      tests: item.tests,
      dependencies: item.dependencies,
      sections: item.sections,
      sectionHashes: item.sectionHashes,
      unchangedSections: item.unchangedSections,
      versionChangedFrom: item.versionChangedFrom,
      validationStatus: item.validationStatus,
      hitReasons: item.hitReasons.map(hitReasonText),
      matchReasons: item.hitReasons,
    }));
  return {
    level,
    cards,
    details,
    nextCursor: result.nextCursor,
    unchangedFeatureIds: result.unchangedMemoryIds,
    retrieval: {
      matchedCount: result.matchedCount,
      returnedCount: result.items.length,
      estimatedTokens: result.estimatedTokens,
      budgetTokens: result.budgetTokens,
      truncated: result.truncated,
      nextCursor: result.nextCursor,
    },
  };
}

function hitReasonText(reason: FeatureMemoryRetrievalItem["hitReasons"][number]): string {
  return `${reason.kind} ${reason.query} matched ${reason.matched}`;
}

function loadedFeatureSessionKey(
  context: { member: AgentHubMemberIdentity },
  sessionId: string,
): string {
  return `${context.member.roomId}:${context.member.id}:${sessionId}`;
}

function forgetLoadedFeatures(
  loadedFeatures: Map<string, Map<string, LoadedFeatureState>>,
  cursorKnownVersions: Map<string, Readonly<Record<string, string | KnownFeatureMemoryVersion>>>,
  context: { member: AgentHubMemberIdentity },
  sessionId: string,
): void {
  const key = loadedFeatureSessionKey(context, sessionId);
  loadedFeatures.delete(key);
  for (const cursorKey of cursorKnownVersions.keys()) {
    if (cursorKey.startsWith(`${key}:`)) cursorKnownVersions.delete(cursorKey);
  }
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
    proposedEdits: input.proposedEdits,
  });
}

function submitFeatureRevision(
  service: AgentHubService,
  memberToken: string,
  input: FeatureRevisionSubmitInput,
) {
  return service.submitFeatureRevision({ memberToken, ...input });
}

function rollbackFeatureRevision(
  service: AgentHubService,
  memberToken: string,
  input: FeatureRollbackInput,
) {
  return service.rollbackFeatureRevision({ memberToken, ...input });
}

function confirmFeatureChange(
  service: AgentHubService,
  memberToken: string,
  input: FeatureChangeConfirmInput,
) {
  return service.resolveFeatureConfirmation({ memberToken, ...input });
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
    || (session.metadata.source !== "mcp" && session.metadata.source !== "codex-hook")
  ) {
    throw new AgentHubError(
      "mcp_session_not_active",
      "sessionId must identify an active MCP or Codex Hook session owned by this member.",
      409,
    );
  }
}
