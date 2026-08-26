import { describe, expect, it } from "vitest";
import { extractWriteIntent } from "./codex-hook.js";

describe("Codex hook write detection", () => {
  it("extracts every source and destination from apply_patch", () => {
    const intent = extractWriteIntent("apply_patch", {
      command: [
        "*** Begin Patch",
        "*** Update File: src/existing.ts",
        "*** Move to: src/moved.ts",
        "*** Add File: src/new.ts",
        "*** Delete File: src/old.ts",
        "*** End Patch",
      ].join("\n"),
    });

    expect(intent).toEqual({
      writes: true,
      pathCandidates: ["src/existing.ts", "src/new.ts", "src/old.ts", "src/moved.ts"],
    });
  });

  it("does not treat read-only shell commands as writes", () => {
    expect(extractWriteIntent("Bash", { command: "git diff -- src/app.ts" })).toEqual({
      writes: false,
      pathCandidates: [],
    });
  });

  it("detects PowerShell and redirection targets", () => {
    expect(extractWriteIntent("Bash", {
      command: "Set-Content -LiteralPath 'src/config.json' -Value '{}'",
    })).toMatchObject({ writes: true, pathCandidates: ["src/config.json"] });
    expect(extractWriteIntent("Bash", {
      command: "tool.exe > artifacts/result.txt",
    })).toMatchObject({ writes: true, pathCandidates: ["artifacts/result.txt"] });
  });
});
