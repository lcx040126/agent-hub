import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentHubApp } from "./app.js";
import { AgentHubDatabase } from "./db.js";
import {
  evaluatePublicationGate,
  matchesSharedBranch,
  parsePublicationGateArguments,
  runPublicationGate,
} from "./publication-gate.js";
import { AgentHubService } from "./service.js";

const databases: AgentHubDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("publication gate", () => {
  it("selects the newest status for risks and verification scopes", () => {
    const evaluation = evaluatePublicationGate(
      {
        records: [
          {
            id: "risk-resolved",
            kind: "risk",
            title: "Save migration",
            summary: "Migration is complete.",
            paths: ["Assets/Save"],
            status: "resolved",
            createdAt: "2026-08-25T10:02:00.000Z",
          },
          {
            id: "risk-critical",
            kind: "risk",
            title: "Save migration",
            summary: "Old saves can be lost.",
            paths: ["Assets/Save"],
            status: "critical",
            createdAt: "2026-08-25T10:01:00.000Z",
          },
          {
            id: "validation-failed",
            kind: "validation",
            title: "Integration suite",
            summary: "One integration test failed.",
            paths: ["Assets/Combat"],
            status: "failed",
            createdAt: "2026-08-25T10:03:00.000Z",
          },
        ],
        conflicts: [
          {
            id: "conflict-1",
            severity: "critical",
            decision: "deny",
            title: "Scene is occupied",
            summary: "Raid.unity has an active exclusive lease.",
          },
        ],
      },
      {
        verifications: [
          {
            id: "verification-pass",
            leaseId: "lease-1",
            kind: "unity_play_mode",
            result: "passed",
            summary: "Play Mode passed after the fix.",
            createdAt: "2026-08-25T10:05:00.000Z",
          },
          {
            id: "verification-fail",
            leaseId: "lease-1",
            kind: "unity_play_mode",
            result: "failed",
            summary: "Play Mode failed before the fix.",
            createdAt: "2026-08-25T10:04:00.000Z",
          },
        ],
      },
    );

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.blockers.map((blocker) => blocker.kind).sort()).toEqual([
      "blocking_conflict",
      "failed_verification",
    ]);
    expect(evaluation.blockers.some((blocker) => blocker.kind === "critical_risk")).toBe(false);
    expect(evaluation.blockers.some((blocker) => blocker.id === "verification-fail")).toBe(false);
  });

  it("skips non-shared branches without contacting the room service", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const messages: string[] = [];
    const result = await runPublicationGate({
      branch: "feature/inventory",
      serviceUrl: "http://127.0.0.1:4173",
      memberToken: "secret",
      fetchImpl,
      log: (message) => messages.push(message),
    });

    expect(result).toMatchObject({ allowed: true, skipped: true, exitCode: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(messages.join("\n")).toContain("不是共享分支");
    expect(matchesSharedBranch("refs/heads/release/1.0", ["release/*"])).toBe(true);
  });

  it("defaults to failure when a shared branch cannot reach Agent Hub", async () => {
    const errors: string[] = [];
    const result = await runPublicationGate({
      branch: "develop",
      serviceUrl: "http://127.0.0.1:4173",
      memberToken: "secret",
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("connection refused")),
      error: (message) => errors.push(message),
    });

    expect(result).toMatchObject({ allowed: false, skipped: false, exitCode: 2 });
    expect(errors.join("\n")).toContain("默认拒绝策略");
    expect(errors.join("\n")).not.toContain("secret");
  });

  it("reads live room state and releases each blocker only after a resolving event", async () => {
    let currentTime = Date.parse("2026-08-25T12:00:00.000Z");
    const database = new AgentHubDatabase({ path: ":memory:" });
    databases.push(database);
    const service = new AgentHubService(database, { now: () => new Date(currentTime) });
    const owner = service.createRoom({
      name: "Vanguard team",
      projectName: "Project Vanguard",
      repository: "https://github.com/example/projectvanguard.git",
      defaultBranch: "develop",
      hostName: "Alice",
    });
    const member = service.joinRoom({ roomToken: owner.roomToken, displayName: "Bob" });
    const app = createAgentHubApp({ database, service });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    const serviceUrl = `http://127.0.0.1:${address.port}`;
    const check = () =>
      runPublicationGate({
        branch: "develop",
        serviceUrl,
        memberToken: owner.memberToken,
        log: () => undefined,
        error: () => undefined,
      });

    try {
      const exclusiveLease = service.claimLease({
        memberToken: owner.memberToken,
        title: "Raid scene",
        paths: ["Assets/Scenes/Raid.unity"],
        mode: "write",
      });
      expect(exclusiveLease.acquired).toBe(true);
      const denied = service.claimLease({
        memberToken: member.memberToken,
        title: "Raid spawn points",
        paths: ["Assets/Scenes/Raid.unity"],
        mode: "write",
        overrideReason: "Attempt an override",
      });
      expect(denied).toMatchObject({ acquired: false, decision: "deny" });
      expect((await check()).blockers).toMatchObject([{ kind: "blocking_conflict" }]);

      if (!exclusiveLease.acquired) throw new Error("Expected the owner lease to be acquired.");
      currentTime += 1_000;
      service.releaseLease({
        memberToken: owner.memberToken,
        leaseId: exclusiveLease.lease.id,
        status: "completed",
      });
      expect(await check()).toMatchObject({ allowed: true, exitCode: 0 });

      currentTime += 1_000;
      service.addVerification({
        memberToken: owner.memberToken,
        kind: "automated_test",
        result: "failed",
        summary: "Inventory regression failed.",
      });
      expect((await check()).blockers).toMatchObject([{ kind: "failed_verification" }]);

      currentTime += 1_000;
      service.addVerification({
        memberToken: owner.memberToken,
        kind: "automated_test",
        result: "passed",
        summary: "Inventory regression passed after the fix.",
      });
      expect(await check()).toMatchObject({ allowed: true, exitCode: 0 });

      currentTime += 1_000;
      service.addRecord({
        memberToken: owner.memberToken,
        kind: "risk",
        title: "Save migration",
        summary: "Existing saves may be damaged.",
        paths: ["Assets/Save"],
        status: "critical",
      });
      expect((await check()).blockers).toMatchObject([{ kind: "critical_risk" }]);

      currentTime += 1_000;
      service.addRecord({
        memberToken: owner.memberToken,
        kind: "risk",
        title: "Save migration",
        summary: "Migration and rollback tests passed.",
        paths: ["Assets/Save"],
        status: "resolved",
      });
      expect(await check()).toMatchObject({ allowed: true, exitCode: 0 });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("parses repeatable shared branch arguments without accepting unknown options", () => {
    expect(
      parsePublicationGateArguments([
        "--url=http://127.0.0.1:4173",
        "--branch",
        "develop",
        "--shared-branch",
        "main",
        "--shared-branch=release/*",
      ]),
    ).toMatchObject({
      serviceUrl: "http://127.0.0.1:4173",
      branch: "develop",
      sharedBranches: ["main", "release/*"],
    });
    expect(() => parsePublicationGateArguments(["--token", "do-not-accept-secrets"])).toThrow(
      "未知参数",
    );
  });
});
