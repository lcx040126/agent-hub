import type { AgentHubDatabase } from "./db.js";

export const ACTIVITY_RETENTION_DAYS = {
  ordinary: 30,
  scope: 90,
} as const;

export const DEFAULT_ACTIVITY_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_ACTIVITY_RETENTION_BATCH_SIZE = 500;

const ORDINARY_ACTIVITY_TYPES = ["scan.recorded", "lease.scope_observed"] as const;
const SCOPE_ACTIVITY_TYPES = [
  "lease.scope_observed",
  "lease.scope_expanded",
  "lease.scope_covered",
] as const;

export interface ActivityRetentionStat {
  roomId: string;
  activityType: string;
  deleted: number;
  cutoffAt: string;
}

export interface ActivityRetentionReport {
  startedAt: string;
  completedAt: string;
  deleted: number;
  stats: ActivityRetentionStat[];
  failures: Array<{ roomId: string; activityType: string; error: string }>;
}

export interface CleanupActivitiesOptions {
  now?: () => Date;
  batchSize?: number;
}

export interface ActivityRetentionSchedulerOptions extends CleanupActivitiesOptions {
  database: AgentHubDatabase;
  intervalMs?: number;
  onReport?: (report: ActivityRetentionReport) => void;
  onError?: (error: Error) => void;
}

export interface ActivityRetentionScheduler {
  runNow(): Promise<ActivityRetentionReport>;
  stop(): Promise<void>;
}

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deleteActivityBatch(
  database: AgentHubDatabase,
  roomId: string,
  activityType: string,
  cutoffAt: string,
  batchSize: number,
  scopeEvents: boolean,
): number {
  return database.transaction(() => {
    const scopePredicate = scopeEvents
      ? `
          AND a.entity_type = 'lease'
          AND EXISTS (
            SELECT 1 FROM leases l
            WHERE l.id = a.entity_id
              AND l.room_id = a.room_id
              AND l.status IN ('completed', 'cancelled', 'expired')
              AND NOT EXISTS (
                SELECT 1 FROM work_sessions ws
                WHERE ws.id = l.session_id
                  AND (ws.status <> 'closed' OR ws.finalizing_at IS NOT NULL)
              )
              AND NOT EXISTS (
                SELECT 1 FROM release_requests rr
                WHERE rr.status = 'pending'
                  AND (rr.requester_lease_id = l.id OR rr.conflicting_lease_id = l.id)
              )
          )`
      : `
          AND (
            a.type = 'scan.recorded'
            OR (a.type = 'lease.scope_observed' AND a.entity_type = 'session')
          )
          AND NOT EXISTS (
            SELECT 1 FROM work_sessions ws
            WHERE ws.id = a.entity_id
              AND (ws.status <> 'closed' OR ws.finalizing_at IS NOT NULL)
          )
          AND NOT EXISTS (
            SELECT 1 FROM local_scans ls
            JOIN work_sessions scan_session ON scan_session.id = ls.session_id
            WHERE ls.id = a.entity_id
              AND (scan_session.status <> 'closed' OR scan_session.finalizing_at IS NOT NULL)
          )
          AND NOT EXISTS (
            SELECT 1 FROM work_sessions metadata_session
            WHERE metadata_session.id = json_extract(a.metadata_json, '$.sessionId')
              AND (metadata_session.status <> 'closed' OR metadata_session.finalizing_at IS NOT NULL)
          )
          AND NOT EXISTS (
            SELECT 1 FROM release_requests pending_request
            WHERE pending_request.status = 'pending'
              AND (
                pending_request.id = a.entity_id
                OR pending_request.id = json_extract(a.metadata_json, '$.requestId')
                OR pending_request.requester_lease_id = json_extract(a.metadata_json, '$.leaseId')
                OR pending_request.conflicting_lease_id = json_extract(a.metadata_json, '$.leaseId')
              )
          )`;
    const rows = database.connection.prepare(`
      SELECT a.id
      FROM activities a
      WHERE a.room_id = ?
        AND a.type = ?
        AND a.created_at < ?
        ${scopePredicate}
      ORDER BY a.created_at ASC, a.id ASC
      LIMIT ?
    `).all(roomId, activityType, cutoffAt, batchSize) as Array<{ id?: unknown }>;
    if (rows.length === 0) return 0;
    const placeholders = rows.map(() => "?").join(", ");
    const ids = rows.map((row) => String(row.id));
    database.connection.prepare(`DELETE FROM activities WHERE id IN (${placeholders})`).run(...ids);
    return ids.length;
  });
}

export function cleanupActivities(
  database: AgentHubDatabase,
  options: CleanupActivitiesOptions = {},
): ActivityRetentionReport {
  const now = options.now?.() ?? new Date();
  const batchSize = Math.max(1, Math.min(Math.trunc(options.batchSize ?? DEFAULT_ACTIVITY_RETENTION_BATCH_SIZE), 5000));
  const startedAt = now.toISOString();
  const stats: ActivityRetentionStat[] = [];
  const failures: ActivityRetentionReport["failures"] = [];
  const rooms = database.connection.prepare("SELECT id FROM rooms ORDER BY id").all() as Array<{ id?: unknown }>;
  const policies = [
    { types: ORDINARY_ACTIVITY_TYPES, days: ACTIVITY_RETENTION_DAYS.ordinary, scopeEvents: false },
    { types: SCOPE_ACTIVITY_TYPES, days: ACTIVITY_RETENTION_DAYS.scope, scopeEvents: true },
  ] as const;

  for (const room of rooms) {
    const roomId = String(room.id);
    for (const policy of policies) {
      const cutoffAt = isoDaysAgo(now, policy.days);
      for (const activityType of policy.types) {
        let deleted = 0;
        try {
          do {
            const count = deleteActivityBatch(
              database,
              roomId,
              activityType,
              cutoffAt,
              batchSize,
              policy.scopeEvents,
            );
            deleted += count;
            if (count < batchSize) break;
          } while (true);
        } catch (error) {
          failures.push({ roomId, activityType, error: errorMessage(error) });
        }
        if (deleted > 0) stats.push({ roomId, activityType, deleted, cutoffAt });
      }
    }
  }

  if (stats.length > 0) {
    try {
      database.connection.exec("PRAGMA optimize");
    } catch {
      // SQLite optimization is best effort and must never affect collaboration.
    }
  }
  const completedAt = new Date().toISOString();
  return {
    startedAt,
    completedAt,
    deleted: stats.reduce((total, stat) => total + stat.deleted, 0),
    stats,
    failures,
  };
}

export function startActivityRetentionScheduler(
  options: ActivityRetentionSchedulerOptions,
): ActivityRetentionScheduler {
  const intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_ACTIVITY_RETENTION_INTERVAL_MS);
  let stopped = false;
  let running: Promise<ActivityRetentionReport> | null = null;
  const execute = (): Promise<ActivityRetentionReport> => {
    if (running) return running;
    running = Promise.resolve().then(() => cleanupActivities(options.database, options))
      .then((report) => {
        options.onReport?.(report);
        if (report.failures.length > 0) {
          for (const failure of report.failures) {
            options.onError?.(new Error(`Activity cleanup failed for room ${failure.roomId} (${failure.activityType}): ${failure.error}`));
          }
        }
        return report;
      })
      .catch((error) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        options.onError?.(normalized);
        throw normalized;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  const timer = setInterval(() => {
    if (!stopped) void execute().catch(() => {});
  }, intervalMs);
  timer.unref?.();
  void execute().catch(() => {});
  return {
    runNow: execute,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (running) await running.catch(() => {});
    },
  };
}
