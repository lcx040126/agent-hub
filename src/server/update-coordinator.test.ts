import { describe, expect, it, vi } from "vitest";
import { UpdateCoordinator } from "./update-coordinator.js";

describe("retired room service updater", () => {
  it("never fetches or stages an external executable script", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const coordinator = new UpdateCoordinator({
      stagingDirectory: "unused",
      manifestUrl: "https://attacker.invalid/manifest.json",
      fetchImpl,
    });

    await expect(coordinator.check()).resolves.toMatchObject({ state: "retired" });
    await expect(coordinator.stage()).rejects.toThrow(/signed desktop updater/i);
    await expect(coordinator.backupDatabase()).rejects.toThrow(/signed desktop updater/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
