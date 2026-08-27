import type { Readable, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsRequest,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { SecretProtector } from "../desktop/connection-store.js";
import { AGENT_HUB_VERSION } from "../shared/version.js";
import {
  resolveConnectionRecordById,
  type ResolvedRoomConnection,
} from "./connection-runtime.js";
import { getLocalIntegrationStatus, getRuntimeIntegrationStatus } from "./integration-gate.js";
import {
  IntegrationOperationTracker,
  type ConnectionOperationTracker,
} from "./integration-operations.js";

export interface RunMcpBridgeOptions {
  connectionId: string;
  userDataPath: string;
  protector?: SecretProtector;
  stdin?: Readable;
  stdout?: Writable;
  fetchImpl?: typeof fetch;
  /** Override used by tests; production uses the shared runtime sentinel. */
  runtimePresencePath?: string;
  remoteConnectTimeoutMs?: number;
}

export interface RemoteMcpTools {
  getInstructions(): string | undefined;
  listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult>;
  callTool(params: CallToolRequest["params"]): Promise<CallToolResult | { toolResult: unknown }>;
}

/**
 * The local bridge is useful even while the desktop app is paused or offline.
 * Keep the instructions local so the initial MCP handshake never needs to
 * contact the room server.
 */
export const LOCAL_MCP_BRIDGE_INSTRUCTIONS = [
  "Agent Hub local bridge.",
  "The room connection is established lazily when a tool is requested.",
  "An empty tool list means the local integration is paused or the room is temporarily unavailable.",
].join(" ");

export function createMcpProxyServer(remote: RemoteMcpTools): Server {
  const server = new Server(
    { name: "agent-hub-local-bridge", version: AGENT_HUB_VERSION },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: remote.getInstructions(),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, (request) => remote.listTools(request.params));
  server.setRequestHandler(CallToolRequestSchema, (request) => remote.callTool(request.params));
  return server;
}

export async function runMcpBridge(options: RunMcpBridgeOptions): Promise<void> {
  if (!options.connectionId.trim()) throw new Error("An Agent Hub connection ID is required.");
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const localTransport = new StdioServerTransport(input, output);
  // Start the local MCP endpoint first. In particular, a paused connection or
  // an unavailable room must still complete the local initialize handshake.
  let notifyToolsChanged = (): Promise<void> => Promise.resolve();
  const lazyRemote = createLazyMcpTools({
    connectionId: options.connectionId,
    userDataPath: options.userDataPath,
    protector: options.protector,
    fetchImpl: options.fetchImpl,
    runtimePresencePath: options.runtimePresencePath,
    remoteConnectTimeoutMs: options.remoteConnectTimeoutMs,
    onRemoteAvailabilityChanged: () => notifyToolsChanged(),
  });
  const localServer = createMcpProxyServer(lazyRemote);
  notifyToolsChanged = () => localServer.sendToolListChanged().catch(() => undefined);
  const closed = streamClosed(input);

  try {
    await localServer.connect(localTransport);
    const availabilityMonitor = startMcpAvailabilityMonitor(
      () => lazyRemote.probeAvailability(),
      () => localServer.sendToolListChanged(),
    );
    try {
      await closed;
    } finally {
      await availabilityMonitor.stop();
    }
  } finally {
    await localServer.close().catch(() => undefined);
    await lazyRemote.close();
  }
}

export interface LazyMcpToolsOptions {
  connectionId: string;
  userDataPath: string;
  protector?: SecretProtector;
  fetchImpl?: typeof fetch;
  runtimePresencePath?: string;
  remoteConnectTimeoutMs?: number;
  operationTracker?: Pick<ConnectionOperationTracker, "run">;
  /** Test seam for simulating an already-connected transport closing asynchronously. */
  remoteClientFactory?: () => Client;
  /** Requests an immediate local tools/list refresh after remote loss or recovery. */
  onRemoteAvailabilityChanged?: (
    active: boolean,
    diagnostic?: string,
  ) => Promise<void> | void;
}

export interface LazyMcpTools extends RemoteMcpTools {
  isLocallyAvailable(): Promise<boolean>;
  probeAvailability(): Promise<boolean>;
  close(): Promise<void>;
}

export interface McpAvailabilityMonitor {
  scanNow(): Promise<void>;
  stop(): Promise<void>;
}

/** Watch only local files; a state change asks Codex to refresh tool discovery. */
export function startMcpAvailabilityMonitor(
  probe: () => Promise<boolean>,
  onChanged: (active: boolean) => Promise<void> | void,
  intervalMs = 5_000,
): McpAvailabilityMonitor {
  let previous: boolean | undefined;
  let stopped = false;
  let running: Promise<void> | undefined;
  const scanNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      const active = await probe();
      if (previous !== undefined && previous !== active) await onChanged(active);
      previous = active;
    })().finally(() => {
      running = undefined;
    });
    return running;
  };
  void scanNow().catch(() => undefined);
  const timer = setInterval(() => void scanNow().catch(() => undefined), intervalMs);
  timer.unref();
  return {
    scanNow,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}

