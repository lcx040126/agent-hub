import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentHubApp } from "./app.js";
import { AgentHubDatabase } from "./db.js";
import { AgentHubService } from "./service.js";

const databases: AgentHubDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Agent Hub REST API", () => {
  it("supports owner transfer, administrator management, room settings, and removal", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");
    const carol = await joinRoom(app, owner.body.inviteCode, "Carol");
    const granted = await auth(request(app).post(`/api/room/members/${bob.body.member.id}/role`).send({ isAdmin: true }), owner.body.token);
    expect(granted.status).toBe(200);
    const settings = await auth(request(app).post("/api/room/settings").send({ autoLockAfterAutoClaim: false }), bob.body.token);
    expect(settings.status).toBe(200);
    const transferred = await auth(request(app).post("/api/room/transfer").send({ targetMemberId: bob.body.member.id }), owner.body.token);
    expect(transferred.status).toBe(200);
    const denied = await auth(request(app).post(`/api/room/members/${carol.body.member.id}/role`).send({ isAdmin: true }), bob.body.token);
    expect(denied.status).toBe(200);
    const removed = await auth(request(app).post(`/api/room/members/${carol.body.member.id}/remove`).send({}), bob.body.token);
    expect(removed.status).toBe(204);
    const kicked = await auth(request(app).get("/api/dashboard"), carol.body.token);
    expect(kicked.status).toBe(401);
  });

  it("locks automatic overlapping ranges when the room setting is enabled", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");
    await createLease(app, owner.body.token, { title: "Source work", paths: ["src/shared.ts"] });
    const denied = await auth(request(app).post("/api/leases").send({ title: "Automatic work", paths: ["src/shared.ts"], mode: "write", branch: "main", autoClaim: true }), bob.body.token);
    expect(denied.body).toMatchObject({ acquired: false, decision: "deny" });
    await auth(request(app).post("/api/room/settings").send({ autoLockAfterAutoClaim: false }), owner.body.token);
    const warning = await auth(request(app).post("/api/leases").send({ title: "Automatic work", paths: ["src/shared.ts"], mode: "write", branch: "main", autoClaim: true }), bob.body.token);
    expect(warning.body).toMatchObject({ acquired: false, decision: "warn" });
  });

  it("freezes a session and cancels its leases when the branch changes", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const session = await auth(request(app).post("/api/sessions").send({ branch: "feature/a", baseCommit: "aaaa1111" }), owner.body.token);
    const lease = await auth(request(app).post("/api/leases").send({ title: "Work", paths: ["src/a.ts"], branch: "feature/a", baseCommit: "aaaa1111", sessionId: session.body.session.id }), owner.body.token);
    expect(lease.body.acquired).toBe(true);
    const changed = await auth(request(app).post(`/api/sessions/${session.body.session.id}/sync`).send({ branch: "feature/b", baseCommit: "bbbb2222" }), owner.body.token);
    expect(changed.status).toBe(409);
    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases).toHaveLength(0);
    expect(dashboard.body.sessions[0].status).toBe("frozen");
  });
  it("creates a room, stores only a token hash, joins a member, and protects the dashboard", async () => {
    const { app, database } = testApp();
    const created = await createRoom(app);

    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^ahm_/);
    expect(created.body.room.code).toBe(created.body.inviteCode);
    expect(created.body.room.projectName).toBe("Project Vanguard");

    const tokenRow = database.connection
      .prepare("SELECT token_hash FROM members WHERE id = ?")
      .get(created.body.member.id) as { token_hash: string };
    expect(tokenRow.token_hash).not.toBe(created.body.token);
    expect(tokenRow.token_hash).toMatch(/^[a-f0-9]{64}$/);

    const joined = await request(app).post("/api/rooms/join").send({
      inviteCode: created.body.inviteCode.toLowerCase(),
      memberName: "Bob",
      clientName: "Codex",
    });
    expect(joined.status).toBe(201);
    expect(joined.body.member).toMatchObject({ name: "Bob", role: "member" });

    const unauthorized = await request(app).get("/api/dashboard");
    expect(unauthorized.status).toBe(401);

    const dashboard = await auth(request(app).get("/api/dashboard"), joined.body.token);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.members.map((member: { name: string }) => member.name)).toEqual([
      "Alice",
      "Bob",
    ]);
    expect(dashboard.body.server.mcpUrl).toMatch(/\/mcp$/);
  });

  it("requires an override for ordinary source overlap and denies exclusive project resources", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const joined = await joinRoom(app, owner.body.inviteCode, "Bob");

    const first = await createLease(app, owner.body.token, {
      title: "Inventory transaction",
      paths: ["Assets/Vanguard/Inventory/InventoryService.cs"],
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ acquired: true, decision: "allow" });

    const warning = await createLease(app, joined.body.token, {
      title: "Equipment integration",
      paths: ["Assets/Vanguard/Inventory"],
    });
    expect(warning.status).toBe(200);
    expect(warning.body).toMatchObject({ acquired: false, decision: "warn" });
    expect(warning.body.conflicts[0]).toMatchObject({
      severity: "warning",
      requestedPath: "Assets/Vanguard/Inventory",
      memberName: "Alice",
    });

    const overridden = await createLease(app, joined.body.token, {
      title: "Equipment integration",
      paths: ["Assets/Vanguard/Inventory"],
      overrideReason: "The changes are limited to a new adapter and both agents will run integration tests.",
    });
    expect(overridden.status).toBe(201);
    expect(overridden.body).toMatchObject({ acquired: true, decision: "warn" });

    const sceneLease = await createLease(app, owner.body.token, {
      title: "Raid scene setup",
      paths: ["Assets/Scenes/Raid.unity"],
    });
    expect(sceneLease.body.acquired).toBe(true);

    const deniedScene = await createLease(app, joined.body.token, {
      title: "Spawn point setup",
      paths: ["Assets/Scenes/Raid.unity"],
      overrideReason: "Try to force access",
    });
    expect(deniedScene.status).toBe(200);
    expect(deniedScene.body).toMatchObject({ acquired: false, decision: "deny" });
    expect(deniedScene.body.conflicts[0]).toMatchObject({ severity: "critical", decision: "deny" });

    const configLease = await createLease(app, owner.body.token, {
      title: "Luban weapon table",
      paths: ["Config/Luban/Weapon.xlsx"],
    });
    expect(configLease.body.acquired).toBe(true);
    const deniedConfig = await createLease(app, joined.body.token, {
      title: "Weapon balancing",
      paths: ["Config/Luban"],
      overrideReason: "Coordinate after editing",
    });
    expect(deniedConfig.body.decision).toBe("deny");
  });

  it("renews and expires leases, then records validation, risks, and handoff on close", async () => {
    let currentTime = Date.parse("2026-08-25T10:00:00.000Z");
    const { app } = testApp(() => new Date(currentTime));
    const owner = await createRoom(app);
    const lease = await createLease(app, owner.body.token, {
      title: "Weapon durability",
      paths: ["Assets/Vanguard/Combat/WeaponDurability.cs"],
      ttlMinutes: 1,
    });

    currentTime += 50_000;
    const renewed = await auth(
      request(app)
        .post(`/api/leases/${lease.body.lease.id}/renew`)
        .send({ ttlMinutes: 2 }),
      owner.body.token,
    );
    expect(renewed.status).toBe(200);

    currentTime += 20_000;
    let dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases).toHaveLength(1);

    const closed = await auth(
      request(app)
        .post(`/api/leases/${lease.body.lease.id}/close`)
        .send({
          outcome: "Durability is integrated without changing existing fire behavior.",
          changedPaths: ["Assets/Vanguard/Combat/WeaponDurability.cs"],
          commitHash: "abc1234",
          validations: ["EditMode durability tests passed"],
          remainingRisks: ["Unity Play Mode verification remains"],
          handoff: "Combat owner should verify zero-durability behavior.",
        }),
      owner.body.token,
    );
    expect(closed.status).toBe(200);
    expect(closed.body.lease.status).toBe("completed");
    expect(closed.body.records.map((record: { kind: string }) => record.kind).sort()).toEqual([
      "handoff",
      "risk",
      "validation",
    ]);

    dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases).toHaveLength(0);
    expect(dashboard.body.records).toHaveLength(3);

    const expiring = await createLease(app, owner.body.token, {
      title: "Temporary work",
      paths: ["Assets/Vanguard/UI/Hud.cs"],
      ttlMinutes: 1,
    });
    expect(expiring.body.acquired).toBe(true);
    currentTime += 61_000;
    dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases).toHaveLength(0);
    expect(dashboard.body.activity.some((item: { type: string }) => item.type === "lease.expired")).toBe(true);
  });

  it("stores structured context, decisions, verification, handoffs, sessions, and local scan metadata", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const token = owner.body.token;

    const session = await auth(
      request(app).post("/api/sessions").send({
        clientName: "Agent Hub desktop",
        agentName: "Codex",
        repository: "https://github.com/example/projectvanguard.git",
        branch: "feature/durability",
        baseCommit: "deadbeef",
        worktree: "D:/UGit/projectvanguard",
        task: "Add weapon durability",
        metadata: { processId: 42 },
      }),
      token,
    );
    expect(session.status).toBe(201);

    const scan = await auth(
      request(app).post(`/api/sessions/${session.body.session.id}/scan`).send({
        changedPaths: ["Assets/Vanguard/Combat/WeaponDurability.cs"],
        ruleFiles: ["ProjectRules/AGENTS.md"],
        systems: ["combat", "inventory"],
        metadata: { dirty: true },
      }),
      token,
    );
    expect(scan.body.scan).toMatchObject({ systems: ["combat", "inventory"] });

    const context = await auth(
      request(app).post("/api/context").send({
        kind: "architecture",
        title: "Weapon durability boundary",
        content: "Firing depends on durability but inventory owns persistence.",
        paths: ["Assets/Vanguard/Combat"],
      }),
      token,
    );
    expect(context.status).toBe(201);

    const decision = await auth(
      request(app).post("/api/decisions").send({
        title: "Keep fire interface compatible",
        decision: "Add a durability gate without changing the fire method signature.",
        rationale: "Existing AI and player weapons share the interface.",
        paths: ["Assets/Vanguard/Combat"],
      }),
      token,
    );
    expect(decision.status).toBe(201);

    const verification = await auth(
      request(app).post("/api/verifications").send({
        kind: "automated_test",
        result: "passed",
        summary: "Durability unit tests passed.",
        command: "pnpm test",
      }),
      token,
    );
    expect(verification.status).toBe(201);

    const handoff = await auth(
      request(app).post("/api/handoffs").send({
        summary: "Runtime verification remains.",
        completed: ["Static tests"],
        remaining: ["Unity Play Mode"],
        risks: ["Animation timing"],
      }),
      token,
    );
    expect(handoff.status).toBe(201);

    const relevant = await auth(
      request(app).get("/api/context").query({ paths: "Assets/Vanguard/Combat/Weapon.cs" }),
      token,
    );
    expect(relevant.body.contextEntries).toHaveLength(1);
    expect(relevant.body.decisions).toHaveLength(1);
    expect(relevant.body.verifications).toHaveLength(1);
    expect(relevant.body.handoffs).toHaveLength(1);

    const closed = await auth(
      request(app).post(`/api/sessions/${session.body.session.id}/close`).send({
        summary: "Agent task ended.",
      }),
      token,
    );
    expect(closed.body.session.status).toBe("closed");
  });

  it("reopens the SQLite database without losing rooms, membership, or records", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "hub.sqlite");
    const firstDatabase = new AgentHubDatabase({ path });
    databases.push(firstDatabase);
    const firstApp = createAgentHubApp({ database: firstDatabase });
    const owner = await createRoom(firstApp);
    await auth(
      request(firstApp).post("/api/records").send({
        kind: "risk",
        title: "Runtime gap",
        summary: "Unity Play Mode has not run.",
        paths: ["Assets/Vanguard/Combat"],
      }),
      owner.body.token,
    );
    firstDatabase.close();
    databases.splice(databases.indexOf(firstDatabase), 1);

    const secondDatabase = new AgentHubDatabase({ path });
    databases.push(secondDatabase);
    const secondApp = createAgentHubApp({ database: secondDatabase });
    const dashboard = await auth(request(secondApp).get("/api/dashboard"), owner.body.token);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.room.projectName).toBe("Project Vanguard");
    expect(dashboard.body.records).toMatchObject([
      { kind: "risk", title: "Runtime gap", status: "open" },
    ]);
  });
});

