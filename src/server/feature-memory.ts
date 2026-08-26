import { createHash, randomUUID } from "node:crypto";
import {
  normalizeRepoPath,
  pathComparisonKey,
  pathsOverlap,
  type FeatureChangeConfirmation,
  type FeatureContract,
  type FeatureContractChange,
  type FeatureImpact,
  type FeatureMemory,
  type FeatureMemoryCard,
  type FeatureMemoryQueryInput,
  type FeatureMemoryQueryResult,
  type FeatureRevision,
  type FeatureRevisionRelation,
  type FeatureRevisionSnapshot,
  type FeatureRevisionStatus,
  type FeatureTarget,
  type FeatureTargetInput,
  type FeatureVerificationEvidence,
  type ProposedFeatureEdit,
  type ResolveFeatureConfirmationInput,
  type RollbackFeatureRevisionInput,
  type SubmitFeatureRevisionInput,
  type VerificationResult,
} from "./domain.js";
import type { AgentHubDatabase } from "./db.js";
import {
  retrieveFeatureMemory,
  type FeatureMemoryIndexEntry,
  type FeatureMemoryRetrievalQuery,
  type FeatureMemoryRetrievalResult,
  type KnownFeatureMemoryVersion,
} from "./context-retrieval.js";

type Row = Record<string, unknown>;

export interface FeatureMemoryActor {
  roomId: string;
  memberId: string;
  memberName: string;
  defaultBranch: string;
}

export interface FeatureMemorySession {
  id: string;
  memberId: string;
  branch: string | null;
  baseCommit: string | null;
  status: "active" | "frozen" | "closed";
  promotionEvidenceVerified?: boolean;
}

export interface HistoricalImpactCheckInput {
  actor: FeatureMemoryActor;
  session: FeatureMemorySession;
  paths: string[];
  proposedEdits?: ProposedFeatureEdit[];
}

export interface HistoricalImpactCheckResult {
  impacts: FeatureImpact[];
  confirmation?: FeatureChangeConfirmation;
  authorized: boolean;
}

export interface FeatureMemoryRetrievalInput {
  mode: "startup" | "planning" | "detail" | "evidence";
  objective?: string;
  query?: string;
  featureIds?: string[];
  paths?: string[];
  systems?: string[];
  symbols?: string[];
  tests?: string[];
  statuses?: FeatureRevisionStatus[];
  sections?: string[];
  knownVersions?: Readonly<Record<string, string | KnownFeatureMemoryVersion>>;
  budgetTokens?: number;
  baseTokens?: number;
  limit?: number;
  cursor?: string;
}

export class FeatureMemoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "FeatureMemoryError";
  }
}

