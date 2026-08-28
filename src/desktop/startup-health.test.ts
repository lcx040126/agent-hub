import { describe, expect, it, vi } from "vitest";
import { verifyStartupHealthAndMark } from "./startup-health.js";

const serviceHealth = {
  status: "ok",
  service: "agent-hub",
  version: "0.2.4",
  protocolVersion: 1,
  schemaVersion: 4,
  database: { status: "ok", schemaVersion: 4 },
};
const localIntegrationHealth = {
  status: "ok",
  version: "0.2.4",
  mcpBridge: "ok",
  codexHook: "ok",
};

describe("desktop startup health", () => {
  it("marks startup healthy only after UI, service/database, MCP, and Hook checks pass", async () => {
    const order: string[] = [];
    const fetchImpl = vi.fn(async () => {
      order.push("service");
      return jsonResponse(serviceHealth);
    }) as unknown as typeof fetch;

    await expect(verifyStartupHealthAndMark({
      ...baseOptions(),
      fetchImpl,
      loadRenderer: async () => { order.push("ui"); },
      runHeadlessProbe: async () => {
        order.push("local-integration");
        return localIntegrationHealth;
      },
      markHealthy: async () => { order.push("mark-healthy"); },
    })).resolves.toEqual({
      service: {
        status: "ok",
        version: "0.2.4",
        protocolVersion: 1,
        schemaVersion: 4,
        database: "ok",
      },
      localIntegration: localIntegrationHealth,
    });
    expect(order).toEqual(["ui", "service", "local-integration", "mark-healthy"]);
  });

  it("does not run later checks or mark healthy when the renderer fails", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const runHeadlessProbe = vi.fn();
    const markHealthy = vi.fn();

    await expect(verifyStartupHealthAndMark({
      ...baseOptions(),
      fetchImpl,
      loadRenderer: async () => { throw new Error("renderer failed"); },
      runHeadlessProbe,
      markHealthy,
    })).rejects.toThrow(/renderer failed/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(runHeadlessProbe).not.toHaveBeenCalled();
    expect(markHealthy).not.toHaveBeenCalled();
  });

  it("does not mark healthy when the database status is absent", async () => {
    const runHeadlessProbe = vi.fn();
    const markHealthy = vi.fn();

    await expect(verifyStartupHealthAndMark({
      ...baseOptions(),
      fetchImpl: (async () => jsonResponse({ ...serviceHealth, database: undefined })) as typeof fetch,
      loadRenderer: async () => undefined,
      runHeadlessProbe,
      markHealthy,
    })).rejects.toThrow(/database health/i);
    expect(runHeadlessProbe).not.toHaveBeenCalled();
    expect(markHealthy).not.toHaveBeenCalled();
  });

  it("does not mark healthy when the local MCP or Hook report is incomplete", async () => {
    const markHealthy = vi.fn();

    await expect(verifyStartupHealthAndMark({
      ...baseOptions(),
      fetchImpl: (async () => jsonResponse(serviceHealth)) as typeof fetch,
      loadRenderer: async () => undefined,
      runHeadlessProbe: async () => ({ ...localIntegrationHealth, codexHook: "failed" }),
      markHealthy,
    })).rejects.toThrow(/Hook health/i);
    expect(markHealthy).not.toHaveBeenCalled();
  });
});

function baseOptions() {
  return {
    localServerUrl: "http://127.0.0.1:4173",
    electronExecutable: "AgentHub.exe",
    headlessRunnerPath: "dist/companion/headless-runner.js",
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