/**
 * Build the remote side of the bridge without opening a network connection.
 * Every request re-reads the connection gate, which makes pausing a connection
 * effective for an already-running MCP process as well as for new processes.
 */
export function createLazyMcpTools(options: LazyMcpToolsOptions): LazyMcpTools {
  return new LazyMcpToolsImpl(options);
}

class LazyMcpToolsImpl implements LazyMcpTools {
  private remoteClient: Client | undefined;
  private remoteConnectionKey: string | undefined;
  private connectPromise: Promise<Client | undefined> | undefined;
  private connectAbortController: AbortController | undefined;
  private generation = 0;
  private remoteFailure: RemoteFailureState | undefined;
  private remoteAvailable: boolean | undefined;
  private readonly operationTracker: Pick<ConnectionOperationTracker, "run">;

  constructor(private readonly options: LazyMcpToolsOptions) {
    this.operationTracker = options.operationTracker
      ?? new IntegrationOperationTracker(options.userDataPath);
  }

  getInstructions(): string {
    return LOCAL_MCP_BRIDGE_INSTRUCTIONS;
  }

  async isLocallyAvailable(): Promise<boolean> {
    try {
      if (!(await getRuntimeIntegrationStatus(
        this.options.userDataPath,
        this.options.runtimePresencePath,
      )).active) {
        await this.invalidateForLocalInactivity();
        return false;
      }
      const record = await resolveConnectionRecordById(
        this.options.userDataPath,
        this.options.connectionId.trim(),
        this.options.protector,
      );
      const status = await getLocalIntegrationStatus(
        this.options.userDataPath,
        record.connection,
        this.options.runtimePresencePath,
      );
      if (!status.active || !status.remoteAllowed) {
        await this.invalidateForLocalInactivity();
        return false;
      }
      return true;
    } catch (error) {
      await this.invalidateForLocalInactivity();
      if (!isMissingConnectionError(error)) {
        this.recordRemoteFailure(
          new McpCredentialError(error),
          `local\u0000${this.options.connectionId.trim()}`,
        );
      }
      return false;
    }
  }

  async probeAvailability(): Promise<boolean> {
    if (!(await this.isLocallyAvailable())) return false;
    if (!this.remoteFailure) return true;
    if (!this.remoteFailure.retryable
      && await this.failureStillAppliesToCurrentConnection(this.remoteFailure)) {
      return false;
    }
    return this.operationTracker.run(this.options.connectionId.trim(), async () =>
      Boolean(await this.ensureRemote()));
  }

  async listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult> {
    if (!(await this.isLocallyAvailable())) {
      this.throwPermanentRemoteFailure();
      return { tools: [] };
    }
    return this.operationTracker.run(this.options.connectionId.trim(), async () => {
      const remote = await this.ensureRemote();
      if (!remote) {
        this.throwPermanentRemoteFailure();
        return { tools: [] };
      }
      const remoteKey = this.remoteConnectionKey;
      try {
        // Calling listTools for every local discovery request also refreshes the
        // tool metadata immediately after an offline -> online transition.
        const result = await withTimeout(
          remote.listTools(params),
          remoteTimeoutMs(this.options),
          "Agent Hub MCP tool discovery",
        );
        this.markRemoteAvailable();
        return result;
      } catch (error) {
        await this.handleRemoteFailure(remote, error, remoteKey);
        this.throwPermanentRemoteFailure();
        return { tools: [] };
      }
    });
  }

