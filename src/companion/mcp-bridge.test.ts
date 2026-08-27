import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionStore, type SecretProtector } from "../desktop/connection-store.js";
import {
  createLazyMcpTools,
  createMcpProxyServer,
  startMcpAvailabilityMonitor,
} from "./mcp-bridge.js";
import { PausePreparationQueue } from "./pause-preparation.js";
import { writeRuntimePresenceRecord, type RuntimePresenceRecord } from "./runtime-presence.js";

const closers: Array<() => Promise<void>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Agent Hub stdio bridge server", () => {
  it("forwards tool discovery and calls without exposing credentials", async () => {
    const remote = {
      getInstructions: () => "Use Agent Hub before editing.",
      listTools: vi.fn(async () => ({
        tools: [{
          name: "context_query",
          description: "Read shared context",
          inputSchema: { type: "object" as const, properties: {} },
        }],
      })),
      callTool: vi.fn(async (params: { name: string; arguments?: Record<string, unknown> }) => ({
        content: [{ type: "text" as const, text: JSON.stringify(params.arguments ?? {}) }],
        structuredContent: { forwarded: true },
      })),
    };
    const server = createMcpProxyServer(remote);
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(() => client.close(), () => server.close());

    await expect(client.listTools()).resolves.toMatchObject({
      tools: [{ name: "context_query" }],
    });
    await expect(client.callTool({
      name: "context_query",
      arguments: { paths: ["src/app.ts"] },
    })).resolves.toMatchObject({ structuredContent: { forwarded: true } });
    expect(remote.callTool).toHaveBeenCalledWith({
      name: "context_query",
      arguments: { paths: ["src/app.ts"] },
    });
    expect(client.getInstructions()).toBe("Use Agent Hub before editing.");
  });
});

