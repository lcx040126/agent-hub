import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectionStore,
  normalizeConnectionInput,
  parseStoreDocument,
  type SecretProtector,
} from "./connection-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

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

  it("defaults v0.2.0 connection documents to integration enabled", () => {
    const document = parseStoreDocument(JSON.stringify({
      version: 1,
      connections: [{
        id: "legacy-connection",
        serverUrl: "http://127.0.0.1:4173",
        repositoryPath: ".",
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
        tokenCiphertext: Buffer.from("legacy-token", "utf8").toString("base64"),
        tokenProtection: "windows-dpapi-v1",
      }],
    }));

    expect(document.connections[0]?.integrationEnabled).toBe(true);
    expect(document.connections[0]?.memberRole).toBeUndefined();
  });

  it("persists pause and resume without replacing the encrypted token", async () => {
    const directory = await temporaryDirectory();
    const store = new ConnectionStore(path.join(directory, "connections.json"), protector());
    const saved = await store.save({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token",
      repositoryPath: directory,
      memberRole: "host",
    });

    await store.pauseIntegration(saved.id);
    const reopened = new ConnectionStore(store.filePath, protector());
    await expect(reopened.get(saved.id)).resolves.toMatchObject({
      integrationEnabled: false,
      memberRole: "host",
    });
    await expect(reopened.readMemberToken(saved.id)).resolves.toBe("member-token");

    await reopened.activateIntegration(saved.id);
    const active = new ConnectionStore(store.filePath, protector());
    await expect(active.listActive()).resolves.toEqual([
      expect.objectContaining({ id: saved.id, integrationEnabled: true, memberRole: "host" }),
    ]);
  });

  it("serializes token updates and pause state without losing either write", async () => {
    const directory = await temporaryDirectory();
    const store = new ConnectionStore(path.join(directory, "connections.json"), protector());
    const saved = await store.save({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token-v1",
      repositoryPath: directory,
    });

    await Promise.all([
      store.pauseIntegration(saved.id),
      store.save({
        id: saved.id,
        serverUrl: saved.serverUrl,
        memberToken: "member-token-v2",
        repositoryPath: saved.repositoryPath,
      }),
    ]);

    await expect(store.get(saved.id)).resolves.toMatchObject({ integrationEnabled: false });
    await expect(store.readMemberToken(saved.id)).resolves.toBe("member-token-v2");
  });
});

function protector(): SecretProtector {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").replace(/^protected:/, ""),
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-connections-"));
  temporaryDirectories.push(directory);
  return directory;
}
