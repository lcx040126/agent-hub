import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

  it("restores the previous script when a replacement fails health checks", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-supervisor-"));
    const good = path.join(directory, "good.cjs");
    const bad = path.join(directory, "bad.cjs");
    await writeFile(good, "require('node:http').createServer((_,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify({status:'ok'}));}).listen(Number(process.env.PORT),'0.0.0.0');");
    await writeFile(bad, "process.exit(1);");
    const supervisor = createServiceSupervisor({ executable: process.execPath, scriptPath: good, port: 49131, dataDir: directory, startupTimeoutMs: 3_000 });
    try {
      await supervisor.start();
      await expect(supervisor.restartWithScript(bad)).rejects.toThrow();
      await expect(fetch(`${supervisor.url}/api/health`)).resolves.toMatchObject({ status: 200 });
    } finally {
      await supervisor.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
