import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationOperationTracker } from "./integration-operations.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("integration operation tracker", () => {
  it("waits for an operation that registered before pause", async () => {
    const tracker = new IntegrationOperationTracker(await temporaryDirectory());
    const operation = await tracker.begin("connection-a");
    let drained = false;
    const drain = tracker.drain("connection-a", { pollIntervalMs: 5 })
      .then(() => { drained = true; });

    await vi.waitFor(() => expect(drained).toBe(false));
    await operation.end();
    await drain;
    expect(drained).toBe(true);
  });

  it("does not let one connection block another", async () => {
    const tracker = new IntegrationOperationTracker(await temporaryDirectory());
    const operation = await tracker.begin("connection-a");

    await expect(tracker.drain("connection-b", { pollIntervalMs: 5 })).resolves.toBeUndefined();
    await operation.end();
  });

  it("can retry end after a transient marker deletion failure", async () => {
    const root = await temporaryDirectory();
    const removeMarker = vi.fn(async (markerPath: string) => {
      if (removeMarker.mock.calls.length === 1) {
        throw new Error("transient delete failure");
      }
      await rm(markerPath, { force: true });
    });
    const tracker = new IntegrationOperationTracker(root, { removeMarker });
    const operation = await tracker.begin("connection-a");
    const markerPath = await findOnlyMarker(root);

    await expect(operation.end()).rejects.toThrow("transient delete failure");
    await expect(readFile(markerPath, "utf8")).resolves.toContain('"connectionId":"connection-a"');
    await expect(operation.end()).resolves.toBeUndefined();
    await expect(operation.end()).resolves.toBeUndefined();

    expect(removeMarker).toHaveBeenCalledTimes(2);
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries a transient marker deletion failure from run", async () => {
    const root = await temporaryDirectory();
    const removeMarker = vi.fn(async (markerPath: string) => {
      if (removeMarker.mock.calls.length === 1) throw new Error("transient delete failure");
      await rm(markerPath, { force: true });
    });
    const tracker = new IntegrationOperationTracker(root, { removeMarker });

    await expect(tracker.run("connection-a", async () => "done")).resolves.toBe("done");
    expect(removeMarker).toHaveBeenCalledTimes(2);
    await expect(tracker.drain("connection-a", { pollIntervalMs: 5 })).resolves.toBeUndefined();
  });

  it("removes markers owned by a dead process", async () => {
    const tracker = new IntegrationOperationTracker(await temporaryDirectory());
    const operation = await tracker.begin("connection-a");

    await expect(tracker.drain("connection-a", {
      pollIntervalMs: 5,
      isProcessAlive: () => false,
    })).resolves.toBeUndefined();
    await operation.end();
  });

  it("keeps an old marker while its owning process is still alive", async () => {
    const root = await temporaryDirectory();
    const tracker = new IntegrationOperationTracker(root);
    const operation = await tracker.begin("connection-a");
    const markerPath = await findOnlyMarker(root);
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    marker.startedAt = "2020-01-01T00:00:00.000Z";
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`, "utf8");

    const drain = tracker.drain("connection-a", {
      pollIntervalMs: 5,
      timeoutMs: 1_000,
      isProcessAlive: () => true,
    });
    let drained = false;
    void drain.then(() => { drained = true; });
    await vi.waitFor(() => expect(drained).toBe(false));

    await operation.end();
    await expect(drain).resolves.toBeUndefined();
  });

  it("fails with a bounded timeout when a live operation does not finish", async () => {
    const tracker = new IntegrationOperationTracker(await temporaryDirectory());
    const operation = await tracker.begin("connection-a");

    await expect(tracker.drain("connection-a", {
      pollIntervalMs: 5,
      timeoutMs: 20,
      isProcessAlive: () => true,
    })).rejects.toThrow("Timed out after 20 ms");

    await operation.end();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-operations-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function findOnlyMarker(root: string): Promise<string> {
  const operationRoot = path.join(root, "integration-operations");
  const connectionDirectories = await readdir(operationRoot);
  expect(connectionDirectories).toHaveLength(1);
  const directory = path.join(operationRoot, connectionDirectories[0]!);
  const markers = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  expect(markers).toHaveLength(1);
  return path.join(directory, markers[0]!);
}