describe("lazy Agent Hub MCP connection", () => {
  it("does not contact the room while paused, then connects and refreshes after recovery", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-"));
    temporaryDirectories.push(directory);
    const presencePath = path.join(directory, "runtime-presence.json");
    const store = new ConnectionStore(path.join(directory, "connections.json"), plainTextProtector());
    const connection = await store.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: directory,
    });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => mcpResponse(init));
    const lazy = createLazyMcpTools({
      connectionId: connection.id,
      userDataPath: directory,
      protector: plainTextProtector(),
      fetchImpl,
      runtimePresencePath: presencePath,
    });
    closers.push(() => lazy.close());
    const availabilityChanged = vi.fn(async (_active: boolean) => undefined);
    const monitor = startMcpAvailabilityMonitor(
      () => lazy.isLocallyAvailable(),
      availabilityChanged,
      60_000,
    );
    closers.push(() => monitor.stop());

    await expect(lazy.listTools()).resolves.toEqual({ tools: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
    await monitor.scanNow();

    await writeRuntimePresenceRecord(presencePath, activePresence());
    await monitor.scanNow();
    expect(availabilityChanged).toHaveBeenLastCalledWith(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(lazy.listTools()).resolves.toMatchObject({ tools: [{ name: "context_query" }] });
    expect(fetchImpl.mock.calls.filter(([, init]) => methodOf(init) === "initialize")).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([, init]) => methodOf(init) === "tools/list")).toHaveLength(1);

    await writeRuntimePresenceRecord(presencePath, { ...activePresence(), status: "stopped" });
    await monitor.scanNow();
    expect(availabilityChanged).toHaveBeenLastCalledWith(false);
    await expect(lazy.listTools()).resolves.toEqual({ tools: [] });

    await writeRuntimePresenceRecord(presencePath, activePresence());
    await expect(lazy.listTools()).resolves.toMatchObject({ tools: [{ name: "context_query" }] });
    expect(fetchImpl.mock.calls.filter(([, init]) => methodOf(init) === "initialize")).toHaveLength(2);
  });

  it("returns an empty tool set without a remote handshake while exit cleanup is pending", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-pending-"));
    temporaryDirectories.push(directory);
    const presencePath = path.join(directory, "runtime-presence.json");
    const store = new ConnectionStore(path.join(directory, "connections.json"), plainTextProtector());
    const connection = await store.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: directory,
    });
    await writeRuntimePresenceRecord(presencePath, activePresence());
    const preparations = new PausePreparationQueue({
      filePath: path.join(directory, "pause-preparation.json"),
    });
    await preparations.enqueue({
      connectionId: connection.id,
      reason: "app-shutdown",
      requestId: "pending-mcp-cleanup",
    });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => mcpResponse(init));
    let markersAvailable = false;
    const operationRun = vi.fn(async <T>(
      _connectionId: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      if (!markersAvailable) throw new Error("operation markers are unavailable");
      return operation();
    });
    const lazy = createLazyMcpTools({
      connectionId: connection.id,
      userDataPath: directory,
      protector: plainTextProtector(),
      fetchImpl,
      runtimePresencePath: presencePath,
      operationTracker: { run: operationRun },
    });
    closers.push(() => lazy.close());

    await expect(lazy.listTools()).resolves.toEqual({ tools: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(operationRun).not.toHaveBeenCalled();

    await preparations.remove("pending-mcp-cleanup");
    markersAvailable = true;
    await expect(lazy.listTools()).resolves.toMatchObject({ tools: [{ name: "context_query" }] });
    expect(fetchImpl.mock.calls.filter(([, init]) => methodOf(init) === "initialize")).toHaveLength(1);
    expect(operationRun).toHaveBeenCalledOnce();
  });

  it("reports damaged local credentials without contacting the room or retrying", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-credentials-"));
    temporaryDirectories.push(directory);
    const presencePath = path.join(directory, "runtime-presence.json");
    const damagedProtector: SecretProtector = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, "utf8"),
      decryptString: () => { throw new Error("DPAPI payload is damaged"); },
    };
    const store = new ConnectionStore(path.join(directory, "connections.json"), damagedProtector);
    const connection = await store.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: directory,
    });
    await writeRuntimePresenceRecord(presencePath, activePresence());
    const fetchImpl = vi.fn<typeof fetch>();
    const availabilityChanged = vi.fn();
    const lazy = createLazyMcpTools({
      connectionId: connection.id,
      userDataPath: directory,
      protector: damagedProtector,
      fetchImpl,
      runtimePresencePath: presencePath,
      onRemoteAvailabilityChanged: availabilityChanged,
    });
    closers.push(() => lazy.close());

    await expect(lazy.listTools()).rejects.toThrow(/credentials are missing or damaged/i);
    await expect(lazy.listTools()).rejects.toThrow(/DPAPI payload is damaged/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(availabilityChanged).toHaveBeenCalledWith(
      false,
      expect.stringMatching(/credentials are missing or damaged/i),
    );
  });

  it("reports a damaged connection store instead of silently returning no tools", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-store-damaged-"));
    temporaryDirectories.push(directory);
    const presencePath = path.join(directory, "runtime-presence.json");
    const store = new ConnectionStore(path.join(directory, "connections.json"), plainTextProtector());
    const connection = await store.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: directory,
    });
    await writeRuntimePresenceRecord(presencePath, activePresence());
    await writeFile(path.join(directory, "connections.json"), "{damaged", "utf8");
    const lazy = createLazyMcpTools({
      connectionId: connection.id,
      userDataPath: directory,
      protector: plainTextProtector(),
      fetchImpl: vi.fn<typeof fetch>(),
      runtimePresencePath: presencePath,
    });
    closers.push(() => lazy.close());

    await expect(lazy.listTools()).rejects.toThrow(/connection store is not valid JSON/i);
    await expect(lazy.callTool({ name: "context_query", arguments: {} })).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringMatching(/connection store is not valid JSON/i) }],
    });
  });

  it("keeps the local tool endpoint usable when the room is offline and retries later", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-"));
    temporaryDirectories.push(directory);
    const presencePath = path.join(directory, "runtime-presence.json");
    const store = new ConnectionStore(path.join(directory, "connections.json"), plainTextProtector());
    const connection = await store.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: directory,
    });
    await writeRuntimePresenceRecord(presencePath, activePresence());
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("fetch failed: network unavailable");
    });
    const lazy = createLazyMcpTools({
      connectionId: connection.id,
      userDataPath: directory,
      protector: plainTextProtector(),
      fetchImpl,
      runtimePresencePath: presencePath,
    });
    closers.push(() => lazy.close());

    await expect(lazy.listTools()).resolves.toEqual({ tools: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    fetchImpl.mockImplementation(async (_input, init) => mcpResponse(init));
    await expect(lazy.listTools()).resolves.toMatchObject({ tools: [{ name: "context_query" }] });
    expect(fetchImpl.mock.calls.filter(([, init]) => methodOf(init) === "initialize")).toHaveLength(2);
  });

  it("times out a remote handshake that never settles", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-"));
    temporaryDirectories.push(directory);
    const presencePath = path.join(directory, "runtime-presence.json");
    const store = new ConnectionStore(path.join(directory, "connections.json"), plainTextProtector());
    const connection = await store.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: directory,
    });
    await writeRuntimePresenceRecord(presencePath, activePresence());
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const lazy = createLazyMcpTools({
      connectionId: connection.id,
      userDataPath: directory,
      protector: plainTextProtector(),
      fetchImpl,
      runtimePresencePath: presencePath,
      remoteConnectTimeoutMs: 30,
    });
    closers.push(() => lazy.close());

    await expect(lazy.listTools()).resolves.toEqual({ tools: [] });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("discards a remote handshake completed after the local integration pauses", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-"));
    temporaryDirectories.push(directory);
    const presencePath = path.join(directory, "runtime-presence.json");
    const store = new ConnectionStore(path.join(directory, "connections.json"), plainTextProtector());
    const connection = await store.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: directory,
    });
    await writeRuntimePresenceRecord(presencePath, activePresence());
    let releaseInitialize: (() => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      if (methodOf(init) !== "initialize") return Promise.resolve(mcpResponse(init));
      return new Promise<Response>((resolve) => {
        releaseInitialize = () => resolve(mcpResponse(init));
      });
    });
    const lazy = createLazyMcpTools({
      connectionId: connection.id,
      userDataPath: directory,
      protector: plainTextProtector(),
      fetchImpl,
      runtimePresencePath: presencePath,
      remoteConnectTimeoutMs: 1_000,
    });
    closers.push(() => lazy.close());

    const discovery = lazy.listTools();
    await vi.waitFor(() => expect(releaseInitialize).toBeTypeOf("function"));
    await writeRuntimePresenceRecord(presencePath, { ...activePresence(), status: "stopped" });
    releaseInitialize?.();

    await expect(discovery).resolves.toEqual({ tools: [] });
    expect(fetchImpl.mock.calls.filter(([, init]) => methodOf(init) === "tools/list")).toHaveLength(0);
  });

  it("announces remote recovery after an earlier network failure", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-"));
    temporaryDirectories.push(directory);
    const presencePath = path.join(directory, "runtime-presence.json");
    const store = new ConnectionStore(path.join(directory, "connections.json"), plainTextProtector());
    const connection = await store.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: directory,
    });
    await writeRuntimePresenceRecord(presencePath, activePresence());
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("fetch failed: network unavailable");
    });
    const lazy = createLazyMcpTools({
      connectionId: connection.id,
      userDataPath: directory,
      protector: plainTextProtector(),
      fetchImpl,
      runtimePresencePath: presencePath,
    });
    closers.push(() => lazy.close());
    const availabilityChanged = vi.fn(async (_active: boolean) => undefined);
    const monitor = startMcpAvailabilityMonitor(
      () => lazy.probeAvailability(),
      availabilityChanged,
      60_000,
    );
    closers.push(() => monitor.stop());
    await monitor.scanNow();

    await expect(lazy.listTools()).resolves.toEqual({ tools: [] });
    await monitor.scanNow();
    expect(availabilityChanged).toHaveBeenLastCalledWith(false);

    fetchImpl.mockImplementation(async (_input, init) => mcpResponse(init));
    await monitor.scanNow();
    expect(availabilityChanged).toHaveBeenLastCalledWith(true);
    await expect(lazy.listTools()).resolves.toMatchObject({ tools: [{ name: "context_query" }] });
  });

  it("announces an asynchronous transport close and refreshes tools again after reconnecting", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-"));
    temporaryDirectories.push(directory);
    const presencePath = path.join(directory, "runtime-presence.json");
    const store = new ConnectionStore(path.join(directory, "connections.json"), plainTextProtector());
    const connection = await store.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: directory,
    });
    await writeRuntimePresenceRecord(presencePath, activePresence());
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => mcpResponse(init));
    let connectedClient: Client | undefined;
    const remoteAvailabilityChanged = vi.fn(async (
      _active: boolean,
      _diagnostic?: string,
    ) => undefined);
    const lazy = createLazyMcpTools({
      connectionId: connection.id,
      userDataPath: directory,
      protector: plainTextProtector(),
      fetchImpl,
      runtimePresencePath: presencePath,
      remoteClientFactory: () => {
        connectedClient = new Client(
          { name: "test-agent-hub-bridge", version: "1.0.0" },
          { capabilities: {} },
        );
        return connectedClient;
      },
      onRemoteAvailabilityChanged: remoteAvailabilityChanged,
    });
    closers.push(() => lazy.close());

    await expect(lazy.listTools()).resolves.toMatchObject({ tools: [{ name: "context_query" }] });
    const firstClient = connectedClient;
    expect(firstClient).toBeDefined();
    firstClient?.onclose?.();

    await vi.waitFor(() => expect(remoteAvailabilityChanged).toHaveBeenCalledWith(
      false,
      expect.stringMatching(/closed unexpectedly/i),
    ));
    await expect(lazy.probeAvailability()).resolves.toBe(true);
    await vi.waitFor(() => expect(remoteAvailabilityChanged).toHaveBeenCalledWith(true, undefined));
    expect(fetchImpl.mock.calls.filter(([, init]) => methodOf(init) === "initialize")).toHaveLength(2);
  });

  it.each([401, 403])(
    "reports HTTP %i as a permanent credential failure and does not poll the room again",
    async (status) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-"));
      temporaryDirectories.push(directory);
      const presencePath = path.join(directory, "runtime-presence.json");
      const store = new ConnectionStore(path.join(directory, "connections.json"), plainTextProtector());
      const connection = await store.save({
        serverUrl: "http://agent-hub.test:4173",
        memberToken: "member-token",
        repositoryPath: directory,
      });
      await writeRuntimePresenceRecord(presencePath, activePresence());
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response("denied", {
        status,
        statusText: status === 401 ? "Unauthorized" : "Forbidden",
      }));
      const remoteAvailabilityChanged = vi.fn(async (
        _active: boolean,
        _diagnostic?: string,
      ) => undefined);
      const lazy = createLazyMcpTools({
        connectionId: connection.id,
        userDataPath: directory,
        protector: plainTextProtector(),
        fetchImpl,
        runtimePresencePath: presencePath,
        onRemoteAvailabilityChanged: remoteAvailabilityChanged,
      });
      closers.push(() => lazy.close());

      await expect(lazy.listTools()).rejects.toThrow(new RegExp(`HTTP ${status}`));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await expect(lazy.probeAvailability()).resolves.toBe(false);
      await expect(lazy.probeAvailability()).resolves.toBe(false);
      await expect(lazy.listTools()).rejects.toThrow(new RegExp(`HTTP ${status}`));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await expect(lazy.callTool({ name: "context_query", arguments: {} })).resolves.toMatchObject({
        isError: true,
        content: [{ text: expect.stringMatching(new RegExp(`HTTP ${status}`)) }],
      });
      expect(remoteAvailabilityChanged).toHaveBeenCalledWith(
        false,
        expect.stringMatching(new RegExp(`HTTP ${status}`)),
      );
    },
  );

  it.each([408, 429, 503])(
    "retries HTTP %i and announces recovery",
    async (status) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-"));
      temporaryDirectories.push(directory);
      const presencePath = path.join(directory, "runtime-presence.json");
      const store = new ConnectionStore(path.join(directory, "connections.json"), plainTextProtector());
      const connection = await store.save({
        serverUrl: "http://agent-hub.test:4173",
        memberToken: "member-token",
        repositoryPath: directory,
      });
      await writeRuntimePresenceRecord(presencePath, activePresence());
      let unavailable = true;
      const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
        if (unavailable && methodOf(init) === "initialize") {
          return new Response("temporarily unavailable", { status });
        }
        return mcpResponse(init);
      });
      const remoteAvailabilityChanged = vi.fn(async (
        _active: boolean,
        _diagnostic?: string,
      ) => undefined);
      const lazy = createLazyMcpTools({
        connectionId: connection.id,
        userDataPath: directory,
        protector: plainTextProtector(),
        fetchImpl,
        runtimePresencePath: presencePath,
        onRemoteAvailabilityChanged: remoteAvailabilityChanged,
      });
      closers.push(() => lazy.close());

      await expect(lazy.listTools()).resolves.toEqual({ tools: [] });
      expect(fetchImpl.mock.calls.filter(([, init]) => methodOf(init) === "initialize")).toHaveLength(1);
      unavailable = false;
      await expect(lazy.probeAvailability()).resolves.toBe(true);
      expect(fetchImpl.mock.calls.filter(([, init]) => methodOf(init) === "initialize")).toHaveLength(2);
      expect(remoteAvailabilityChanged).toHaveBeenCalledWith(
        false,
        expect.stringMatching(new RegExp(`HTTP ${status}`)),
      );
      expect(remoteAvailabilityChanged).toHaveBeenCalledWith(true, undefined);
    },
  );

  it("does not retry an asynchronous authentication error from a connected transport", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-"));
    temporaryDirectories.push(directory);
    const presencePath = path.join(directory, "runtime-presence.json");
    const store = new ConnectionStore(path.join(directory, "connections.json"), plainTextProtector());
    const connection = await store.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: directory,
    });
    await writeRuntimePresenceRecord(presencePath, activePresence());
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => mcpResponse(init));
    let connectedClient: Client | undefined;
    const lazy = createLazyMcpTools({
      connectionId: connection.id,
      userDataPath: directory,
      protector: plainTextProtector(),
      fetchImpl,
      runtimePresencePath: presencePath,
      remoteClientFactory: () => {
        connectedClient = new Client(
          { name: "test-agent-hub-bridge", version: "1.0.0" },
          { capabilities: {} },
        );
        return connectedClient;
      },
    });
    closers.push(() => lazy.close());

    await expect(lazy.listTools()).resolves.toMatchObject({ tools: [{ name: "context_query" }] });
    connectedClient?.onerror?.(new StreamableHTTPError(401, "token expired"));
    await expect(lazy.probeAvailability()).resolves.toBe(false);
    await expect(lazy.listTools()).rejects.toThrow(/authentication failed \(HTTP 401\)/i);
    expect(fetchImpl.mock.calls.filter(([, init]) => methodOf(init) === "initialize")).toHaveLength(1);
  });

  it("returns an MCP error for a call made while the integration is paused", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-"));
    temporaryDirectories.push(directory);
    const store = new ConnectionStore(path.join(directory, "connections.json"), plainTextProtector());
    const connection = await store.save({
      serverUrl: "http://agent-hub.test:4173",
      memberToken: "member-token",
      repositoryPath: directory,
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const lazy = createLazyMcpTools({
      connectionId: connection.id,
      userDataPath: directory,
      protector: plainTextProtector(),
      fetchImpl,
      runtimePresencePath: path.join(directory, "missing-presence.json"),
    });
    closers.push(() => lazy.close());

    await expect(lazy.callTool({ name: "context_query", arguments: {} })).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text" }],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function plainTextProtector(): SecretProtector {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => value.toString("utf8"),
  };
}

function activePresence(): RuntimePresenceRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    instanceId: "test-instance",
    pid: process.pid,
    status: "active",
    startedAt: now,
    heartbeatAt: now,
  };
}

function methodOf(init: RequestInit | undefined): string | undefined {
  if (!init?.body) return undefined;
  return (JSON.parse(String(init.body)) as { method?: string }).method;
}

function mcpResponse(init: RequestInit | undefined): Response {
  const body = init?.body ? JSON.parse(String(init.body)) as { id?: number; method?: string } : {};
  if (body.method === "initialize") {
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "test-room", version: "1.0.0" },
        instructions: "Room instructions",
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (body.method === "tools/list") {
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        tools: [{
          name: "context_query",
          description: "Read shared context",
          inputSchema: { type: "object", properties: {} },
        }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(null, { status: 202 });
}
