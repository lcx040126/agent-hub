import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { AGENT_HUB_VERSION } from "../shared/version.js";
import { runHeadlessRunner } from "./headless-runner.js";

describe("Agent Hub headless health probe", () => {
  it("checks the MCP handshake and Hook write parser without connection state", async () => {
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });

    await expect(runHeadlessRunner(["AgentHub.exe", "--health-probe"], stdout)).resolves.toBe(0);
    expect(JSON.parse(output)).toEqual({
      status: "ok",
      version: AGENT_HUB_VERSION,
      mcpBridge: "ok",
      codexHook: "ok",
    });
  });
});
