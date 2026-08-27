import { describe, expect, it } from "vitest";
import { WindowsDpapiProtector } from "./windows-dpapi.js";

describe.runIf(process.platform === "win32")("WindowsDpapiProtector", () => {
  it("round-trips UTF-8 secrets for the current Windows user", () => {
    const protector = new WindowsDpapiProtector();
    const encrypted = protector.encryptString("Agent Hub 测试 token 123");
    expect(encrypted.toString("utf8")).not.toContain("Agent Hub");
    expect(protector.decryptString(encrypted)).toBe("Agent Hub 测试 token 123");
  }, 15_000);
});
