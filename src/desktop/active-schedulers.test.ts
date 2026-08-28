import { describe, expect, it, vi } from "vitest";
import { ensureActiveSchedulerSlots, type ActiveSchedulerSlots } from "./active-schedulers.js";

describe("active desktop schedulers", () => {
  it("starts all schedulers after a paused startup and never creates duplicates", () => {
    const scanner = { kind: "scanner" };
    const heartbeat = { kind: "heartbeat" };
    const releaseNotifier = { kind: "release-notifier" };
    const startScanner = vi.fn(() => scanner);
    const startHeartbeat = vi.fn(() => heartbeat);
    const startReleaseNotifier = vi.fn(() => releaseNotifier);
    let active = false;
    let current: ActiveSchedulerSlots<typeof scanner, typeof heartbeat, typeof releaseNotifier> = {
      scanner: null,
      heartbeat: null,
      releaseNotifier: null,
    };
    const ensure = () => {
      current = ensureActiveSchedulerSlots({
        active,
        current,
        startScanner,
        startHeartbeat,
        startReleaseNotifier,
      });
    };

    ensure();
    expect(startScanner).not.toHaveBeenCalled();
    expect(startHeartbeat).not.toHaveBeenCalled();
    expect(startReleaseNotifier).not.toHaveBeenCalled();

    active = true;
    ensure();
    ensure();

    expect(current).toEqual({ scanner, heartbeat, releaseNotifier });
    expect(startScanner).toHaveBeenCalledTimes(1);
    expect(startHeartbeat).toHaveBeenCalledTimes(1);
    expect(startReleaseNotifier).toHaveBeenCalledTimes(1);
  });

  it("retains each started scheduler when a later starter fails", () => {
    const scanner = { kind: "scanner" };
    const current: ActiveSchedulerSlots<typeof scanner, { kind: string }, { kind: string }> = {
      scanner: null,
      heartbeat: null,
      releaseNotifier: null,
    };
    const startScanner = vi.fn(() => scanner);
    const startHeartbeat = vi.fn(() => {
      throw new Error("heartbeat failed to start");
    });

    expect(() => ensureActiveSchedulerSlots({
      active: true,
      current,
      startScanner,
      startHeartbeat,
      startReleaseNotifier: vi.fn(() => ({ kind: "release-notifier" })),
    })).toThrow("heartbeat failed to start");

    expect(current.scanner).toBe(scanner);
    expect(startScanner).toHaveBeenCalledTimes(1);
  });
});
