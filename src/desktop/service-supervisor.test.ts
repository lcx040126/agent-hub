import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { ChildProcess, type spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createServiceSupervisor } from "./service-supervisor.js";

describe("service supervisor", () => {
  it("exposes a stable local service endpoint", () => {
    const supervisor = createServiceSupervisor({
      executable: process.execPath,
      scriptPath: "unused",
      port: 49123,
      dataDir: "data",
    });
    expect(supervisor.port).toBe(49123);
    expect(supervisor.url).toBe("http://127.0.0.1:49123");
  });

  it("restarts the same trusted packaged service entry", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-supervisor-"));
    const good = path.join(directory, "good.cjs");
    await writeFile(good, "require('node:http').createServer((_,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify({status:'ok'}));}).listen(Number(process.env.PORT),'0.0.0.0');");
    const supervisor = createServiceSupervisor({ executable: process.execPath, scriptPath: good, port: 49131, dataDir: directory, startupTimeoutMs: 3_000 });
    try {
      await supervisor.start();
      await supervisor.restart();
      await expect(fetch(`${supervisor.url}/api/health`)).resolves.toMatchObject({ status: 200 });
    } finally {
      await supervisor.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent stop and start requests in call order", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-supervisor-order-"));
    const script = path.join(directory, "service.cjs");
    await writeFile(script, "require('node:http').createServer((_,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify({status:'ok'}));}).listen(Number(process.env.PORT),'0.0.0.0');");
    const supervisor = createServiceSupervisor({
      executable: process.execPath,
      scriptPath: script,
      port: 49132,
      dataDir: directory,
      startupTimeoutMs: 3_000,
    });
    try {
      await supervisor.start();
      const stopping = supervisor.stop();
      const starting = supervisor.start();
      await Promise.all([stopping, starting]);

      await expect(fetch(`${supervisor.url}/api/health`)).resolves.toMatchObject({ status: 200 });
    } finally {
      await supervisor.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for a force-stopped child before starting and keeps the new child supervised", async () => {
    const children = [controlledChild(true), controlledChild(false)];
    const spawnImpl = vi.fn(() => children.shift()!) as unknown as typeof spawn;
    const supervisor = createServiceSupervisor({
      executable: process.execPath,
      scriptPath: "unused",
      port: 49133,
      dataDir: "data",
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })),
      startupTimeoutMs: 100,
      stopTimeoutMs: 20,
      spawnImpl,
    });

    await supervisor.start();
    const stopping = supervisor.stop();
    const starting = supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawnImpl).toHaveBeenCalledOnce();

    await Promise.all([stopping, starting]);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    await supervisor.start();
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });

  it("stops a child that fails health checks and creates a fresh child on the next start", async () => {
    const failedChild = controlledChild(false);
    const healthyChild = controlledChild(false);
    const children = [failedChild, healthyChild];
    let spawnCount = 0;
    const spawnImpl = vi.fn(() => {
      spawnCount += 1;
      return children.shift()!;
    }) as unknown as typeof spawn;
    const fetchImpl = vi.fn(async () => new Response(null, { status: spawnCount === 1 ? 503 : 200 }));
    const supervisor = createServiceSupervisor({
      executable: process.execPath,
      scriptPath: "unused",
      port: 49134,
      dataDir: "data",
      fetchImpl,
      startupTimeoutMs: 20,
      stopTimeoutMs: 20,
      spawnImpl,
    });

    await expect(supervisor.start()).rejects.toThrow("Agent Hub service failed health check: HTTP 503");
    expect(failedChild.kill).toHaveBeenCalledOnce();
    expect(failedChild.exitCode).toBe(0);

    await supervisor.start();
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    await supervisor.start();
    expect(spawnImpl).toHaveBeenCalledTimes(2);

    await supervisor.stop();
  });
});

function controlledChild(ignoreGracefulStop: boolean): ChildProcess {
  const child = new ChildProcess();
  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (ignoreGracefulStop && signal !== "SIGKILL") return true;
    const delayMs = signal === "SIGKILL" ? 5 : 0;
    setTimeout(() => {
      child.exitCode = 0;
      child.emit("exit", 0, signal ?? null);
    }, delayMs);
    return true;
  });
  return child;
}
