import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { collectFeatureGitEvidence, extractDependencies, extractSourceSymbols } from "./feature-evidence.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("feature Git evidence", () => {
  it("captures committed and uncommitted work after the task baseline", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "agent-hub-feature-evidence-"));
    temporaryDirectories.push(repository);
    await runGit(repository, ["init"]);
    await runGit(repository, ["config", "core.fsmonitor", "false"]);
    await runGit(repository, ["config", "user.email", "agent-hub@example.test"]);
    await runGit(repository, ["config", "user.name", "Agent Hub"]);
    await mkdir(path.join(repository, "src", "Inventory"), { recursive: true });
    await writeFile(path.join(repository, "src", "Inventory", "Bag.cs"), "public class Bag {}\n", "utf8");
    await runGit(repository, ["add", "."]);
    await runGit(repository, ["commit", "-m", "baseline"]);
    const baseCommit = (await outputGit(repository, ["rev-parse", "HEAD"])).trim();

    await writeFile(path.join(repository, "src", "Inventory", "Bag.cs"), [
      "using Game.Items;",
      "public class Bag {",
      "  public void MoveItem() {}",
      "}",
      "",
    ].join("\n"), "utf8");
    await runGit(repository, ["add", "."]);
    await runGit(repository, ["commit", "-m", "add inventory movement"]);
    await mkdir(path.join(repository, "tests"), { recursive: true });
    await writeFile(path.join(repository, "tests", "Bag.test.ts"), "export const pending = true;\n", "utf8");

    const evidence = await collectFeatureGitEvidence(repository, baseCommit);
    expect(evidence).toMatchObject({
      committed: true,
      committedPaths: ["src/Inventory/Bag.cs"],
      uncommittedPaths: ["tests/Bag.test.ts"],
    });
    expect(evidence.changedPaths).toEqual(["src/Inventory/Bag.cs", "tests/Bag.test.ts"]);
    expect(evidence.commits[0].subject).toBe("add inventory movement");
    expect(evidence.symbols).toEqual(expect.arrayContaining(["Bag", "MoveItem"]));
    expect(evidence.symbolLocations).toEqual(expect.arrayContaining([
      { path: "src/Inventory/Bag.cs", symbol: "Bag" },
      { path: "src/Inventory/Bag.cs", symbol: "MoveItem" },
    ]));
    expect(evidence.dependencies).toContain("Game.Items");
    expect(evidence.relatedTests).toEqual(["tests/Bag.test.ts"]);
    expect(evidence.diffSha256).toMatch(/^[a-f0-9]{64}$/);
  }, 15_000);

  it("extracts common C#/TypeScript declarations and imports", () => {
    expect(extractSourceSymbols("export function plan() {}\npublic class Planner {}\n")).toEqual(expect.arrayContaining(["plan", "Planner"]));
    expect(extractDependencies("import { x } from './x';\nusing Game.Core;\n")).toEqual(["./x", "Game.Core"]);
  });

  it("limits evidence to Agent-attributed paths", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "agent-hub-feature-evidence-filter-"));
    temporaryDirectories.push(repository);
    await runGit(repository, ["init"]);
    await runGit(repository, ["config", "core.fsmonitor", "false"]);
    await runGit(repository, ["config", "user.email", "agent-hub@example.test"]);
    await runGit(repository, ["config", "user.name", "Agent Hub"]);
    await mkdir(path.join(repository, "src"), { recursive: true });
    await writeFile(path.join(repository, "src", "baseline.ts"), "export const baseline = true;\n", "utf8");
    await runGit(repository, ["add", "."]);
    await runGit(repository, ["commit", "-m", "baseline"]);
    const baseCommit = (await outputGit(repository, ["rev-parse", "HEAD"])).trim();

    await writeFile(path.join(repository, "src", "agent.ts"), "export function agentFeature() { return 1; }\n", "utf8");
    await writeFile(path.join(repository, "src", "manual.ts"), "export function manualEdit() { return 2; }\n", "utf8");

    const evidence = await collectFeatureGitEvidence(repository, baseCommit, {
      includePaths: ["src/agent.ts"],
    });

    expect(evidence.changedPaths).toEqual(["src/agent.ts"]);
    expect(evidence.symbols).toContain("agentFeature");
    expect(evidence.symbols).not.toContain("manualEdit");
    expect(evidence.symbolLocations).toContainEqual({ path: "src/agent.ts", symbol: "agentFeature" });
    expect(evidence.diffSha256).toMatch(/^[a-f0-9]{64}$/);
  }, 15_000);
});

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
