import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTION_STORE_FILENAME,
  ConnectionStore,
  canonicalRepositoryIdentity,
  type SecretProtector,
} from "../desktop/connection-store.js";
import {
  AmbiguousRepositoryConnectionError,
  resolveConnectionRecordForPath,
} from "./connection-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("connection routing by repository path", () => {
  it("ignores paused connections for the same canonical repository", async () => {
    const fixture = await createFixture();
    const paused = await fixture.store.save({
      serverUrl: "http://10.30.25.108:4173",
      memberToken: "offline-token",
      repositoryPath: fixture.repositoryPath,
    });
    const active = await fixture.store.save({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "active-token",
      repositoryPath: path.join(fixture.repositoryPath, "."),
    });
    await fixture.store.pauseIntegration(paused.id);
    const workingDirectory = path.join(fixture.repositoryPath, "src");
    await mkdir(workingDirectory, { recursive: true });

    const resolved = await resolveConnectionRecordForPath(
      fixture.userDataPath,
      workingDirectory,
      protector(),
    );

    expect(resolved?.connection.id).toBe(active.id);
  });

  it("selects the deepest active repository before considering shallower ambiguity", async () => {
    const fixture = await createFixture();
    const nestedRepository = path.join(fixture.repositoryPath, "packages", "nested");
    await mkdir(nestedRepository, { recursive: true });
    await fixture.store.save({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "root-one-token",
      repositoryPath: fixture.repositoryPath,
    });
    await fixture.store.save({
      serverUrl: "http://127.0.0.1:4174",
      memberToken: "root-two-token",
      repositoryPath: fixture.repositoryPath,
    });
    const nested = await fixture.store.save({
      serverUrl: "http://127.0.0.1:4175",
      memberToken: "nested-token",
      repositoryPath: nestedRepository,
    });
    const workingDirectory = path.join(nestedRepository, "src");
    await mkdir(workingDirectory, { recursive: true });

    const resolved = await resolveConnectionRecordForPath(
      fixture.userDataPath,
      workingDirectory,
      protector(),
    );

    expect(resolved?.connection.id).toBe(nested.id);
  });

  it("throws a dedicated error instead of guessing between active rooms", async () => {
    const fixture = await createFixture();
    const first = await fixture.store.save({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "first-token",
      repositoryPath: fixture.repositoryPath,
    });
    const second = await fixture.store.save({
      serverUrl: "http://10.30.25.108:4173",
      memberToken: "second-token",
      repositoryPath: path.join(fixture.repositoryPath, "."),
    });
    const repositoryIdentity = await canonicalRepositoryIdentity(fixture.repositoryPath);

    const operation = resolveConnectionRecordForPath(
      fixture.userDataPath,
      fixture.repositoryPath,
      protector(),
    );

    await expect(operation).rejects.toBeInstanceOf(AmbiguousRepositoryConnectionError);
    await expect(operation).rejects.toMatchObject({
      code: "AGENT_HUB_AMBIGUOUS_REPOSITORY_CONNECTION",
      repositoryIdentity,
      connectionIds: [first.id, second.id].sort(),
    });
  });

  it("returns no connection when every matching room is paused", async () => {
    const fixture = await createFixture();
    const saved = await fixture.store.save({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token",
      repositoryPath: fixture.repositoryPath,
    });
    await fixture.store.pauseIntegration(saved.id);

    await expect(resolveConnectionRecordForPath(
      fixture.userDataPath,
      fixture.repositoryPath,
      protector(),
    )).resolves.toBeUndefined();
  });
});

async function createFixture(): Promise<{
  userDataPath: string;
  repositoryPath: string;
  store: ConnectionStore;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-connection-runtime-"));
  temporaryDirectories.push(root);
  const userDataPath = path.join(root, "user-data");
  const repositoryPath = path.join(root, "repository");
  await Promise.all([
    mkdir(userDataPath, { recursive: true }),
    mkdir(repositoryPath, { recursive: true }),
  ]);
  return {
    userDataPath,
    repositoryPath,
    store: new ConnectionStore(
      path.join(userDataPath, CONNECTION_STORE_FILENAME),
      protector(),
    ),
  };
}

function protector(): SecretProtector {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").replace(/^protected:/, ""),
  };
}
