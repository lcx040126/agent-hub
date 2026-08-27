import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectionStore,
  canonicalRepositoryIdentity,
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

  it("preserves unknown Codex intent while defaulting v0.2.0 connections to enabled", () => {
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
    expect(document.connections[0]?.codexIntegrationInstalled).toBeUndefined();
    expect(document.connections[0]?.memberRole).toBeUndefined();
  });

  it("keeps legacy Codex intent unknown when unrelated connection details are updated", async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, "connections.json");
    const legacy = {
      version: 1,
      connections: [{
        id: "legacy-connection",
        serverUrl: "http://127.0.0.1:4173",
        repositoryPath: directory,
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
        tokenCiphertext: Buffer.from("protected:member-token-v1", "utf8").toString("base64"),
        tokenProtection: "windows-dpapi-v1",
      }],
    };
    await writeFile(filePath, `${JSON.stringify(legacy)}\n`, "utf8");
    const store = new ConnectionStore(filePath, protector());

    await store.save({
      id: "legacy-connection",
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token-v2",
      repositoryPath: directory,
    });

    await expect(store.get("legacy-connection")).resolves.toMatchObject({
      codexIntegrationInstalled: undefined,
    });
  });

  it("preserves the Codex installation state when connection details are updated", async () => {
    const directory = await temporaryDirectory();
    const store = new ConnectionStore(path.join(directory, "connections.json"), protector());
    const saved = await store.save({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token-v1",
      repositoryPath: directory,
      codexIntegrationInstalled: true,
    });

    await store.save({
      id: saved.id,
      serverUrl: saved.serverUrl,
      memberToken: "member-token-v2",
      repositoryPath: saved.repositoryPath,
    });

    await expect(store.get(saved.id)).resolves.toMatchObject({
      codexIntegrationInstalled: true,
    });
  });

  it("serializes Codex installation state with concurrent connection updates", async () => {
    const directory = await temporaryDirectory();
    const store = new ConnectionStore(path.join(directory, "connections.json"), protector());
    const saved = await store.save({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token-v1",
      repositoryPath: directory,
    });

    expect(saved.codexIntegrationInstalled).toBe(false);
    await Promise.all([
      store.setCodexIntegrationInstalled(saved.id, true),
      store.save({
        id: saved.id,
        serverUrl: saved.serverUrl,
        memberToken: "member-token-v2",
        repositoryPath: saved.repositoryPath,
      }),
    ]);

    const reopened = new ConnectionStore(store.filePath, protector());
    await expect(reopened.get(saved.id)).resolves.toMatchObject({
      codexIntegrationInstalled: true,
    });
    await expect(reopened.readMemberToken(saved.id)).resolves.toBe("member-token-v2");
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

  it("resolves one canonical repository identity with a deterministic fallback", async () => {
    const directory = await temporaryDirectory();
    const resolved = path.normalize(await realpath(directory));
    const expected = process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
    await expect(canonicalRepositoryIdentity(path.join(directory, "."))).resolves.toBe(expected);

    const missing = path.resolve(directory, "missing", "repository");
    const expectedMissing = process.platform === "win32"
      ? missing.toLocaleLowerCase("en-US")
      : missing;
    await expect(canonicalRepositoryIdentity(missing)).resolves.toBe(expectedMissing);
  });

  it("removes encrypted connection data without decrypting the token", async () => {
    const directory = await temporaryDirectory();
    const store = new ConnectionStore(path.join(directory, "connections.json"), protector());
    const saved = await store.save({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token",
      repositoryPath: directory,
    });
    const unavailableProtector: SecretProtector = {
      isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error("encryption must not run"); },
      decryptString: () => { throw new Error("decryption must not run"); },
    };
    const reopened = new ConnectionStore(store.filePath, unavailableProtector);

    await expect(reopened.remove(saved.id)).resolves.toMatchObject({ id: saved.id });
    await expect(reopened.remove(saved.id)).resolves.toBeUndefined();
    await expect(reopened.list()).resolves.toEqual([]);
  });

  it("atomically selects one repository owner or pauses the entire repository", async () => {
    const directory = await temporaryDirectory();
    const otherRepository = await temporaryDirectory();
    const store = new ConnectionStore(path.join(directory, "connections.json"), protector());
    const first = await store.save({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "first-token",
      repositoryPath: directory,
    });
    const second = await store.save({
      serverUrl: "http://127.0.0.1:4174",
      memberToken: "second-token",
      repositoryPath: path.join(directory, "."),
    });
    const unrelated = await store.save({
      serverUrl: "http://127.0.0.1:4175",
      memberToken: "unrelated-token",
      repositoryPath: otherRepository,
    });

    await expect(store.setRepositoryIntegrationOwner(directory, second.id)).resolves.toMatchObject({
      owner: { id: second.id, integrationEnabled: true },
      pausedConnectionIds: [first.id],
    });
    await expect(store.get(first.id)).resolves.toMatchObject({ integrationEnabled: false });
    await expect(store.get(second.id)).resolves.toMatchObject({ integrationEnabled: true });
    await expect(store.get(unrelated.id)).resolves.toMatchObject({ integrationEnabled: true });

    await expect(store.setRepositoryIntegrationOwner(directory, null)).resolves.toMatchObject({
      owner: undefined,
      pausedConnectionIds: [second.id],
    });
    await expect(store.listActive()).resolves.toEqual([
      expect.objectContaining({ id: unrelated.id }),
    ]);
  });

  it("pauses every legacy active connection when a canonical repository is ambiguous", async () => {
    const directory = await temporaryDirectory();
    const otherRepository = await temporaryDirectory();
    const store = new ConnectionStore(path.join(directory, "connections.json"), protector());
    const first = await store.save({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "first-token",
      repositoryPath: directory,
    });
    const second = await store.save({
      serverUrl: "http://127.0.0.1:4174",
      memberToken: "second-token",
      repositoryPath: path.join(directory, "."),
    });
    const unrelated = await store.save({
      serverUrl: "http://127.0.0.1:4175",
      memberToken: "unrelated-token",
      repositoryPath: otherRepository,
    });

    await expect(store.normalizeRepositoryIntegrationOwners()).resolves.toEqual(
      [first.id, second.id].sort(),
    );
    await expect(store.normalizeRepositoryIntegrationOwners()).resolves.toEqual([]);
    const reopened = new ConnectionStore(store.filePath, protector());
    await expect(reopened.listActive()).resolves.toEqual([
      expect.objectContaining({ id: unrelated.id }),
    ]);
  });

  it("serializes competing repository owner changes without leaving two active rooms", async () => {
    const directory = await temporaryDirectory();
    const store = new ConnectionStore(path.join(directory, "connections.json"), protector());
    const first = await store.save({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "first-token",
      repositoryPath: directory,
    });
    const second = await store.save({
      serverUrl: "http://127.0.0.1:4174",
      memberToken: "second-token",
      repositoryPath: directory,
    });

    await Promise.all([
      store.setRepositoryIntegrationOwner(directory, first.id),
      store.setRepositoryIntegrationOwner(directory, second.id),
    ]);

    await expect(store.listActive()).resolves.toEqual([
      expect.objectContaining({ id: second.id }),
    ]);
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
