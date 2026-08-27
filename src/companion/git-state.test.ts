import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectGitIdentity,
  inspectGitWorkingPathsFromIdentity,
  inspectGitWorkingStateFromIdentity,
} from "./git-state.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("incremental Git working state", () => {
  it("fingerprints explicit targets without loading unrelated dirty files", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "agent-hub-targeted-git-"));
    temporaryDirectories.push(repository);
    await mkdir(path.join(repository, "src"), { recursive: true });
    await writeFile(path.join(repository, "src", "target.ts"), "export const target = 1;\n", "utf8");
    await writeFile(path.join(repository, "src", "external.ts"), "export const external = 1;\n", "utf8");
    await git(repository, ["init"]);
    await git(repository, ["config", "user.email", "agent-hub@example.test"]);
    await git(repository, ["config", "user.name", "Agent Hub Test"]);
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "-m", "initial"]);
    await writeFile(path.join(repository, "src", "target.ts"), "export const target = 2;\n", "utf8");
    await writeFile(path.join(repository, "src", "external.ts"), "export const external = 2;\n", "utf8");

    const identity = await inspectGitIdentity(repository);
    const targeted = await inspectGitWorkingPathsFromIdentity(identity, ["src/target.ts"]);
    const complete = await inspectGitWorkingStateFromIdentity(identity);

    expect(targeted.changedPaths).toEqual(["src/target.ts"]);
    expect(Object.keys(targeted.changedPathFingerprints)).toEqual(["src/target.ts"]);
    expect(complete.changedPaths).toEqual(["src/external.ts", "src/target.ts"]);
  }, 10_000);
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}
