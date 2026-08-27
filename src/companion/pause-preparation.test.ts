import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PausePreparationQueue } from "./pause-preparation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("pause preparation queue", () => {
  it("saturates retry attempts at the persisted maximum", async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, "pause-preparation.json");
    const queue = new PausePreparationQueue({
      filePath,
      now: () => new Date("2026-08-27T00:00:00.000Z"),
    });
    await queue.enqueue({
      connectionId: "connection-a",
      reason: "app-shutdown",
      requestId: "preparation-saturated",
    });
    const document = JSON.parse(await readFile(filePath, "utf8")) as { requests: Array<Record<string, unknown>> };
    document.requests[0]!.attempts = 1_000;
    await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

    await queue.defer("preparation-saturated", new Error("Try again."));

    await expect(queue.list()).resolves.toMatchObject([{
      requestId: "preparation-saturated",
      attempts: 1_000,
      lastError: "Try again.",
    }]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-pause-preparation-"));
  temporaryDirectories.push(directory);
  return directory;
}
