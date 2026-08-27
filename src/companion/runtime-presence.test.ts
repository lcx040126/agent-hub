import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRuntimePresence,
  startRuntimePresence,
  writeRuntimePresenceRecord,
  type RuntimePresenceRecord,
} from "./runtime-presence.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("runtime presence sentinel", () => {
  it("recognizes a live, recent instance", async () => {
    const filePath = await presencePath();
    const now = new Date("2026-08-27T00:00:10.000Z");
    await writeRuntimePresenceRecord(filePath, record({ heartbeatAt: "2026-08-27T00:00:00.000Z" }));

    await expect(readRuntimePresence(filePath, {
      now,
      expectedInstanceId: "instance-a",
      isProcessAlive: () => true,
    })).resolves.toMatchObject({
      active: true,
      status: "active",
      ageMs: 10_000,
    });
  });

  it("treats an old heartbeat as inactive", async () => {
    const filePath = await presencePath();
    await writeRuntimePresenceRecord(filePath, record({ heartbeatAt: "2026-08-26T23:59:00.000Z" }));

    await expect(readRuntimePresence(filePath, {
      now: new Date("2026-08-27T00:00:00.001Z"),
      isProcessAlive: () => true,
    })).resolves.toMatchObject({
      active: false,
      status: "stale",
      ageMs: 60_001,
    });
  });

  it("reports malformed sentinel data without throwing", async () => {
    const filePath = await presencePath();
    await writeFile(filePath, "{not-json", "utf8");

    await expect(readRuntimePresence(filePath)).resolves.toMatchObject({
      active: false,
      status: "malformed",
    });
  });

  it("treats a dead owner PID as inactive", async () => {
    const filePath = await presencePath();
    await writeRuntimePresenceRecord(filePath, record());

    await expect(readRuntimePresence(filePath, {
      isProcessAlive: () => false,
    })).resolves.toMatchObject({
      active: false,
      status: "dead-pid",
    });
  });

  it("does not accept a sentinel owned by another instance", async () => {
    const filePath = await presencePath();
    await writeRuntimePresenceRecord(filePath, record({ instanceId: "instance-b" }));

    await expect(readRuntimePresence(filePath, {
      expectedInstanceId: "instance-a",
      isProcessAlive: () => true,
    })).resolves.toMatchObject({
      active: false,
      status: "instance-mismatch",
    });
  });

  it("treats maintenance mode as intentionally inactive", async () => {
    const filePath = await presencePath();
    await writeRuntimePresenceRecord(filePath, record({ status: "maintenance" }));

    await expect(readRuntimePresence(filePath, {
      isProcessAlive: () => true,
    })).resolves.toMatchObject({
      active: false,
      status: "maintenance",
    });
  });

  it("refuses to overwrite another live instance with a fresh heartbeat", async () => {
    const filePath = await presencePath();
    await writeRuntimePresenceRecord(filePath, record({
      instanceId: "existing-instance",
      pid: 4321,
      heartbeatAt: "2026-08-27T00:00:09.000Z",
    }));

    await expect(startRuntimePresence(filePath, {
      instanceId: "new-instance",
      pid: 5678,
      heartbeatIntervalMs: 0,
      now: () => new Date("2026-08-27T00:00:10.000Z"),
      isProcessAlive: () => true,
    })).rejects.toThrow(/already owned by active instance existing-instance/i);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      instanceId: "existing-instance",
      pid: 4321,
      status: "active",
    });
  });

  it.each([
    ["stale", record({ heartbeatAt: "2026-08-26T23:58:00.000Z" }), () => true],
    ["dead", record({ heartbeatAt: "2026-08-27T00:00:09.000Z" }), () => false],
    ["stopped", record({ status: "stopped", heartbeatAt: "2026-08-27T00:00:09.000Z" }), () => true],
    ["maintenance", record({ status: "maintenance", heartbeatAt: "2026-08-27T00:00:09.000Z" }), () => true],
  ] as const)("takes over a %s previous presence", async (_label, previous, isProcessAlive) => {
    const filePath = await presencePath();
    await writeRuntimePresenceRecord(filePath, previous);

    const handle = await startRuntimePresence(filePath, {
      instanceId: "new-instance",
      pid: 5678,
      heartbeatIntervalMs: 0,
      now: () => new Date("2026-08-27T00:00:10.000Z"),
      isProcessAlive,
    });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      instanceId: "new-instance",
      pid: 5678,
      status: "active",
    });
    await handle.stop();
  });

  it("takes over a malformed previous presence", async () => {
    const filePath = await presencePath();
    await writeFile(filePath, "{not-json", "utf8");

    const handle = await startRuntimePresence(filePath, {
      instanceId: "new-instance",
      pid: 5678,
      heartbeatIntervalMs: 0,
      now: () => new Date("2026-08-27T00:00:10.000Z"),
      isProcessAlive: () => true,
    });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      instanceId: "new-instance",
      status: "active",
    });
    await handle.stop();
  });

  it("updates and stops only its own instance", async () => {
    const filePath = await presencePath();
    let current = new Date("2026-08-27T00:00:00.000Z");
    const handle = await startRuntimePresence(filePath, {
      instanceId: "instance-a",
      pid: 1234,
      heartbeatIntervalMs: 0,
      now: () => current,
    });
    expect(handle.record.status).toBe("active");

    current = new Date("2026-08-27T00:00:01.000Z");
    await handle.heartbeat();
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      instanceId: "instance-a",
      status: "active",
      heartbeatAt: "2026-08-27T00:00:01.000Z",
    });

    await handle.stop();
    await expect(readRuntimePresence(filePath, {
      expectedInstanceId: "instance-a",
      isProcessAlive: () => true,
    })).resolves.toMatchObject({ active: false, status: "stopped" });
    await handle.stop();
  });
});

function record(overrides: Partial<RuntimePresenceRecord> = {}): RuntimePresenceRecord {
  return {
    version: 1,
    instanceId: "instance-a",
    pid: 1234,
    status: "active",
    startedAt: "2026-08-27T00:00:00.000Z",
    heartbeatAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

async function presencePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-presence-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "runtime-presence.json");
}
