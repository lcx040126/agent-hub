import { describe, expect, it } from "vitest";
import { attributedChangedPaths, extractAttributedWriteIntent } from "./write-attribution.js";

describe("Agent write attribution", () => {
  it("extracts patch targets, operations, symbols, and a stable proposal hash", () => {
    const command = [
      "*** Begin Patch",
      "*** Update File: src/inventory.ts",
      "@@",
      "-export function moveItem() {}",
      "+export function moveItem(target: Slot) {}",
      "*** Add File: src/new.ts",
      "+export class InventoryGuard {}",
      "*** End Patch",
    ].join("\n");
    const intent = extractAttributedWriteIntent("apply_patch", { command });
    expect(intent).toMatchObject({
      writes: true,
      pathCandidates: ["src/inventory.ts", "src/new.ts"],
      attributedSideEffects: false,
    });
    expect(intent.targets[0]).toMatchObject({
      operation: "update",
      precision: "symbol",
      symbols: ["moveItem"],
    });
    expect(intent.targets[1]).toMatchObject({ operation: "add", symbols: ["InventoryGuard"] });
    expect(intent.proposalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(extractAttributedWriteIntent("apply_patch", { command }).proposalHash).toBe(intent.proposalHash);
  });

  it("uses symbol precision for source declarations but not for calls inside an unknown scope", () => {
    const declared = extractAttributedWriteIntent("apply_patch", {
      command: [
        "*** Begin Patch",
        "*** Update File: src/foo.ts",
        "@@",
        " export class Foo {",
        "+  baz() { return helper(); }",
        " }",
        "*** End Patch",
      ].join("\n"),
    });
    expect(declared.targets[0]).toMatchObject({
      precision: "symbol",
      symbols: ["baz"],
    });
    expect(declared.targets[0]?.symbols).not.toContain("helper");

    const bodyOnly = extractAttributedWriteIntent("apply_patch", {
      command: [
        "*** Begin Patch",
        "*** Update File: src/foo.ts",
        "@@",
        "-return oldValue();",
        "+return newValue();",
        "*** End Patch",
      ].join("\n"),
    });
    expect(bodyOnly.targets[0]).toMatchObject({ precision: "path", symbols: [] });
  });

  it("does not mistake PowerShell variables, switches, or item types for paths", () => {
    const intent = extractAttributedWriteIntent("Bash", {
      command: "New-Item -ItemType Junction -LiteralPath $junction -Target $workDir; Set-Content -LiteralPath 'src/config.json' -Value '{}'",
    });
    expect(intent.pathCandidates).toEqual(["src/config.json"]);
    expect(intent.pathCandidates).not.toEqual(expect.arrayContaining(["$junction", "$workDir", "Junction", "-LiteralPath"]));
    expect(intent.pathDiagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining("$junction"),
    ]));
  });

  it("resolves provable PowerShell variables and Join-Path without executing the command", () => {
    const intent = extractAttributedWriteIntent("Bash", {
      command: [
        "$root = 'C:\\project'",
        "$relative = 'src/config.json'",
        "$target = Join-Path -Path $root -ChildPath $relative",
        "Set-Content -LiteralPath $target -Value '{}'",
      ].join("; "),
    });

    expect(intent.pathCandidates).toEqual(["C:\\project\\src/config.json"]);
    expect(intent.targets).toEqual([
      expect.objectContaining({ pathCandidate: "C:\\project\\src/config.json", operation: "update" }),
    ]);
    expect(intent.pathDiagnostics).toEqual([]);
  });

  it("keeps dynamic PowerShell expressions as diagnostics instead of pseudo paths", () => {
    const intent = extractAttributedWriteIntent("Bash", {
      command: [
        "$target = Join-Path $env:TEMP 'agent-hub-test.log'",
        "Remove-Item -LiteralPath $target -ErrorAction SilentlyContinue",
      ].join("; "),
    });

    expect(intent).toMatchObject({ writes: true, pathCandidates: [] });
    expect(intent.pathDiagnostics.join(" ")).toContain("not a provable local constant");
    expect(intent.pathDiagnostics.join(" ")).not.toContain("SilentlyContinue path");
    expect(intent.pathCandidates).not.toEqual(expect.arrayContaining([
      "(Join-Path)",
      "SilentlyContinue",
      "Directory",
      "Junction",
    ]));
  });

  it("does not treat later or conditional PowerShell assignments as proven constants", () => {
    const assignedLater = extractAttributedWriteIntent("Bash", {
      command: "Set-Content -LiteralPath $target -Value '{}'; $target = 'src/later.json'",
    });
    expect(assignedLater.pathCandidates).toEqual([]);
    expect(assignedLater.pathDiagnostics.join(" ")).toContain("not a provable local constant");

    const conditional = extractAttributedWriteIntent("Bash", {
      command: "if ($enabled) { $target = 'src/branch.json' }; Set-Content -LiteralPath $target -Value '{}'",
    });
    expect(conditional.pathCandidates).toEqual([]);
    expect(conditional.pathDiagnostics.join(" ")).toContain("not a provable local constant");
  });

  it("does not let PowerShell switches consume positional paths", () => {
    const setContent = extractAttributedWriteIntent("Bash", {
      command: "Set-Content -Force 'src/config.json' '{}'",
    });
    expect(setContent.pathCandidates).toEqual(["src/config.json"]);

    const remove = extractAttributedWriteIntent("Bash", {
      command: "Remove-Item -Recurse -Force 'temp/build'",
    });
    expect(remove.targets).toEqual([
      expect.objectContaining({ pathCandidate: "temp/build", operation: "delete" }),
    ]);
  });

  it("uses command semantics for PowerShell move and copy destinations", () => {
    const move = extractAttributedWriteIntent("Bash", {
      command: "Move-Item -LiteralPath 'src/old.ts' -Destination 'src/new.ts'",
    });
    expect(move.targets).toEqual([
      expect.objectContaining({ pathCandidate: "src/old.ts", operation: "move" }),
      expect.objectContaining({ pathCandidate: "src/new.ts", operation: "move" }),
    ]);

    const copy = extractAttributedWriteIntent("Bash", {
      command: "Copy-Item -LiteralPath 'fixtures/source.json' -Destination 'artifacts/result.json'",
    });
    expect(copy.pathCandidates).toEqual(["artifacts/result.json"]);
  });

  it("resolves Rename-Item NewName relative to the source parent", () => {
    const rename = extractAttributedWriteIntent("Bash", {
      command: "Rename-Item 'src/old.ts' 'new.ts'",
    });
    expect(rename.targets.map((target) => ({
      ...target,
      pathCandidate: target.pathCandidate.replaceAll("\\", "/"),
    }))).toEqual([
      expect.objectContaining({ pathCandidate: "src/old.ts", operation: "move" }),
      expect.objectContaining({ pathCandidate: "src/new.ts", operation: "move" }),
    ]);
    expect(rename.pathCandidates).not.toContain("new.ts");
  });

  it("treats PowerShell null redirection as a sink rather than an unresolved file", () => {
    const intent = extractAttributedWriteIntent("Bash", {
      command: "Set-Content -LiteralPath 'src/config.json' -Value '{}' 2>$null",
    });

    expect(intent.pathCandidates).toEqual(["src/config.json"]);
    expect(intent.pathDiagnostics).toEqual([]);
  });

  it("attributes only the explicit target and classifies unrelated changes as external", () => {
    const result = attributedChangedPaths(
      {
        changedPaths: ["manual.txt"],
        changedPathFingerprints: { "manual.txt": "before" },
      },
      {
        changedPaths: ["manual.txt", "src/agent.ts", "Assets/Scene.unity"],
        changedPathFingerprints: {
          "manual.txt": "manually-updated",
          "src/agent.ts": "agent-updated",
          "assets/scene.unity": "unity-updated",
        },
      },
      ["src/agent.ts"],
      false,
    );
    expect(result.attributed).toEqual(["src/agent.ts"]);
    expect(result.external).toEqual(["manual.txt", "Assets/Scene.unity"]);
  });

  it("attributes recognized generator and formatter side effects", () => {
    const intent = extractAttributedWriteIntent("Bash", { command: ".\\gen_luban.bat" });
    expect(intent).toMatchObject({ writes: true, attributedSideEffects: true });
    const result = attributedChangedPaths(
      { changedPaths: [], changedPathFingerprints: {} },
      {
        changedPaths: ["Config/TbItem.xlsx", "Assets/Generated/tbitem.json"],
        changedPathFingerprints: { "config/tbitem.xlsx": "a", "assets/generated/tbitem.json": "b" },
      },
      [],
      intent.attributedSideEffects,
    );
    expect(result.attributed).toHaveLength(2);
    expect(result.external).toEqual([]);
  });

  it("attributes a tracked dirty path that the tool restores to clean", () => {
    const result = attributedChangedPaths(
      {
        changedPaths: ["src/restored.ts"],
        changedPathFingerprints: { "src/restored.ts": "dirty-content" },
      },
      { changedPaths: [], changedPathFingerprints: {} },
      ["src/restored.ts"],
      false,
    );

    expect(result).toEqual({ attributed: ["src/restored.ts"], external: [] });
  });

  it("attributes an initially untracked path that the tool deletes", () => {
    const result = attributedChangedPaths(
      {
        changedPaths: ["src/temporary.ts"],
        changedPathFingerprints: { "src/temporary.ts": "untracked-content" },
      },
      { changedPaths: [], changedPathFingerprints: {} },
      ["src/temporary.ts"],
      false,
    );

    expect(result).toEqual({ attributed: ["src/temporary.ts"], external: [] });
  });

  it("ignores read-only shell commands", () => {
    expect(extractAttributedWriteIntent("Bash", { command: "git diff -- src/app.ts" })).toMatchObject({
      writes: false,
      pathCandidates: [],
    });
  });
});
