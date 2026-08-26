import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentHubApp } from "../server/app.js";
import { AgentHubDatabase } from "../server/db.js";
import { FeatureMemoryStore } from "../server/feature-memory.js";
import { AgentHubService } from "../server/service.js";
import { ConnectionStore, type SecretProtector } from "../desktop/connection-store.js";
import { handleCodexHook, type CodexHookInput, type RunCodexHookOptions } from "./codex-hook.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const databases: AgentHubDatabase[] = [];

const protector: SecretProtector = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
  decryptString: (value) => {
    const text = value.toString("utf8");
    if (!text.startsWith("protected:")) throw new Error("Invalid test ciphertext.");
    return text.slice("protected:".length);
  },
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("Codex hook integration", () => {
  it("does not affect repositories that have not joined a room", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-unconnected-"));
    temporaryDirectories.push(root);
    await expect(handleCodexHook({
      eventName: "PreToolUse",
      userDataPath: path.join(root, "user-data"),
      protector,
    }, {
      session_id: "unconnected-session",
      cwd: root,
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Add File: local.txt\n*** End Patch" },
    })).resolves.toBeUndefined();
  });

  it("opens shared context, attributes Agent writes, ignores external changes, and blocks another member's Unity scope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-hub-hook-flow-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    const userDataPath = path.join(root, "user-data");
    await createRepository(repository);

    const database = new AgentHubDatabase({ path: path.join(root, "agent-hub.sqlite") });
    databases.push(database);
    const service = new AgentHubService(database);
    const room = service.createRoom({
      name: "Hook integration room",
      projectName: "Hook project",
      repository: "https://example.test/team/project.git",
      defaultBranch: "main",
      hostName: "Alice",
      hostAgent: "Codex",
    });
    const app = createAgentHubApp({ database, service });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const store = new ConnectionStore(path.join(userDataPath, "connections.json"), protector);
    await store.save({
      serverUrl: `http://127.0.0.1:${port}`,
      memberToken: room.memberToken,
      repositoryPath: repository,
      roomId: room.room.id,
      roomName: room.room.name,
      memberName: room.member.displayName,
    });

    const options = (eventName: RunCodexHookOptions["eventName"]): RunCodexHookOptions => ({
      eventName,
      userDataPath,
      protector,
    });
    const input = (
      eventName: CodexHookInput["hook_event_name"],
      extra: Partial<CodexHookInput> = {},
    ): CodexHookInput => ({
      session_id: "codex-session-a",
      cwd: repository,
      hook_event_name: eventName,
      ...extra,
    });

    await writeFile(path.join(repository, "src", "value.ts"), "export const value = 10;\n", "utf8");
    const sessionStart = await handleCodexHook(
      options("SessionStart"),
      input("SessionStart", { source: "startup" }),
    );
    expect(sessionStart).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
      },
    });
    expect(JSON.stringify(sessionStart)).toContain("Hook integration room");
    const hookSession = service.getDashboard(room.memberToken).sessions.find(
      (session) => session.agentName === "Codex" && session.status === "active",
    );
    expect(hookSession).toBeDefined();
    expect(JSON.stringify(sessionStart)).toContain(`sessionId=${hookSession?.id}`);

    const oversizedPatch = [
      "*** Begin Patch",
      ...Array.from({ length: 101 }, (_, index) => `*** Add File: src/bulk-${index}.ts`),
      "*** End Patch",
    ].join("\n");
    const oversizedWrite = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: oversizedPatch },
      }),
    );
    expect(oversizedWrite).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(JSON.stringify(oversizedWrite)).toContain("单次最多协调 100 个明确写入路径");

    const baselineCommit = (await outputGit(repository, ["rev-parse", "HEAD"])).trim();
    const memorySession = service.openSession({
      memberToken: room.memberToken,
      agentName: "Codex memory fixture",
      repository: room.room.repository,
      branch: "main",
      baseCommit: baselineCommit,
      task: "Record pre-existing protected behavior",
    });
    const featureStore = new FeatureMemoryStore(database);
    const featureActor = {
      roomId: room.room.id,
      memberId: room.member.id,
      memberName: room.member.displayName,
      defaultBranch: room.room.defaultBranch,
    };
    const protectedRevision = featureStore.submitRevision(featureActor, {
      ...memorySession,
      promotionEvidenceVerified: true,
    }, {
      memberToken: room.memberToken,
      sessionId: memorySession.id,
      featureKey: "protected-behavior",
      name: "Protected behavior",
      systemId: "protected",
      relation: "add",
      objective: "Keep the established protected behavior.",
      changeSummary: "Initial verified behavior.",
      contractChanges: [{
        operation: "add",
        key: "protected.behavior",
        behavior: "The protected behavior remains compatible.",
      }],
      targets: [{ kind: "path", path: "src/protected.ts", role: "implementation" }],
      finalCommit: baselineCommit,
      completed: true,
      verifications: [{
        testKey: "protected-regression",
        result: "passed",
        summary: "Protected behavior regression passed.",
      }],
    });
    expect(protectedRevision.status).toBe("current");
    const symbolRevision = featureStore.submitRevision(featureActor, {
      ...memorySession,
      promotionEvidenceVerified: true,
    }, {
      memberToken: room.memberToken,
      sessionId: memorySession.id,
      featureKey: "foo-bar-behavior",
      name: "Foo bar behavior",
      systemId: "foo",
      relation: "add",
      objective: "Keep Foo.bar compatible while allowing unrelated Foo members.",
      changeSummary: "Recorded the verified Foo.bar behavior.",
      contractChanges: [{
        operation: "add",
        key: "foo.bar.behavior",
        behavior: "Foo.bar returns its established value.",
      }],
      targets: [{ kind: "symbol", path: "src/foo.ts", symbol: "Foo.bar", role: "contract" }],
      finalCommit: baselineCommit,
      completed: true,
      verifications: [{
        testKey: "foo-bar-regression",
        result: "passed",
        summary: "Foo.bar regression passed.",
      }],
    });
    expect(symbolRevision.status).toBe("current");

    const addBazCommand = [
      "*** Begin Patch",
      "*** Update File: src/foo.ts",
      "@@",
      " export class Foo {",
      "+  baz() { return 2; }",
      " }",
      "*** End Patch",
    ].join("\n");
    const addBaz = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: addBazCommand },
      }),
    );
    expect(addBaz).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });

    const updateBarCommand = [
      "*** Begin Patch",
      "*** Update File: src/foo.ts",
      "@@",
      " export class Foo {",
      "-  bar() { return 1; }",
      "+  bar() { return 2; }",
      " }",
      "*** End Patch",
    ].join("\n");
    const updateBar = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: updateBarCommand },
      }),
    );
    expect(updateBar).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(JSON.stringify(updateBar)).toContain("Foo.bar");

    const resumedSession = await handleCodexHook(
      options("SessionStart"),
      input("SessionStart", { source: "resume" }),
    );
    expect(JSON.stringify(resumedSession)).toContain("长期功能记忆：Protected behavior [protected]");
    expect(JSON.stringify(resumedSession)).toContain("The protected behavior remains compatible.");
    const protectedCommand = [
      "*** Begin Patch",
      "*** Update File: src/protected.ts",
      "@@",
      "-export function protectedBehavior() { return 1; }",
      "+export function protectedBehavior() { return 2; }",
      "*** End Patch",
    ].join("\n");
    const protectedBlock = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: protectedCommand },
      }),
    );
    expect(protectedBlock).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    const confirmationId = JSON.stringify(protectedBlock).match(/confirmationId=([0-9a-f-]{36})/i)?.[1];
    expect(confirmationId).toBeTruthy();
    expect(JSON.stringify(protectedBlock)).toContain(`sessionId=${hookSession?.id}`);

    service.resolveFeatureConfirmation({
      memberToken: room.memberToken,
      sessionId: hookSession!.id,
      confirmationId: confirmationId!,
      decision: "approved",
      reason: "The current member explicitly approved this scoped change.",
    });
    const protectedRetry = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: protectedCommand },
      }),
    );
    expect(protectedRetry).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });

    const preEdit = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Update File: src/value.ts\n*** End Patch" },
      }),
    );
    expect(
      (preEdit?.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision,
      JSON.stringify(preEdit),
    ).toBe("allow");
    expect(preEdit).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
    expect(service.getDashboard(room.memberToken).leases).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "active" })]),
    );

    await writeFile(path.join(repository, "src", "value.ts"), "export const value = 2;\n", "utf8");
    const postEdit = await handleCodexHook(
      options("PostToolUse"),
      input("PostToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Update File: src/value.ts\n*** End Patch" },
      }),
    );
    expect(postEdit).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
      },
    });
    expect(JSON.stringify(postEdit)).toContain("src/value.ts");

    const bob = service.joinRoom({
      roomToken: room.roomToken,
      displayName: "Bob",
      agent: "Codex",
    });
    const bobLease = service.claimLease({
      memberToken: bob.memberToken,
      title: "Edit the main scene",
      paths: ["Assets/Scenes/Main.unity"],
      mode: "write",
    });
    expect(bobLease.acquired).toBe(true);

    const blocked = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Update File: Assets/Scenes/Main.unity\n*** End Patch" },
      }),
    );
    expect(blocked).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
    expect(JSON.stringify(blocked)).toContain("Bob");

    const preGenerator = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: src/generated.ts\n*** End Patch" },
      }),
    );
    expect(preGenerator).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
    await writeFile(path.join(repository, "src", "generated.ts"), "export const generated = true;\n", "utf8");
    await writeFile(path.join(repository, "Assets", "Scenes", "Unexpected.unity"), "%YAML 1.1\n", "utf8");

    const attributedOnly = await handleCodexHook(
      options("PostToolUse"),
      input("PostToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: src/generated.ts\n*** End Patch" },
      }),
    );
    expect(attributedOnly).toMatchObject({
      hookSpecificOutput: { hookEventName: "PostToolUse" },
    });
    expect(JSON.stringify(attributedOnly)).toContain("src/generated.ts");
    expect(JSON.stringify(attributedOnly)).not.toContain("Assets/Scenes/Unexpected.unity");

    const nextWrite = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: src/after-quarantine.ts\n*** End Patch" },
      }),
    );
    expect(nextWrite).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
    expect(service.getDashboard(room.memberToken).records).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "risk" })]),
    );

    await handleCodexHook(options("SessionEnd"), input("SessionEnd", { reason: "other" }));
    expect(service.getDashboard(room.memberToken).sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "closed" })]),
    );
    const automaticMemory = featureStore.query(featureActor, {
      memberToken: room.memberToken,
      level: "detail",
      paths: ["src/value.ts"],
      statuses: ["draft", "candidate", "current", "conflict", "superseded", "deprecated"],
      limit: 20,
    }).details.find((revision) =>
      revision.sourceSessionId === hookSession!.id
      && revision.targets.some((target) => target.path === "src/value.ts"));
    expect(automaticMemory).toBeDefined();
    expect(automaticMemory?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "symbol", path: "src/value.ts", symbol: "value" }),
    ]));
    expect(automaticMemory?.targets).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "path", path: "src/value.ts" }),
    ]));
  }, 30_000);
});

async function createRepository(repository: string): Promise<void> {
  await mkdir(path.join(repository, "src"), { recursive: true });
  await mkdir(path.join(repository, "Assets", "Scenes"), { recursive: true });
  await writeFile(path.join(repository, "src", "value.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(repository, "src", "protected.ts"), "export function protectedBehavior() { return 1; }\n", "utf8");
  await writeFile(path.join(repository, "src", "foo.ts"), "export class Foo {\n  bar() { return 1; }\n}\n", "utf8");
  await writeFile(path.join(repository, "Assets", "Scenes", "Main.unity"), "%YAML 1.1\n", "utf8");
  await runGit(repository, ["init"]);
  await runGit(repository, ["config", "core.fsmonitor", "false"]);
  await runGit(repository, ["config", "user.email", "agent-hub@example.test"]);
  await runGit(repository, ["config", "user.name", "Agent Hub Test"]);
  await runGit(repository, ["add", "."]);
  await runGit(repository, ["commit", "-m", "Initial commit"]);
  await runGit(repository, ["branch", "-M", "main"]);
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, windowsHide: true });
}

async function outputGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    windowsHide: true,
    encoding: "utf8",
  });
  return result.stdout;
}
