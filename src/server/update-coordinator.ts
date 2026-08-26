import {
  AGENT_HUB_PROTOCOL_VERSION,
  AGENT_HUB_SCHEMA_VERSION,
  AGENT_HUB_VERSION,
} from "../shared/version.js";

export type UpdateState = "retired" | "failed";

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  protocolVersion: number;
  schemaVersion: number;
  checkedAt?: string;
  error: string;
}

export interface UpdateCoordinatorOptions {
  currentVersion?: string;
  protocolVersion?: number;
  schemaVersion?: number;
  manifestUrl?: string;
  stagingDirectory: string;
  databasePath?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const RETIRED_MESSAGE =
  "Room-service-only script updates were retired in Agent Hub 0.2.0. Use the signed desktop updater.";

/**
 * Compatibility shim for the old room update REST endpoints.
 *
 * The 0.1.0 implementation downloaded and executed an arbitrary external `.mjs`
 * service entry. Keeping these methods non-operational prevents mixed-version
 * desktop/service installs while older renderers transition to the desktop IPC API.
 */
export class UpdateCoordinator {
  private readonly now: () => Date;
  private status: UpdateStatus;

  constructor(options: UpdateCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.status = {
      state: "retired",
      currentVersion: options.currentVersion ?? AGENT_HUB_VERSION,
      protocolVersion: options.protocolVersion ?? AGENT_HUB_PROTOCOL_VERSION,
      schemaVersion: options.schemaVersion ?? AGENT_HUB_SCHEMA_VERSION,
      error: RETIRED_MESSAGE,
    };
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  async check(): Promise<UpdateStatus> {
    this.status = {
      ...this.status,
      state: "retired",
      checkedAt: this.now().toISOString(),
      error: RETIRED_MESSAGE,
    };
    return this.getStatus();
  }

  async stage(): Promise<UpdateStatus> {
    this.status = {
      ...this.status,
      state: "failed",
      checkedAt: this.now().toISOString(),
      error: RETIRED_MESSAGE,
    };
    throw new Error(RETIRED_MESSAGE);
  }

  async backupDatabase(): Promise<undefined> {
    throw new Error(RETIRED_MESSAGE);
  }

  async clearStaged(): Promise<void> {
    // There is deliberately no executable service package to clear in 0.2.0.
  }
}