  async callTool(
    params: CallToolRequest["params"],
  ): Promise<CallToolResult | { toolResult: unknown }> {
    if (!(await this.isLocallyAvailable())) {
      return unavailableToolResult(this.remoteFailure?.diagnostic);
    }
    return this.operationTracker.run(this.options.connectionId.trim(), async () => {
      const remote = await this.ensureRemote();
      if (!remote) return unavailableToolResult(this.remoteFailure?.diagnostic);
      const remoteKey = this.remoteConnectionKey;
      try {
        const result = await withTimeout(
          remote.callTool(params),
          remoteTimeoutMs(this.options),
          "Agent Hub MCP tool call",
        );
        this.markRemoteAvailable();
        return result;
      } catch (error) {
        await this.handleRemoteFailure(remote, error, remoteKey);
        return unavailableToolResult(this.remoteFailure?.diagnostic ?? error);
      }
    });
  }

  async close(): Promise<void> {
    this.generation += 1;
    this.connectAbortController?.abort();
    this.connectAbortController = undefined;
    const remote = this.remoteClient;
    this.remoteClient = undefined;
    this.remoteConnectionKey = undefined;
    if (remote) await closeMcpClient(remote);
  }

  private async ensureRemote(): Promise<Client | undefined> {
    try {
      if (!(await this.isLocallyAvailable())) return undefined;
      const record = await resolveConnectionRecordById(
        this.options.userDataPath,
        this.options.connectionId.trim(),
        this.options.protector,
      );
      const status = await getLocalIntegrationStatus(
        this.options.userDataPath,
        record.connection,
        this.options.runtimePresencePath,
      );
      if (!status.active || !status.remoteAllowed) {
        await this.invalidate();
        return undefined;
      }

      const key = connectionKey(record.connection);
      if (this.remoteFailure && !this.remoteFailure.retryable) {
        if (this.remoteFailure.connectionKey === key) return undefined;
        // Credentials or endpoint changed locally. Permit exactly one new
        // handshake; an unchanged authentication failure is never polled.
        this.remoteFailure = undefined;
      }
      if (this.remoteClient && this.remoteConnectionKey === key) return this.remoteClient;
      // Share an in-flight handshake with concurrent tools/list or tools/call
      // requests. Invalidating it here would make its generation stale.
      if (this.connectPromise && !this.remoteClient) return this.connectPromise;
      // A changed token/server URL must not share the previous remote session.
      await this.invalidate();
      if (this.connectPromise) return this.connectPromise;
      const generation = this.generation;
      this.connectPromise = this.connectRemote(record, key, generation).finally(() => {
        this.connectPromise = undefined;
      });
      return await this.connectPromise;
    } catch {
      await this.invalidate();
      return undefined;
    }
  }

  private async connectRemote(
    record: { connection: ResolvedRoomConnection["connection"]; store: ResolvedRoomConnection["store"] },
    key: string,
    generation: number,
  ): Promise<Client | undefined> {
    let memberToken: string;
    try {
      memberToken = await record.store.readMemberToken(record.connection.id);
    } catch (error) {
      this.recordRemoteFailure(new McpCredentialError(error), key);
      return undefined;
    }
    const endpoint = new URL(`${record.connection.serverUrl.replace(/\/+$/, "")}/mcp`);
    const abortController = new AbortController();
    this.connectAbortController = abortController;
    const timeoutMs = remoteTimeoutMs(this.options);
    const remoteTransport = new StreamableHTTPClientTransport(endpoint, {
      fetch: createTimeoutFetch(
        this.options.fetchImpl ?? fetch,
        timeoutMs,
        abortController.signal,
      ),
      requestInit: {
        headers: { Authorization: `Bearer ${memberToken}` },
      },
    });
    const remoteClient = this.options.remoteClientFactory?.() ?? new Client(
      { name: "agent-hub-desktop-bridge", version: AGENT_HUB_VERSION },
      { capabilities: {} },
    );
    let lifecycleReady = false;
    let pendingLifecycleFailure: Error | undefined;
    let pendingLifecycleClose = false;
    const previousOnError = remoteClient.onerror;
    remoteClient.onerror = (error) => {
      previousOnError?.(error);
      if (!lifecycleReady) {
        pendingLifecycleFailure ??= error;
        return;
      }
      void this.handleRemoteFailure(remoteClient, error, key).catch(() => undefined);
    };
    const previousOnClose = remoteClient.onclose;
    remoteClient.onclose = () => {
      previousOnClose?.();
      if (!lifecycleReady) {
        pendingLifecycleClose = true;
        return;
      }
      void this.handleRemoteFailure(
        remoteClient,
        new Error("Agent Hub MCP remote connection closed unexpectedly."),
        key,
        true,
      ).catch(() => undefined);
    };
    let checkingGate = false;
    const gateTimer = setInterval(() => {
      if (checkingGate || abortController.signal.aborted) return;
      checkingGate = true;
      void this.connectionIsCurrent(record.connection.id, key)
        .then((active) => {
          if (!active) abortController.abort();
        })
        .catch(() => abortController.abort())
        .finally(() => { checkingGate = false; });
    }, 100);
    gateTimer.unref();
    try {
      await withTimeout(
        remoteClient.connect(remoteTransport),
        timeoutMs,
        "Agent Hub MCP remote handshake",
        () => abortController.abort(),
      );
    } catch (error) {
      if (await this.connectionIsCurrent(record.connection.id, key).catch(() => false)) {
        this.recordRemoteFailure(error, key);
      }
      abortController.abort();
      await closeMcpClient(remoteClient);
      return undefined;
    } finally {
      clearInterval(gateTimer);
      if (this.connectAbortController === abortController) this.connectAbortController = undefined;
    }
    if (generation !== this.generation || !(await this.connectionIsCurrent(record.connection.id, key))) {
      await closeMcpClient(remoteClient);
      return undefined;
    }
    this.remoteClient = remoteClient;
    this.remoteConnectionKey = key;
    lifecycleReady = true;
    if (pendingLifecycleFailure || pendingLifecycleClose) {
      await this.handleRemoteFailure(
        remoteClient,
        pendingLifecycleFailure
          ?? new Error("Agent Hub MCP remote connection closed unexpectedly."),
        key,
        pendingLifecycleClose && !pendingLifecycleFailure,
      );
      return undefined;
    }
    this.markRemoteAvailable();
    return remoteClient;
  }

