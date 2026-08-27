import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectAttributedPathEvidence,
  evaluateTurnCompletionEvidence,
} from "./turn-completion.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("turn completion Git evidence", () => {
  it("accepts an attributed commit while ignoring unrelated worktree dirt", async () => {
    const repository = await createRepository();
    const baseline = await identity(repository);
    await write(repository, "src/task.ts", "export const task = 2;\n");
    const evidence = await collectAttributedPathEvidence(repository, baseline.head, ["src/task.ts"]);
    await git(repository, ["add", "src/task.ts"]);
    await git(repository, ["commit", "-m", "commit task"]);
    await write(repository, "src/unrelated.ts", "export const unrelated = 2;\n");

    await expect(evaluateTurnCompletionEvidence({
      repositoryPath: repository,
      branch: baseline.branch,
      baseCommit: baseline.head,
      attributedPaths: ["src/task.ts"],
      baselineEvidence: evidence,
      attributionComplete: true,
    })).resolves.toMatchObject({ status: "committed" });
  }, 10_000);

  it("keeps partial and unrelated commits pending while an attributed path is dirty", async () => {
    const repository = await createRepository();
    const baseline = await identity(repository);
    await write(repository, "src/task.ts", "export const task = 2;\n");
    await write(repository, "src/second.ts", "export const second = 2;\n");
    const evidence = await collectAttributedPathEvidence(
      repository,
      baseline.head,
      ["src/task.ts", "src/second.ts"],
    );
    await git(repository, ["add", "src/task.ts"]);
    await git(repository, ["commit", "-m", "partial task"]);
    await write(repository, "src/unrelated.ts", "export const unrelated = 2;\n");
    await git(repository, ["add", "src/unrelated.ts"]);
    await git(repository, ["commit", "-m", "unrelated commit"]);

    await expect(evaluateTurnCompletionEvidence({
      repositoryPath: repository,
      branch: baseline.branch,
      baseCommit: baseline.head,
      attributedPaths: ["src/task.ts", "src/second.ts"],
      baselineEvidence: evidence,
      attributionComplete: true,
    })).resolves.toMatchObject({ status: "awaiting_commit" });
  }, 10_000);

  it("accepts a full revert but rejects a clean HEAD that matches neither trusted version", async () => {
    const repository = await createRepository();
    const baseline = await identity(repository);
    await write(repository, "src/task.ts", "export const task = 2;\n");
    const evidence = await collectAttributedPathEvidence(repository, baseline.head, ["src/task.ts"]);
    await git(repository, ["restore", "--", "src/task.ts"]);

    await expect(evaluateTurnCompletionEvidence({
      repositoryPath: repository,
      branch: baseline.branch,
      baseCommit: baseline.head,
      attributedPaths: ["src/task.ts"],
      baselineEvidence: evidence,
      attributionComplete: true,
    })).resolves.toMatchObject({ status: "reverted" });

    await write(repository, "src/task.ts", "export const task = 3;\n");
    await git(repository, ["add", "src/task.ts"]);
    await git(repository, ["commit", "-m", "different content"]);
    await expect(evaluateTurnCompletionEvidence({
      repositoryPath: repository,
      branch: baseline.branch,
      baseCommit: baseline.head,
      attributedPaths: ["src/task.ts"],
      baselineEvidence: evidence,
      attributionComplete: true,
    })).resolves.toMatchObject({ status: "incomplete" });
  }, 10_000);

  it("treats a trustworthy empty attribution as reverted and incomplete attribution as pending evidence", async () => {
    const repository = await createRepository();
    const baseline = await identity(repository);
    await expect(evaluateTurnCompletionEvidence({
      repositoryPath: repository,
      branch: baseline.branch,
      baseCommit: baseline.head,
      attributedPaths: [],
      baselineEvidence: [],
      attributionComplete: true,
    })).resolves.toMatchObject({ status: "reverted" });
    await expect(evaluateTurnCompletionEvidence({
      repositoryPath: repository,
      branch: baseline.branch,
      baseCommit: baseline.head,
      attributedPaths: [],
      baselineEvidence: [],
      attributionComplete: false,
    })).resolves.toMatchObject({ status: "incomplete" });
  }, 10_000);
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(path.join(tmpdir(), "agent-hub-turn-completion-"));
  temporaryDirectories.push(repository);
  await mkdir(path.join(repository, "src"), { recursive: true });
  await write(repository, "src/task.ts", "export const task = 1;\n");
  await write(repository, "src/second.ts", "export const second = 1;\n");
  await write(repository, "src/unrelated.ts", "export const unrelated = 1;\n");
  await git(repository, ["init"]);
  await git(repository, ["config", "user.email", "agent-hub@example.test"]);
  await git(repository, ["config", "user.name", "Agent Hub Test"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "initial"]);
  return repository;
}

async function identity(repository: string): Promise<{ branch: string; head: string }> {
  const [branch, head] = await Promise.all([
    git(repository, ["branch", "--show-current"]),
    git(repository, ["rev-parse", "HEAD"]),
  ]);
  return { branch: branch.trim(), head: head.trim() };
}

async function write(repository: string, relativePath: string, content: string): Promise<void> {
  await writeFile(path.join(repository, ...relativePath.split("/")), content, "utf8");
}

async function git(repository: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true });
  return result.stdout;
}
