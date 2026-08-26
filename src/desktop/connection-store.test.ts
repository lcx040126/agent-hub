import { describe, expect, it } from "vitest";
import { normalizeConnectionInput, parseStoreDocument } from "./connection-store.js";

describe("connection store validation", () => {
  it("normalizes a server and repository without exposing URL credentials", () => {
    const result = normalizeConnectionInput({
      serverUrl: "http://192.168.1.10:4173/",
      memberToken: "secret-member-token",
      repositoryPath: ".",
    });
    expect(result.serverUrl).toBe("http://192.168.1.10:4173");
    expect(result.repositoryPath).toMatch(/agent-hub$/i);
  });

  it("rejects credentials embedded in an invitation URL", () => {
    expect(() =>
      normalizeConnectionInput({
        serverUrl: "http://token@example.test:4173",
        memberToken: "secret-member-token",
        repositoryPath: ".",
      }),
    ).toThrow(/credentials/i);
  });

  it("rejects plaintext or unknown token protection in persisted JSON", () => {
    expect(() =>
      parseStoreDocument(
        JSON.stringify({
          version: 1,
          connections: [{ id: "one", memberToken: "plaintext" }],
        }),
      ),
    ).toThrow(/invalid encrypted/i);
  });
});