  private async failureStillAppliesToCurrentConnection(
    failure: RemoteFailureState,
  ): Promise<boolean> {
    try {
      const record = await resolveConnectionRecordById(
        this.options.userDataPath,
        this.options.connectionId.trim(),
        this.options.protector,
      );
      return connectionKey(record.connection) === failure.connectionKey;
    } catch {
      return true;
    }
  }

  private async handleRemoteFailure(
    remote: Client,
    error: unknown,
    key: string | undefined,
    forceTransient = false,
  ): Promise<void> {
    if (this.remoteClient !== remote) return;
    this.recordRemoteFailure(error, key ?? this.remoteConnectionKey ?? "", forceTransient);
    await this.invalidate(remote);
  }

  private recordRemoteFailure(
    error: unknown,
    key: string,
    forceTransient = false,
  ): void {
    const classification = forceTransient
      ? transientClosedConnectionFailure(error)
      : classifyRemoteFailure(error);
    this.remoteFailure = { ...classification, connectionKey: key };
    if (this.remoteAvailable !== false) {
      this.remoteAvailable = false;
      this.notifyRemoteAvailability(false, classification.diagnostic);
    }
  }

  private markRemoteAvailable(): void {
    const recovered = this.remoteAvailable === false;
    this.remoteFailure = undefined;
    this.remoteAvailable = true;
    if (recovered) this.notifyRemoteAvailability(true);
  }

  private notifyRemoteAvailability(active: boolean, diagnostic?: string): void {
    try {
      void Promise.resolve(this.options.onRemoteAvailabilityChanged?.(active, diagnostic))
        .catch(() => undefined);
    } catch {
      // Tool-list notifications are advisory and must not break the bridge.
    }
  }

  private throwPermanentRemoteFailure(): void {
    if (!this.remoteFailure || this.remoteFailure.retryable) return;
    throw new Error(this.remoteFailure.diagnostic, { cause: this.remoteFailure.error });
  }

  private async connectionIsCurrent(connectionId: string, key: string): Promise<boolean> {
    const record = await resolveConnectionRecordById(
      this.options.userDataPath,
      connectionId,
      this.options.protector,
    );
    if (connectionKey(record.connection) !== key) return false;
    const status = await getLocalIntegrationStatus(
      this.options.userDataPath,
      record.connection,
      this.options.runtimePresencePath,
    );
    return status.active && status.remoteAllowed;
  }

  private async invalidate(expected?: Client): Promise<void> {
    if (expected && this.remoteClient !== expected) return;
    this.generation += 1;
    this.connectAbortController?.abort();
    this.connectAbortController = undefined;
    const remote = this.remoteClient;
    this.remoteClient = undefined;
    this.remoteConnectionKey = undefined;
    if (remote) await closeMcpClient(remote);
  }

