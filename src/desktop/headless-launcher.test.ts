import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderHeadlessLauncher } from "./headless-launcher.js";

describe("headless launcher", () => {
  it("enables Electron Node mode and forwards stdin-compatible arguments", () => {
    const script = renderHeadlessLauncher({
      launcherPath: path.resolve("tmp", "launcher.ps1"),
      electronExecutable: path.resolve("Program Files", "Agent Hub", "Agent Hub.exe"),
      runnerPath: path.resolve("Program Files", "Agent Hub", "resources", "app.asar", "dist", "companion", "headless-runner.js"),
      userDataPath: path.resolve("Users", "Alice", "AppData", "Agent Hub"),
    });
    expect(script).toContain("ELECTRON_RUN_AS_NODE");
    expect(script).toContain("@args");
    expect(script).toContain("--user-data");
    expect(script).not.toContain("memberToken");
  });
});