function testApp(now?: () => Date) {
  const database = new AgentHubDatabase({ path: ":memory:" });
  databases.push(database);
  const service = new AgentHubService(database, { now });
  return { app: createAgentHubApp({ database, service }), database };
}

function createRoom(app: ReturnType<typeof createAgentHubApp>) {
  return request(app).post("/api/rooms").send({
    roomName: "Vanguard team",
    projectName: "Project Vanguard",
    repository: "https://github.com/example/projectvanguard.git",
    defaultBranch: "develop",
    ownerName: "Alice",
  });
}

function joinRoom(app: ReturnType<typeof createAgentHubApp>, inviteCode: string, memberName: string) {
  return request(app).post("/api/rooms/join").send({ inviteCode, memberName });
}

function createLease(
  app: ReturnType<typeof createAgentHubApp>,
  token: string,
  input: {
    title: string;
    paths: string[];
    overrideReason?: string;
    ttlMinutes?: number;
  },
) {
  return auth(
    request(app)
      .post("/api/leases")
      .send({
        intent: input.title,
        branch: "feature/test",
        mode: "write",
        ttlMinutes: input.ttlMinutes ?? 30,
        ...input,
      }),
    token,
  );
}

function auth<T extends request.Test>(test: T, token: string): T {
  return test.set("Authorization", `Bearer ${token}`) as T;
}