export class FeatureMemoryStore {
  constructor(
    private readonly database: AgentHubDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Builds the MCP-facing feature index without exposing immutable history as bulk context.
   * Superseded revisions remain available only through history().
   */
  retrieve(
    actor: FeatureMemoryActor,
    input: FeatureMemoryRetrievalInput,
  ): FeatureMemoryRetrievalResult {
    const statuses = new Set(input.statuses ?? []);
    const rows = this.database.connection
      .prepare(`
        SELECT r.id
        FROM feature_revisions r
        JOIN feature_memories f ON f.id = r.feature_id
        WHERE f.room_id = ?
        ORDER BY r.created_at DESC, r.revision_number DESC
      `)
      .all(actor.roomId) as Row[];
    const entries = rows
      .map((row) => this.requireRevision(asString(row.id), actor.roomId))
      .map((revision) => ({
        revision,
        feature: this.requireFeature(revision.featureId, actor.roomId),
      }))
      .filter(({ feature, revision }) => {
        if (revision.status === "superseded") return false;
        if (statuses.size > 0) return statuses.has(revision.status);
        return feature.currentRevisionId === revision.id && revision.status === "current";
      })
      .map(({ feature, revision }) => featureIndexEntry(feature, revision));
    const query: FeatureMemoryRetrievalQuery = {
      mode: input.mode,
      objective: input.objective ?? input.query,
      paths: input.paths,
      systems: input.systems,
      symbols: input.symbols,
      tests: input.tests,
      memoryIds: input.featureIds,
      sections: input.sections,
      knownVersions: input.knownVersions,
      budgetTokens: input.budgetTokens,
      baseTokens: input.baseTokens,
      limit: input.limit,
      cursor: input.cursor,
    };
    return retrieveFeatureMemory(entries, query);
  }

  submitRevision(
    actor: FeatureMemoryActor,
    session: FeatureMemorySession,
    input: SubmitFeatureRevisionInput,
  ): FeatureRevision {
    requireActiveOwnedSession(actor, session);
    const featureKey = requiredText(input.featureKey, "Feature key", 240);
    const name = requiredText(input.name, "Feature name", 240);
    const systemId = requiredText(input.systemId, "System id", 500);
    const objective = requiredText(input.objective, "Feature objective", 10_000);
    const changeSummary = requiredText(input.changeSummary, "Change summary", 10_000);
    const relation = normalizeRelation(input.relation);
    const contractChanges = normalizeContractChanges(input.contractChanges);
    const requestedTargets = normalizeTargets(input.targets);
    const verifications = normalizeVerifications(input.verifications ?? []);
    const remainingRisks = stringArray(input.remainingRisks ?? [], "Remaining risks", 100, 2_000);
    const finalCommit = optionalText(input.finalCommit, "Final commit", 255);
    const completed = input.completed === true;
    const gitEvidence = objectValue(input.gitEvidence, "Git evidence");
    const createdAt = this.timestamp();

    return this.database.transaction(() => {
      const feature = this.findOrCreateFeature(actor, featureKey, name, systemId, createdAt);
      const currentRevision = feature.currentRevisionId
        ? this.requireRevision(feature.currentRevisionId, actor.roomId)
        : null;
      const parentRevision = input.parentRevisionId
        ? this.requireRevision(input.parentRevisionId, actor.roomId)
        : currentRevision;
      if (parentRevision && parentRevision.featureId !== feature.id) {
        throw new FeatureMemoryError(
          "feature_parent_mismatch",
          "The parent revision belongs to a different feature.",
          409,
        );
      }
      if (!parentRevision && relation !== "add") {
        throw new FeatureMemoryError(
          "feature_parent_required",
          "The first revision of a feature must use the add relation.",
          409,
        );
      }
      if (parentRevision && relation === "add") {
        throw new FeatureMemoryError(
          "feature_relation_invalid",
          "An existing feature must be extended, replaced, deprecated, rolled back, or marked conflicting.",
          409,
        );
      }

      const snapshot = buildSnapshot(
        parentRevision?.snapshot,
        name,
        systemId,
        objective,
        contractChanges,
        input.constraints ?? [],
        input.dependencies ?? [],
      );
      const targets = mergeTargets(parentRevision?.targets ?? [], requestedTargets, relation);
      if (targets.length === 0) {
        throw new FeatureMemoryError(
          "feature_targets_required",
          "A feature revision must identify at least one system, path, symbol, resource, or test target.",
        );
      }
      const revisionNumber = this.nextRevisionNumber(feature.id);
      const revisionId = randomUUID();
      const changedContractKeys = contractChanges.map((change) => contractKey(change.key));
      const conflictingRevisionIds = this.findCompetingRevisionIds(
        feature.id,
        parentRevision?.id ?? null,
        changedContractKeys,
      );
      let status = determineInitialStatus({
        relation,
        completed,
        finalCommit,
        branch: session.branch,
        defaultBranch: actor.defaultBranch,
        verifications,
        promotionEvidenceVerified: session.promotionEvidenceVerified === true,
      });
      const staleParent = Boolean(
        currentRevision
        && parentRevision
        && currentRevision.id !== parentRevision.id,
      );
      if (staleParent && (status === "current" || status === "deprecated")) {
        status = "conflict";
      }
      if (conflictingRevisionIds.length > 0) status = "conflict";

      this.insertRevision({
        id: revisionId,
        featureId: feature.id,
        revisionNumber,
        parentRevisionId: parentRevision?.id ?? null,
        relation,
        session,
        actor,
        finalCommit,
        completed,
        changeSummary,
        snapshot,
        contractChanges,
        targets,
        verifications,
        remainingRisks,
        gitEvidence,
        createdAt,
      });

      for (const competingId of conflictingRevisionIds) {
        if (this.latestStatus(competingId) !== "conflict") {
          this.appendStatusEvent(
            competingId,
            "conflict",
            actor.memberId,
            `A competing revision changed the same behavior contract as revision ${revisionId}.`,
            createdAt,
          );
        }
      }
      const reason = staleParent && status === "conflict"
        ? `The revision is based on stale revision ${parentRevision?.id}; current revision ${currentRevision?.id} must be preserved and reconciled explicitly.`
        : statusReason(
            status,
            session.branch,
            actor.defaultBranch,
            finalCommit,
            verifications,
            session.promotionEvidenceVerified === true,
          );
      this.appendStatusEvent(revisionId, status, actor.memberId, reason, createdAt);
      if (status === "current" || status === "deprecated") {
        this.activateRevision(feature, revisionId, status, snapshot, actor.memberId, createdAt);
      }

      return this.requireRevision(revisionId, actor.roomId);
    });
  }

  rollbackRevision(
    actor: FeatureMemoryActor,
    session: FeatureMemorySession,
    input: RollbackFeatureRevisionInput,
  ): FeatureRevision {
    requireActiveOwnedSession(actor, session);
    const feature = this.requireFeature(input.featureId, actor.roomId);
    const target = this.requireRevision(input.targetRevisionId, actor.roomId);
    if (target.featureId !== feature.id) {
      throw new FeatureMemoryError(
        "feature_rollback_target_mismatch",
        "The rollback target belongs to a different feature.",
        409,
      );
    }
    const current = feature.currentRevisionId
      ? this.requireRevision(feature.currentRevisionId, actor.roomId)
      : null;
    if (!current) {
      throw new FeatureMemoryError(
        "feature_current_missing",
        "A feature without a current revision cannot be rolled back.",
        409,
      );
    }
    const changeSummary = requiredText(input.changeSummary, "Rollback summary", 10_000);
    const verifications = normalizeVerifications(input.verifications ?? []);
    const finalCommit = optionalText(input.finalCommit, "Final commit", 255);
    const completed = input.completed === true;
    const gitEvidence = objectValue(input.gitEvidence, "Git evidence");
    const createdAt = this.timestamp();

    return this.database.transaction(() => {
      const revisionId = randomUUID();
      const status = determineInitialStatus({
        relation: "rollback",
        completed,
        finalCommit,
        branch: session.branch,
        defaultBranch: actor.defaultBranch,
        verifications,
        promotionEvidenceVerified: session.promotionEvidenceVerified === true,
      });
      this.insertRevision({
        id: revisionId,
        featureId: feature.id,
        revisionNumber: this.nextRevisionNumber(feature.id),
        parentRevisionId: current.id,
        relation: "rollback",
        session,
        actor,
        finalCommit,
        completed,
        changeSummary,
        snapshot: target.snapshot,
        contractChanges: diffContracts(current.snapshot.contracts, target.snapshot.contracts),
        targets: target.targets.map(targetInput),
        verifications,
        remainingRisks: [],
        gitEvidence: { ...gitEvidence, rollbackTargetRevisionId: target.id },
        createdAt,
      });
      this.appendStatusEvent(
        revisionId,
        status,
        actor.memberId,
        statusReason(
          status,
          session.branch,
          actor.defaultBranch,
          finalCommit,
          verifications,
          session.promotionEvidenceVerified === true,
        ),
        createdAt,
      );
      if (status === "current") {
        this.activateRevision(feature, revisionId, status, target.snapshot, actor.memberId, createdAt);
      }
      return this.requireRevision(revisionId, actor.roomId);
    });
  }

  promoteCandidate(
    actor: FeatureMemoryActor,
    session: FeatureMemorySession,
    revisionId: string,
  ): FeatureRevision {
    requireActiveOwnedSession(actor, session);
    if (!session.promotionEvidenceVerified) {
      return this.requireRevision(revisionId, actor.roomId);
    }

    return this.database.transaction(() => {
      const revision = this.requireRevision(revisionId, actor.roomId);
      if (revision.sourceSessionId !== session.id || revision.authorMemberId !== actor.memberId) {
        throw new FeatureMemoryError(
          "feature_session_mismatch",
          "The feature revision belongs to a different Agent session.",
          409,
        );
      }
      if (this.latestStatus(revision.id) !== "candidate") return revision;

      const promotedStatus = determineInitialStatus({
        relation: revision.relation,
        completed: revision.completed,
        finalCommit: revision.finalCommit,
        branch: revision.branch,
        defaultBranch: actor.defaultBranch,
        verifications: revision.verifications,
        promotionEvidenceVerified: true,
      });
      if (promotedStatus !== "current" && promotedStatus !== "deprecated") return revision;

      const feature = this.requireFeature(revision.featureId, actor.roomId);
      const staleParent = (feature.currentRevisionId ?? null) !== (revision.parentRevisionId ?? null);
      const competingRevisionIds = this.findCompetingRevisionIds(
        feature.id,
        revision.parentRevisionId,
        revision.contractChanges.map((change) => contractKey(change.key)),
      ).filter((id) => id !== revision.id);
      const now = this.timestamp();
      if (staleParent || competingRevisionIds.length > 0) {
        this.appendStatusEvent(
          revision.id,
          "conflict",
          actor.memberId,
          staleParent
            ? `The candidate is based on stale revision ${revision.parentRevisionId ?? "(none)"}; current revision ${feature.currentRevisionId ?? "(none)"} must be reconciled explicitly.`
            : "A competing candidate changes the same behavior contract and must be reconciled explicitly.",
          now,
        );
        for (const competingId of competingRevisionIds) {
          if (this.latestStatus(competingId) !== "conflict") {
            this.appendStatusEvent(
              competingId,
              "conflict",
              actor.memberId,
              `Revision ${revision.id} supplied final evidence for a competing behavior change.`,
              now,
            );
          }
        }
        return this.requireRevision(revision.id, actor.roomId);
      }

      this.appendStatusEvent(
        revision.id,
        promotedStatus,
        actor.memberId,
        statusReason(
          promotedStatus,
          revision.branch,
          actor.defaultBranch,
          revision.finalCommit,
          revision.verifications,
          true,
        ),
        now,
      );
      this.activateRevision(feature, revision.id, promotedStatus, revision.snapshot, actor.memberId, now);
      return this.requireRevision(revision.id, actor.roomId);
    });
  }

  query(actor: FeatureMemoryActor, input: FeatureMemoryQueryInput): FeatureMemoryQueryResult {
    const level = input.level ?? "cards";
    const maximum = level === "detail" ? 3 : 8;
    const limit = Math.max(1, Math.min(input.limit ?? maximum, maximum));
    const cursor = parseCursor(input.cursor);
    const query = input.query?.trim().toLocaleLowerCase("en-US") ?? "";
    const featureIds = new Set((input.featureIds ?? []).map((value) => value.trim()).filter(Boolean));
    const paths = (input.paths ?? []).map(normalizeFeaturePath);
    const systems = new Set((input.systems ?? []).map(normalizedText).filter(Boolean));
    const symbols = new Set((input.symbols ?? []).map(symbolKey).filter(Boolean));
    const statuses = new Set(input.statuses ?? []);
    const hasSelector = Boolean(query || featureIds.size || paths.length || systems.size || symbols.size || statuses.size);
    if (!hasSelector) return { level, cards: [], details: [], nextCursor: null };

    const rows = this.database.connection
      .prepare(`
        SELECT r.id
        FROM feature_revisions r
        JOIN feature_memories f ON f.id = r.feature_id
        WHERE f.room_id = ?
        ORDER BY r.created_at DESC, r.revision_number DESC
      `)
      .all(actor.roomId) as Row[];
    const candidates = rows
      .map((row) => this.requireRevision(asString(row.id), actor.roomId))
      .filter((revision) => {
        if (statuses.size > 0) return statuses.has(revision.status);
        const feature = this.requireFeature(revision.featureId, actor.roomId);
        return feature.currentRevisionId === revision.id;
      })
      .map((revision) => scoreRevision(revision, this.requireFeature(revision.featureId, actor.roomId), {
        query,
        featureIds,
        paths,
        systems,
        symbols,
        statuses,
      }))
      .filter((entry): entry is ScoredRevision => entry !== null)
      .sort((left, right) => right.score - left.score || left.feature.name.localeCompare(right.feature.name));
    const page = candidates.slice(cursor, cursor + limit);
    const nextCursor = cursor + limit < candidates.length ? String(cursor + limit) : null;
    return {
      level,
      cards: page.map(({ feature, revision, hitReasons }) => toCard(feature, revision, hitReasons)),
      details: level === "detail" ? page.map((entry) => entry.revision) : [],
      nextCursor,
    };
  }

  history(actor: FeatureMemoryActor, featureId: string): { feature: FeatureMemory; revisions: FeatureRevision[] } {
    const feature = this.requireFeature(featureId, actor.roomId);
    const rows = this.database.connection
      .prepare("SELECT id FROM feature_revisions WHERE feature_id = ? ORDER BY revision_number DESC")
      .all(feature.id) as Row[];
    return {
      feature,
      revisions: rows.map((row) => this.requireRevision(asString(row.id), actor.roomId)),
    };
  }

  checkHistoricalImpacts(input: HistoricalImpactCheckInput): HistoricalImpactCheckResult {
    requireActiveOwnedSession(input.actor, input.session);
    const edits = normalizeProposedEdits(input.paths, input.proposedEdits);
    const impacts = this.findImpacts(input.actor.roomId, edits);
    if (impacts.length === 0) return { impacts: [], authorized: true };
    const proposalHash = hashProposal(edits, impacts);
    const now = this.timestamp();
    const existing = this.database.connection
      .prepare(`
        SELECT * FROM feature_change_confirmations
        WHERE session_id = ? AND proposal_hash = ?
      `)
      .get(input.session.id, proposalHash) as Row | undefined;
    if (existing) {
      const confirmation = mapConfirmation(existing);
      const authorized = confirmation.status === "approved" && Date.parse(confirmation.expiresAt) > this.now().getTime();
      return { impacts, confirmation, authorized };
    }

    const confirmation: FeatureChangeConfirmation = {
      id: randomUUID(),
      roomId: input.actor.roomId,
      sessionId: input.session.id,
      memberId: input.actor.memberId,
      proposalHash,
      impacts,
      status: "pending",
      reason: null,
      createdAt: now,
      resolvedAt: null,
      expiresAt: new Date(this.now().getTime() + 24 * 60 * 60 * 1_000).toISOString(),
    };
    this.database.connection
      .prepare(`
        INSERT INTO feature_change_confirmations (
          id, room_id, session_id, member_id, proposal_hash, impacts_json, status,
          reason, created_at, resolved_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)
      `)
      .run(
        confirmation.id,
        confirmation.roomId,
        confirmation.sessionId,
        confirmation.memberId,
        confirmation.proposalHash,
        json(confirmation.impacts),
        confirmation.createdAt,
        confirmation.expiresAt,
      );
    return { impacts, confirmation, authorized: false };
  }

  resolveConfirmation(
    actor: FeatureMemoryActor,
    session: FeatureMemorySession,
    input: ResolveFeatureConfirmationInput,
  ): FeatureChangeConfirmation {
    requireActiveOwnedSession(actor, session);
    if (input.decision !== "approved" && input.decision !== "rejected") {
      throw new FeatureMemoryError(
        "invalid_feature_confirmation_decision",
        "Feature confirmation decision must be explicitly approved or rejected.",
      );
    }
    const row = this.database.connection
      .prepare("SELECT * FROM feature_change_confirmations WHERE id = ? AND room_id = ?")
      .get(input.confirmationId, actor.roomId) as Row | undefined;
    if (!row) throw new FeatureMemoryError("feature_confirmation_not_found", "Feature confirmation not found.", 404);
    const confirmation = mapConfirmation(row);
    if (confirmation.sessionId !== session.id || confirmation.memberId !== actor.memberId) {
      throw new FeatureMemoryError(
        "feature_confirmation_forbidden",
        "A feature confirmation can only be resolved by its current session member.",
        403,
      );
    }
    if (confirmation.status === "expired" || Date.parse(confirmation.expiresAt) <= this.now().getTime()) {
      this.database.connection
        .prepare("UPDATE feature_change_confirmations SET status = 'expired', resolved_at = ? WHERE id = ?")
        .run(this.timestamp(), confirmation.id);
      throw new FeatureMemoryError("feature_confirmation_expired", "The feature confirmation has expired.", 409);
    }
    if (confirmation.status !== "pending") {
      throw new FeatureMemoryError(
        "feature_confirmation_already_resolved",
        `The feature confirmation is already ${confirmation.status} and cannot be changed.`,
        409,
      );
    }
    const reason = optionalText(input.reason, "Confirmation reason", 2_000);
    const resolvedAt = this.timestamp();
    this.database.connection
      .prepare(`
        UPDATE feature_change_confirmations
        SET status = ?, reason = ?, resolved_at = ?
        WHERE id = ?
      `)
      .run(input.decision, reason, resolvedAt, confirmation.id);
    return mapConfirmation(
      this.database.connection
        .prepare("SELECT * FROM feature_change_confirmations WHERE id = ?")
        .get(confirmation.id) as Row,
    );
  }

  expireSessionConfirmations(sessionId: string, resolvedAt = this.timestamp()): void {
    this.database.connection
      .prepare(`
        UPDATE feature_change_confirmations
        SET status = 'expired', resolved_at = ?
        WHERE session_id = ? AND status IN ('pending', 'approved')
      `)
      .run(resolvedAt, sessionId);
  }

  private findOrCreateFeature(
    actor: FeatureMemoryActor,
    featureKey: string,
    name: string,
    systemId: string,
    now: string,
  ): FeatureMemory {
    const normalizedKey = normalizedText(featureKey);
    const existing = this.database.connection
      .prepare("SELECT * FROM feature_memories WHERE room_id = ? AND feature_key_normalized = ?")
      .get(actor.roomId, normalizedKey) as Row | undefined;
    if (existing) {
      return this.requireFeature(asString(existing.id), actor.roomId);
    }
    const featureId = randomUUID();
    this.database.connection
      .prepare(`
        INSERT INTO feature_memories (
          id, room_id, feature_key, feature_key_normalized, name, system_id,
          current_revision_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `)
      .run(featureId, actor.roomId, featureKey, normalizedKey, name, systemId, now, now);
    return this.requireFeature(featureId, actor.roomId);
  }

  private insertRevision(input: {
    id: string;
    featureId: string;
    revisionNumber: number;
    parentRevisionId: string | null;
    relation: FeatureRevisionRelation;
    session: FeatureMemorySession;
    actor: FeatureMemoryActor;
    finalCommit: string | null;
    completed: boolean;
    changeSummary: string;
    snapshot: FeatureRevisionSnapshot;
    contractChanges: FeatureContractChange[];
    targets: FeatureTargetInput[];
    verifications: FeatureVerificationEvidence[];
    remainingRisks: string[];
    gitEvidence: Record<string, unknown>;
    createdAt: string;
  }): void {
    this.database.connection
      .prepare(`
        INSERT INTO feature_revisions (
          id, feature_id, revision_number, parent_revision_id, relation, source_session_id,
          author_member_id, branch, base_commit, final_commit, completed, objective,
          change_summary, snapshot_json, contract_changes_json, verifications_json,
          remaining_risks_json, git_evidence_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.featureId,
        input.revisionNumber,
        input.parentRevisionId,
        input.relation,
        input.session.id,
        input.actor.memberId,
        input.session.branch,
        input.session.baseCommit,
        input.finalCommit,
        input.completed ? 1 : 0,
        input.snapshot.objective,
        input.changeSummary,
        json(input.snapshot),
        json(input.contractChanges),
        json(input.verifications),
        json(input.remainingRisks),
        json(input.gitEvidence),
        input.createdAt,
      );
    const insertTarget = this.database.connection.prepare(`
      INSERT INTO feature_revision_targets (
        id, revision_id, kind, role, path, path_key, symbol, symbol_key, signature, label
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const target of input.targets) {
      const normalized = normalizeTarget(target);
      insertTarget.run(
        randomUUID(),
        input.id,
        normalized.kind,
        normalized.role,
        normalized.path,
        normalized.path ? pathComparisonKey(normalized.path) : null,
        normalized.symbol,
        normalized.symbol ? symbolKey(normalized.symbol) : null,
        normalized.signature,
        normalized.label,
      );
    }
  }

  private activateRevision(
    feature: FeatureMemory,
    revisionId: string,
    status: "current" | "deprecated",
    snapshot: FeatureRevisionSnapshot,
    actorMemberId: string,
    now: string,
  ): void {
    if (feature.currentRevisionId && feature.currentRevisionId !== revisionId) {
      this.appendStatusEvent(
        feature.currentRevisionId,
        status === "deprecated" ? "deprecated" : "superseded",
        actorMemberId,
        `Revision ${revisionId} became the current effective feature memory.`,
        now,
      );
    }
    this.database.connection
      .prepare(`
        UPDATE feature_memories
        SET current_revision_id = ?, name = ?, system_id = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(revisionId, snapshot.name, snapshot.systemId, now, feature.id);
  }

  private findCompetingRevisionIds(
    featureId: string,
    parentRevisionId: string | null,
    changedContractKeys: string[],
  ): string[] {
    if (changedContractKeys.length === 0) return [];
    const rows = this.database.connection
      .prepare(`
        SELECT r.id, r.contract_changes_json
        FROM feature_revisions r
        WHERE r.feature_id = ? AND r.parent_revision_id IS ?
      `)
      .all(featureId, parentRevisionId) as Row[];
    const requested = new Set(changedContractKeys);
    return rows
      .filter((row) => {
        const status = this.latestStatus(asString(row.id));
        if (status !== "candidate" && status !== "conflict") return false;
        const changes = parseJson<FeatureContractChange[]>(row.contract_changes_json, []);
        return changes.some((change) => requested.has(contractKey(change.key)));
      })
      .map((row) => asString(row.id));
  }

  private findImpacts(roomId: string, edits: NormalizedEdit[]): FeatureImpact[] {
    const revisionRows = this.database.connection
      .prepare(`
        SELECT r.id
        FROM feature_memories f
        JOIN feature_revisions r ON r.id = f.current_revision_id
        JOIN feature_revision_events e ON e.sequence = (
          SELECT MAX(latest.sequence) FROM feature_revision_events latest WHERE latest.revision_id = r.id
        )
        WHERE f.room_id = ? AND e.status = 'current'
      `)
      .all(roomId) as Row[];
    const impacts: FeatureImpact[] = [];
    for (const row of revisionRows) {
      const revision = this.requireRevision(asString(row.id), roomId);
      const feature = this.requireFeature(revision.featureId, roomId);
      for (const edit of edits) {
        const matchingPathTargets = revision.targets.filter((target) =>
          target.path && pathsOverlap(target.path, edit.path),
        );
        if (matchingPathTargets.length === 0) continue;
        const exactTargets = matchingPathTargets.filter((target) =>
          (target.kind === "symbol" || target.kind === "interface")
          && target.symbol
          && [...edit.symbols].some((symbol) => symbolsMatch(target.symbol!, symbol)),
        );
        const pathTargets = matchingPathTargets.filter((target) =>
          target.kind === "path" || target.kind === "resource" || target.kind === "test",
        );
        let matchedTargets: FeatureTarget[];
        let confidence: FeatureImpact["confidence"];
        if (edit.precision === "symbol" && edit.symbols.size > 0) {
          matchedTargets = [...exactTargets, ...pathTargets];
          confidence = exactTargets.length > 0 ? "exact" : "fallback";
          if (matchedTargets.length === 0) continue;
        } else {
          matchedTargets = matchingPathTargets;
          confidence = "fallback";
        }
        const matchedSymbols = unique(
          matchedTargets.map((target) => target.symbol).filter((value): value is string => Boolean(value)),
        );
        impacts.push({
          featureId: feature.id,
          featureName: feature.name,
          revisionId: revision.id,
          revisionNumber: revision.revisionNumber,
          path: edit.path,
          symbols: matchedSymbols,
          contracts: revision.snapshot.contracts.map((contract) => contract.behavior).slice(0, 5),
          reason: confidence === "exact"
            ? `The proposed edit touches protected symbol(s): ${matchedSymbols.join(", ")}.`
            : "The protected target cannot be narrowed safely below this path or resource.",
          confidence,
        });
      }
    }
    return impacts.sort((left, right) =>
      `${left.featureId}\0${left.path}`.localeCompare(`${right.featureId}\0${right.path}`),
    );
  }

  private appendStatusEvent(
    revisionId: string,
    status: FeatureRevisionStatus,
    actorMemberId: string,
    reason: string,
    createdAt: string,
  ): void {
    this.database.connection
      .prepare(`
        INSERT INTO feature_revision_events (id, revision_id, status, actor_member_id, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(randomUUID(), revisionId, status, actorMemberId, reason, createdAt);
  }

  private latestStatus(revisionId: string): FeatureRevisionStatus {
    const row = this.database.connection
      .prepare(`
        SELECT status FROM feature_revision_events
        WHERE revision_id = ? ORDER BY sequence DESC LIMIT 1
      `)
      .get(revisionId) as Row | undefined;
    if (!row) throw new FeatureMemoryError("feature_status_missing", "The feature revision has no status event.", 500);
    return asString(row.status) as FeatureRevisionStatus;
  }

  private nextRevisionNumber(featureId: string): number {
    const row = this.database.connection
      .prepare("SELECT COALESCE(MAX(revision_number), 0) AS maximum FROM feature_revisions WHERE feature_id = ?")
      .get(featureId) as Row;
    return asNumber(row.maximum) + 1;
  }

  private requireFeature(id: string, roomId: string): FeatureMemory {
    const row = this.database.connection
      .prepare("SELECT * FROM feature_memories WHERE id = ? AND room_id = ?")
      .get(id, roomId) as Row | undefined;
    if (!row) throw new FeatureMemoryError("feature_not_found", "Feature memory not found.", 404);
    return mapFeature(row);
  }

  private requireRevision(id: string, roomId: string): FeatureRevision {
    const row = this.database.connection
      .prepare(`
        SELECT r.*, m.name AS author_name, f.name AS feature_name, f.system_id AS feature_system_id
        FROM feature_revisions r
        JOIN feature_memories f ON f.id = r.feature_id
        JOIN members m ON m.id = r.author_member_id
        WHERE r.id = ? AND f.room_id = ?
      `)
      .get(id, roomId) as Row | undefined;
    if (!row) throw new FeatureMemoryError("feature_revision_not_found", "Feature revision not found.", 404);
    const targetRows = this.database.connection
      .prepare("SELECT * FROM feature_revision_targets WHERE revision_id = ? ORDER BY kind, path_key, symbol_key")
      .all(id) as Row[];
    const storedSnapshot = parseJson<Partial<FeatureRevisionSnapshot>>(row.snapshot_json, {});
    return {
      id: asString(row.id),
      featureId: asString(row.feature_id),
      revisionNumber: asNumber(row.revision_number),
      parentRevisionId: nullableString(row.parent_revision_id),
      relation: asString(row.relation) as FeatureRevisionRelation,
      status: this.latestStatus(id),
      sourceSessionId: asString(row.source_session_id),
      authorMemberId: asString(row.author_member_id),
      authorName: asString(row.author_name),
      branch: nullableString(row.branch),
      baseCommit: nullableString(row.base_commit),
      finalCommit: nullableString(row.final_commit),
      completed: asNumber(row.completed) !== 0,
      changeSummary: asString(row.change_summary),
      snapshot: {
        name: storedSnapshot.name ?? asString(row.feature_name),
        systemId: storedSnapshot.systemId ?? asString(row.feature_system_id),
        objective: storedSnapshot.objective ?? asString(row.objective),
        contracts: storedSnapshot.contracts ?? [],
        constraints: storedSnapshot.constraints ?? [],
        dependencies: storedSnapshot.dependencies ?? [],
      },
      contractChanges: parseJson<FeatureContractChange[]>(row.contract_changes_json, []),
      targets: targetRows.map(mapTarget),
      verifications: parseJson<FeatureVerificationEvidence[]>(row.verifications_json, []),
      remainingRisks: parseJson<string[]>(row.remaining_risks_json, []),
      gitEvidence: parseJson<Record<string, unknown>>(row.git_evidence_json, {}),
      createdAt: asString(row.created_at),
    };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

interface ScoredRevision {
  feature: FeatureMemory;
  revision: FeatureRevision;
  score: number;
  hitReasons: string[];
}

interface NormalizedEdit {
  path: string;
  precision: "symbol" | "resource" | "path";
  symbols: Set<string>;
  operation: "add" | "update" | "delete" | "move" | "unknown";
}

function buildSnapshot(
  parent: FeatureRevisionSnapshot | undefined,
  name: string,
  systemId: string,
  objective: string,
  changes: FeatureContractChange[],
  constraints: string[],
  dependencies: string[],
): FeatureRevisionSnapshot {
  const contracts = new Map((parent?.contracts ?? []).map((contract) => [contractKey(contract.key), contract]));
  for (const change of changes) {
    const key = contractKey(change.key);
    const existing = contracts.get(key);
    if (change.operation === "remove") {
      if (!existing) throw new FeatureMemoryError("feature_contract_missing", `Contract ${change.key} does not exist.`, 409);
      contracts.delete(key);
      continue;
    }
    if (change.operation === "add" && existing) {
      throw new FeatureMemoryError("feature_contract_exists", `Contract ${change.key} already exists.`, 409);
    }
    if (change.operation === "update" && !existing) {
      throw new FeatureMemoryError("feature_contract_missing", `Contract ${change.key} does not exist.`, 409);
    }
    const behavior = requiredText(change.behavior, "Contract behavior", 10_000);
    contracts.set(key, {
      key: change.key,
      behavior,
      constraints: unique([...(existing?.constraints ?? []), ...(change.constraints ?? [])]),
    });
  }
  if (contracts.size === 0) {
    throw new FeatureMemoryError(
      "feature_contracts_required",
      "A feature revision must retain at least one behavior contract.",
    );
  }
  return {
    name,
    systemId,
    objective,
    contracts: [...contracts.values()].sort((left, right) => left.key.localeCompare(right.key)),
    constraints: unique([...(parent?.constraints ?? []), ...stringArray(constraints, "Constraints", 200, 2_000)]),
    dependencies: unique([...(parent?.dependencies ?? []), ...stringArray(dependencies, "Dependencies", 200, 2_000)]),
  };
}

function normalizeContractChanges(values: FeatureContractChange[]): FeatureContractChange[] {
  if (!Array.isArray(values) || values.length > 100) {
    throw new FeatureMemoryError("invalid_feature_contract_changes", "Contract changes must contain at most 100 items.");
  }
  return values.map((value) => {
    if (!value || !["add", "update", "remove"].includes(value.operation)) {
      throw new FeatureMemoryError("invalid_feature_contract_change", "Unsupported contract change operation.");
    }
    const key = requiredText(value.key, "Contract key", 240);
    return {
      operation: value.operation,
      key,
      behavior: value.operation === "remove" ? undefined : requiredText(value.behavior, "Contract behavior", 10_000),
      constraints: value.constraints === undefined
        ? undefined
        : stringArray(value.constraints, "Contract constraints", 100, 2_000),
    };
  });
}

function normalizeTargets(values: FeatureTargetInput[]): FeatureTargetInput[] {
  if (!Array.isArray(values) || values.length > 300) {
    throw new FeatureMemoryError("invalid_feature_targets", "Feature targets must contain at most 300 items.");
  }
  const result = new Map<string, FeatureTargetInput>();
  for (const value of values) {
    const target = normalizeTarget(value);
    result.set(targetKey(target), targetInput(target));
  }
  return [...result.values()];
}

function normalizeTarget(value: FeatureTargetInput): FeatureTarget {
  const kinds = ["system", "path", "symbol", "interface", "resource", "test"];
  const roles = ["implementation", "contract", "dependency", "verification"];
  if (!value || !kinds.includes(value.kind)) {
    throw new FeatureMemoryError("invalid_feature_target_kind", "Unsupported feature target kind.");
  }
  const role = value.role ?? defaultTargetRole(value.kind);
  if (!roles.includes(role)) throw new FeatureMemoryError("invalid_feature_target_role", "Unsupported feature target role.");
  const path = value.path === undefined ? null : normalizeFeaturePath(value.path);
  const symbol = optionalText(value.symbol, "Target symbol", 1_000);
  if (value.kind !== "system" && !path) {
    throw new FeatureMemoryError("feature_target_path_required", `${value.kind} targets require a repository path.`);
  }
  if ((value.kind === "symbol" || value.kind === "interface") && !symbol) {
    throw new FeatureMemoryError("feature_target_symbol_required", `${value.kind} targets require a symbol.`);
  }
  return {
    id: "",
    revisionId: "",
    kind: value.kind,
    role,
    path,
    symbol,
    signature: optionalText(value.signature, "Target signature", 2_000),
    label: optionalText(value.label, "Target label", 1_000),
  };
}

function mergeTargets(
  inherited: FeatureTarget[],
  requested: FeatureTargetInput[],
  relation: FeatureRevisionRelation,
): FeatureTargetInput[] {
  if (!inherited.length) return requested;
  if (relation === "deprecate" && requested.length > 0) return requested;
  const result = new Map<string, FeatureTargetInput>();
  for (const target of inherited.map(targetInput)) result.set(targetKey(normalizeTarget(target)), target);
  for (const target of requested) result.set(targetKey(normalizeTarget(target)), target);
  return [...result.values()];
}

function normalizeVerifications(values: FeatureVerificationEvidence[]): FeatureVerificationEvidence[] {
  if (!Array.isArray(values) || values.length > 100) {
    throw new FeatureMemoryError("invalid_feature_verifications", "Feature verifications must contain at most 100 items.");
  }
  return values.map((value) => {
    if (!value || !["passed", "failed", "pending"].includes(value.result)) {
      throw new FeatureMemoryError("invalid_feature_verification", "Unsupported feature verification result.");
    }
    return {
      testKey: requiredText(value.testKey, "Verification test key", 500),
      result: value.result,
      summary: requiredText(value.summary, "Verification summary", 10_000),
      command: optionalText(value.command, "Verification command", 4_000) ?? undefined,
      evidence: optionalText(value.evidence, "Verification evidence", 10_000) ?? undefined,
    };
  });
}

function determineInitialStatus(input: {
  relation: FeatureRevisionRelation;
  completed: boolean;
  finalCommit: string | null;
  branch: string | null;
  defaultBranch: string;
  verifications: FeatureVerificationEvidence[];
  promotionEvidenceVerified: boolean;
}): FeatureRevisionStatus {
  if (input.relation === "conflict") return "conflict";
  if (!input.completed || !input.finalCommit) return "draft";
  const verified = input.verifications.length > 0
    && input.verifications.every((verification) => verification.result === "passed");
  const onDefaultBranch = normalizedText(input.branch ?? "") === normalizedText(input.defaultBranch);
  if (!verified || !onDefaultBranch || !input.promotionEvidenceVerified) return "candidate";
  return input.relation === "deprecate" ? "deprecated" : "current";
}

function statusReason(
  status: FeatureRevisionStatus,
  branch: string | null,
  defaultBranch: string,
  finalCommit: string | null,
  verifications: FeatureVerificationEvidence[],
  promotionEvidenceVerified: boolean,
): string {
  if (status === "draft") return "The revision is incomplete or has no reliable final commit evidence.";
  if (status === "conflict") return "The revision conflicts with another candidate that changes the same behavior contract.";
  if (status === "candidate") {
    if (normalizedText(branch ?? "") !== normalizedText(defaultBranch)) {
      return `The revision is committed on ${branch ?? "an unknown branch"}, not the room default branch ${defaultBranch}.`;
    }
    if (!finalCommit) return "The revision has no final commit evidence.";
    if (!promotionEvidenceVerified) {
      return "The submitted Git and verification claims have not been matched to this session's recorded Hook evidence.";
    }
    return verifications.length === 0
      ? "The revision has no associated regression verification."
      : "At least one associated regression verification has not passed.";
  }
  if (status === "deprecated") return "The verified deprecation revision is the current effective memory.";
  return "The revision is committed on the default branch and all associated verification passed.";
}

function scoreRevision(
  revision: FeatureRevision,
  feature: FeatureMemory,
  selectors: {
    query: string;
    featureIds: Set<string>;
    paths: string[];
    systems: Set<string>;
    symbols: Set<string>;
    statuses: Set<FeatureRevisionStatus>;
  },
): ScoredRevision | null {
  let score = 0;
  const hitReasons: string[] = [];
  const revisionName = revision.snapshot.name ?? feature.name;
  const revisionSystemId = revision.snapshot.systemId ?? feature.systemId;
  if (selectors.featureIds.has(feature.id)) {
    score += 120;
    hitReasons.push("feature id matched");
  }
  if (selectors.systems.has(normalizedText(revisionSystemId))) {
    score += 90;
    hitReasons.push(`system ${revisionSystemId} matched`);
  }
  const matchedSymbols = revision.targets
    .map((target) => target.symbol)
    .filter((value): value is string => Boolean(value))
    .filter((value) => selectors.symbols.has(symbolKey(value)));
  if (matchedSymbols.length) {
    score += 110;
    hitReasons.push(`symbol ${unique(matchedSymbols).join(", ")} matched`);
  }
  const matchedPaths = revision.targets
    .map((target) => target.path)
    .filter((value): value is string => Boolean(value))
    .filter((targetPath) => selectors.paths.some((path) => pathsOverlap(targetPath, path)));
  if (matchedPaths.length) {
    score += 80;
    hitReasons.push(`path ${unique(matchedPaths).slice(0, 3).join(", ")} matched`);
  }
  if (selectors.query) {
    const haystack = JSON.stringify({
      feature: [feature.featureKey, revisionName, revisionSystemId],
      revision: [revision.snapshot, revision.targets, revision.changeSummary],
    }).toLocaleLowerCase("en-US");
    if (haystack.includes(selectors.query)) {
      score += 40;
      hitReasons.push(`query "${selectors.query}" matched`);
    }
  }
  if (selectors.statuses.has(revision.status)) {
    score += 10;
    hitReasons.push(`status ${revision.status} matched`);
  }
  return score > 0 ? { feature, revision, score, hitReasons } : null;
}

function toCard(feature: FeatureMemory, revision: FeatureRevision, hitReasons: string[]): FeatureMemoryCard {
  const paths = unique(revision.targets.map((target) => target.path).filter((value): value is string => Boolean(value)));
  const symbols = unique(revision.targets.map((target) => target.symbol).filter((value): value is string => Boolean(value)));
  return {
    featureId: feature.id,
    featureKey: feature.featureKey,
    name: revision.snapshot.name ?? feature.name,
    systemId: revision.snapshot.systemId ?? feature.systemId,
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    status: revision.status,
    coreContract: revision.snapshot.contracts[0]?.behavior ?? revision.snapshot.objective,
    paths: paths.slice(0, 8),
    symbols: symbols.slice(0, 8),
    verificationStatus: verificationStatus(revision.verifications),
    hitReasons,
  };
}

function featureIndexEntry(
  feature: FeatureMemory,
  revision: FeatureRevision,
): FeatureMemoryIndexEntry {
  const paths = unique(revision.targets
    .map((target) => target.path)
    .filter((value): value is string => Boolean(value)));
  const symbols = unique(revision.targets
    .map((target) => target.symbol)
    .filter((value): value is string => Boolean(value)));
  const tests = unique([
    ...revision.targets
      .filter((target) => target.kind === "test")
      .map((target) => target.path)
      .filter((value): value is string => Boolean(value)),
    ...revision.verifications.map((verification) => verification.testKey),
  ]);
  const behaviorContract = revision.snapshot.contracts
    .map((contract) => `${contract.key}: ${contract.behavior}`)
    .join("\n");
  return {
    memoryId: feature.id,
    versionId: revision.id,
    featureName: revision.snapshot.name ?? feature.name,
    systemId: revision.snapshot.systemId ?? feature.systemId,
    objective: revision.snapshot.objective,
    behaviorContract: behaviorContract || revision.snapshot.objective,
    paths,
    symbols,
    tests,
    dependencies: revision.snapshot.dependencies,
    validationStatus: verificationStatus(revision.verifications),
    state: featureRetrievalState(revision.status),
    sections: {
      behavior: revision.snapshot.contracts,
      constraints: revision.snapshot.constraints,
      implementation: {
        changeSummary: revision.changeSummary,
        targets: revision.targets,
      },
      dependencies: revision.snapshot.dependencies,
      verification: revision.verifications,
      risks: revision.remainingRisks,
      provenance: {
        revisionNumber: revision.revisionNumber,
        relation: revision.relation,
        authorMemberId: revision.authorMemberId,
        authorName: revision.authorName,
        sourceSessionId: revision.sourceSessionId,
        branch: revision.branch,
        baseCommit: revision.baseCommit,
        finalCommit: revision.finalCommit,
        createdAt: revision.createdAt,
      },
      gitEvidence: revision.gitEvidence,
    },
    evidence: {
      verifications: revision.verifications,
      gitEvidence: revision.gitEvidence,
    },
    updatedAt: revision.createdAt,
  };
}

function featureRetrievalState(status: FeatureRevisionStatus): FeatureMemoryIndexEntry["state"] {
  if (status === "superseded") return "historical";
  return status;
}

function verificationStatus(values: FeatureVerificationEvidence[]): VerificationResult | "missing" {
  if (!values.length) return "missing";
  if (values.some((value) => value.result === "failed")) return "failed";
  if (values.some((value) => value.result === "pending")) return "pending";
  return "passed";
}

function normalizeProposedEdits(paths: string[], edits?: ProposedFeatureEdit[]): NormalizedEdit[] {
  const source: ProposedFeatureEdit[] = edits?.length
    ? edits
    : paths.map((path) => ({ path, precision: "path", operation: "unknown" }));
  const result = new Map<string, NormalizedEdit>();
  for (const edit of source) {
    const normalizedPath = normalizeFeaturePath(edit.path);
    const precision = edit.precision ?? (edit.symbols?.length ? "symbol" : "path");
    const operation = edit.operation ?? "unknown";
    const symbols = new Set((edit.symbols ?? []).map(symbolKey).filter(Boolean));
    const key = `${pathComparisonKey(normalizedPath)}\0${precision}\0${[...symbols].sort().join(",")}\0${operation}`;
    result.set(key, { path: normalizedPath, precision, operation, symbols });
  }
  return [...result.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function hashProposal(edits: NormalizedEdit[], impacts: FeatureImpact[]): string {
  const canonical = {
    edits: edits.map((edit) => ({
      path: pathComparisonKey(edit.path),
      precision: edit.precision,
      operation: edit.operation,
      symbols: [...edit.symbols].sort(),
    })),
    impacts: impacts.map((impact) => ({
      featureId: impact.featureId,
      revisionId: impact.revisionId,
      path: pathComparisonKey(impact.path),
      symbols: impact.symbols.map(symbolKey).sort(),
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function diffContracts(current: FeatureContract[], target: FeatureContract[]): FeatureContractChange[] {
  const currentByKey = new Map(current.map((contract) => [contractKey(contract.key), contract]));
  const targetByKey = new Map(target.map((contract) => [contractKey(contract.key), contract]));
  const changes: FeatureContractChange[] = [];
  for (const contract of current) {
    if (!targetByKey.has(contractKey(contract.key))) {
      changes.push({ operation: "remove", key: contract.key });
    }
  }
  for (const contract of target) {
    const existing = currentByKey.get(contractKey(contract.key));
    changes.push({
      operation: existing ? "update" : "add",
      key: contract.key,
      behavior: contract.behavior,
      constraints: contract.constraints,
    });
  }
  return changes;
}

function mapFeature(row: Row): FeatureMemory {
  return {
    id: asString(row.id),
    roomId: asString(row.room_id),
    featureKey: asString(row.feature_key),
    name: asString(row.name),
    systemId: asString(row.system_id),
    currentRevisionId: nullableString(row.current_revision_id),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapTarget(row: Row): FeatureTarget {
  return {
    id: asString(row.id),
    revisionId: asString(row.revision_id),
    kind: asString(row.kind) as FeatureTarget["kind"],
    role: asString(row.role) as FeatureTarget["role"],
    path: nullableString(row.path),
    symbol: nullableString(row.symbol),
    signature: nullableString(row.signature),
    label: nullableString(row.label),
  };
}

function mapConfirmation(row: Row): FeatureChangeConfirmation {
  return {
    id: asString(row.id),
    roomId: asString(row.room_id),
    sessionId: asString(row.session_id),
    memberId: asString(row.member_id),
    proposalHash: asString(row.proposal_hash),
    impacts: parseJson<FeatureImpact[]>(row.impacts_json, []),
    status: asString(row.status) as FeatureChangeConfirmation["status"],
    reason: nullableString(row.reason),
    createdAt: asString(row.created_at),
    resolvedAt: nullableString(row.resolved_at),
    expiresAt: asString(row.expires_at),
  };
}

function targetInput(target: FeatureTarget | FeatureTargetInput): FeatureTargetInput {
  return {
    kind: target.kind,
    role: target.role,
    path: target.path ?? undefined,
    symbol: target.symbol ?? undefined,
    signature: target.signature ?? undefined,
    label: target.label ?? undefined,
  };
}

function targetKey(target: FeatureTarget): string {
  return [
    target.kind,
    target.role,
    target.path ? pathComparisonKey(target.path) : "",
    target.symbol ? symbolKey(target.symbol) : "",
    normalizedText(target.signature ?? ""),
  ].join("\0");
}

function defaultTargetRole(kind: FeatureTargetInput["kind"]): FeatureTarget["role"] {
  if (kind === "interface") return "contract";
  if (kind === "test") return "verification";
  if (kind === "system") return "dependency";
  return "implementation";
}

function normalizeRelation(
  value: SubmitFeatureRevisionInput["relation"],
): Exclude<FeatureRevisionRelation, "rollback"> {
  const relation = value ?? "add";
  if (!["add", "extend", "replace", "deprecate", "conflict"].includes(relation)) {
    throw new FeatureMemoryError("invalid_feature_relation", "Unsupported feature revision relation.");
  }
  return relation;
}

function normalizeFeaturePath(value: string): string {
  try {
    return normalizeRepoPath(value);
  } catch (error) {
    throw new FeatureMemoryError(
      "invalid_feature_path",
      error instanceof Error ? error.message : "Invalid repository path.",
    );
  }
}

function requireActiveOwnedSession(actor: FeatureMemoryActor, session: FeatureMemorySession): void {
  if (session.memberId !== actor.memberId) {
    throw new FeatureMemoryError("feature_session_forbidden", "The feature session belongs to another member.", 403);
  }
  if (session.status !== "active") {
    throw new FeatureMemoryError("feature_session_not_active", "The feature session is not active.", 409);
  }
}

function parseCursor(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new FeatureMemoryError("invalid_feature_cursor", "Feature query cursor is invalid.");
  }
  return parsed;
}

function contractKey(value: string): string {
  return normalizedText(value);
}

function symbolKey(value: string): string {
  return normalizedText(value);
}

function symbolsMatch(left: string, right: string): boolean {
  const leftKey = symbolKey(left);
  const rightKey = symbolKey(right);
  if (leftKey === rightKey) return true;
  if (leftKey.includes(".") && rightKey.includes(".")) return false;
  return terminalSymbolKey(leftKey) === terminalSymbolKey(rightKey);
}

function terminalSymbolKey(value: string): string {
  return value.slice(value.lastIndexOf(".") + 1);
}

function normalizedText(value: string): string {
  return value.trim().normalize("NFC").toLocaleLowerCase("en-US");
}

function requiredText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new FeatureMemoryError("invalid_feature_input", `${name} is required.`);
  const text = value.trim();
  if (text.length > maximum) throw new FeatureMemoryError("invalid_feature_input", `${name} is too long.`);
  return text;
}

function optionalText(value: unknown, name: string, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, name, maximum);
}

function stringArray(values: unknown, name: string, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(values) || values.length > maximumItems || values.some((value) => typeof value !== "string")) {
    throw new FeatureMemoryError("invalid_feature_input", `${name} must be a string array with at most ${maximumItems} items.`);
  }
  return unique(values.map((value) => requiredText(value, name, maximumLength)));
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FeatureMemoryError("invalid_feature_input", `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}
