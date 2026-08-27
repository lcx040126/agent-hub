import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
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
      version: "0.2.1",
      mcpBridge: "ok",
      codexHook: "ok",
    });
  });
});
