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

  it("opens shared context, auto-leases edits, records changes, and blocks another member's Unity scope", async () => {
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

    const escapedScope = await handleCodexHook(
      options("PostToolUse"),
      input("PostToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: src/generated.ts\n*** End Patch" },
      }),
    );
    expect(escapedScope).toMatchObject({
      continue: false,
      decision: "block",
      hookSpecificOutput: { hookEventName: "PostToolUse" },
    });
    expect(JSON.stringify(escapedScope)).toContain("Assets/Scenes/Unexpected.unity");

    const quarantined = await handleCodexHook(
      options("PreToolUse"),
      input("PreToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: src/after-quarantine.ts\n*** End Patch" },
      }),
    );
    expect(quarantined).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
    expect(JSON.stringify(quarantined)).toContain("已隔离当前会话");
    expect(service.getDashboard(room.memberToken).records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "risk",
          title: "检测到未受租约保护的实际变更",
          status: "open",
        }),
      ]),
    );

    await handleCodexHook(options("SessionEnd"), input("SessionEnd", { reason: "other" }));
    expect(service.getDashboard(room.memberToken).sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "closed" })]),
    );
  }, 30_000);
});

async function createRepository(repository: string): Promise<void> {
  await mkdir(path.join(repository, "src"), { recursive: true });
  await mkdir(path.join(repository, "Assets", "Scenes"), { recursive: true });
  await writeFile(path.join(repository, "src", "value.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(repository, "Assets", "Scenes", "Main.unity"), "%YAML 1.1\n", "utf8");
  await runGit(repository, ["init"]);
  await runGit(repository, ["config", "user.email", "agent-hub@example.test"]);
  await runGit(repository, ["config", "user.name", "Agent Hub Test"]);
  await runGit(repository, ["add", "."]);
  await runGit(repository, ["commit", "-m", "Initial commit"]);
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}