  private async invalidateForLocalInactivity(): Promise<void> {
    await this.invalidate();
    this.remoteFailure = undefined;
    this.remoteAvailable = undefined;
  }
}

function createTimeoutFetch(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  cancellationSignal: AbortSignal,
): typeof fetch {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("The Agent Hub MCP connection timeout must be positive.");
  }
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const signals = [cancellationSignal, AbortSignal.timeout(timeoutMs)];
    if (init?.signal) signals.push(init.signal);
    return fetchImpl(input, { ...init, signal: AbortSignal.any(signals) });
  }) as typeof fetch;
}

function remoteTimeoutMs(options: Pick<LazyMcpToolsOptions, "remoteConnectTimeoutMs">): number {
  const timeoutMs = options.remoteConnectTimeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("The Agent Hub MCP connection timeout must be positive.");
  }
  return timeoutMs;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} did not respond within ${timeoutMs} ms.`));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeMcpClient(client: Client): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 250);
    timer.unref();
  });
  try {
    await Promise.race([client.close().catch(() => undefined), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function connectionKey(connection: ResolvedRoomConnection["connection"]): string {
  return `${connection.id}\u0000${connection.serverUrl}\u0000${connection.updatedAt}`;
}

function unavailableToolResult(error?: unknown): CallToolResult {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "";
  const detail = message ? ` (${message})` : "";
  return {
    isError: true,
    content: [{
      type: "text",
      text: `Agent Hub MCP is currently unavailable or paused${detail}.`,
    }],
  };
}

interface RemoteFailureClassification {
  retryable: boolean;
  error: Error;
  diagnostic: string;
}

interface RemoteFailureState extends RemoteFailureClassification {
  connectionKey: string;
}

function classifyRemoteFailure(error: unknown): RemoteFailureClassification {
  const normalized = normalizeRemoteError(error);
  if (error instanceof McpCredentialError) {
    return {
      retryable: false,
      error: normalized,
      diagnostic: `Agent Hub MCP credentials are missing or damaged and could not be read: ${normalized.message}`,
    };
  }
  if (error instanceof StreamableHTTPError) {
    const status = error.code;
    if (status === 401 || status === 403) {
      return {
        retryable: false,
        error: normalized,
        diagnostic: status === 401
          ? "Agent Hub MCP authentication failed (HTTP 401). Rejoin the room or refresh this connection's credentials."
          : "Agent Hub MCP authorization was rejected (HTTP 403). Ask the room owner to verify this member's access, then rejoin the room.",
      };
    }
    if (status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599)) {
      return {
        retryable: true,
        error: normalized,
        diagnostic: `Agent Hub MCP is temporarily unavailable (HTTP ${status}). It will retry automatically.`,
      };
    }
    return {
      retryable: false,
      error: normalized,
      diagnostic: status === undefined
        ? `Agent Hub MCP returned a permanent transport error: ${normalized.message}`
        : `Agent Hub MCP request failed (HTTP ${status}): ${normalized.message}`,
    };
  }
  if (isNetworkFailure(normalized)) {
    return {
      retryable: true,
      error: normalized,
      diagnostic: `Agent Hub MCP is temporarily unavailable: ${normalized.message}`,
    };
  }
  return {
    retryable: false,
    error: normalized,
    diagnostic: `Agent Hub MCP stopped after a permanent remote error: ${normalized.message}`,
  };
}

class McpCredentialError extends Error {
  constructor(error: unknown) {
    const cause = normalizeRemoteError(error);
    super(cause.message, { cause });
    this.name = "McpCredentialError";
  }
}

function transientClosedConnectionFailure(error: unknown): RemoteFailureClassification {
  const normalized = normalizeRemoteError(error);
  return {
    retryable: true,
    error: normalized,
    diagnostic: `${normalized.message} Agent Hub will reconnect automatically.`,
  };
}

function normalizeRemoteError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isNetworkFailure(error: Error): boolean {
  return error.name === "AbortError"
    || /(?:fetch failed|failed to fetch|network|socket|econn|enotfound|eai_again|etimedout|timed out|did not respond|connection reset|connection refused|aborted|maximum reconnection)/i.test(
      error.message,
    );
}

function isMissingConnectionError(error: unknown): boolean {
  return error instanceof Error
    && /room connection no longer exists/i.test(error.message);
}

function streamClosed(stream: Readable): Promise<void> {
  if (stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("end", finish);
      stream.off("close", finish);
      stream.off("error", fail);
    };
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", fail);
  });
}
