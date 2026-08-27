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
