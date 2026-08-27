import path from "node:path";
import {
  CONNECTION_STORE_FILENAME,
  ConnectionStore,
  canonicalRepositoryIdentity,
  type SecretProtector,
} from "../desktop/connection-store.js";
import type { SavedRoomConnection } from "../desktop/contracts.js";
import { isPathInside } from "./git-state.js";
import { WindowsDpapiProtector } from "./windows-dpapi.js";

export interface ResolvedRoomConnection {
  connection: SavedRoomConnection;
  memberToken: string;
  store: ConnectionStore;
}

export interface ResolvedRoomConnectionRecord {
  connection: SavedRoomConnection;
  store: ConnectionStore;
}

export class AmbiguousRepositoryConnectionError extends Error {
  readonly code = "AGENT_HUB_AMBIGUOUS_REPOSITORY_CONNECTION";

  constructor(
    readonly repositoryIdentity: string,
    readonly connectionIds: string[],
  ) {
    super(
      `Agent Hub found multiple active room connections for repository ${repositoryIdentity}: ${connectionIds.join(", ")}. Pause all but one room before continuing.`,
    );
    this.name = "AmbiguousRepositoryConnectionError";
  }
}

export async function openConnectionStore(
  userDataPath: string,
  protector?: SecretProtector,
): Promise<ConnectionStore> {
  const resolvedProtector = protector ?? new WindowsDpapiProtector();
  return new ConnectionStore(
    path.join(path.resolve(userDataPath), CONNECTION_STORE_FILENAME),
    resolvedProtector,
  );
}

export async function resolveConnectionById(
  userDataPath: string,
  connectionId: string,
  protector?: SecretProtector,
): Promise<ResolvedRoomConnection> {
  const record = await resolveConnectionRecordById(userDataPath, connectionId, protector);
  return {
    ...record,
    memberToken: await record.store.readMemberToken(record.connection.id),
  };
}

export async function resolveConnectionRecordById(
  userDataPath: string,
  connectionId: string,
  protector?: SecretProtector,
): Promise<ResolvedRoomConnectionRecord> {
  const store = await openConnectionStore(userDataPath, protector);
  const connection = await store.get(connectionId);
  if (!connection) throw new Error("The Agent Hub room connection no longer exists.");
  return { connection, store };
}

export async function resolveConnectionForPath(
  userDataPath: string,
  selectedPath: string,
  protector?: SecretProtector,
): Promise<ResolvedRoomConnection | undefined> {
  const record = await resolveConnectionRecordForPath(userDataPath, selectedPath, protector);
  if (!record) return undefined;
  return {
    ...record,
    memberToken: await record.store.readMemberToken(record.connection.id),
  };
}

export async function resolveConnectionRecordForPath(
  userDataPath: string,
  selectedPath: string,
  protector?: SecretProtector,
): Promise<ResolvedRoomConnectionRecord | undefined> {
  const store = await openConnectionStore(userDataPath, protector);
  const candidate = await canonicalRepositoryIdentity(selectedPath);
  const connectionsWithPaths = await Promise.all(
    (await store.list())
      .filter((connection) => connection.integrationEnabled !== false)
      .map(async (connection) => ({
        connection,
        repositoryIdentity: await canonicalRepositoryIdentity(connection.repositoryPath),
      })),
  );
  const matches = connectionsWithPaths.filter((entry) =>
    isPathInside(entry.repositoryIdentity, candidate));
  if (matches.length === 0) return undefined;

  const deepestLength = Math.max(...matches.map((entry) => entry.repositoryIdentity.length));
  const deepest = matches.filter((entry) => entry.repositoryIdentity.length === deepestLength);
  const repositoryIdentities = new Set(deepest.map((entry) => entry.repositoryIdentity));
  if (repositoryIdentities.size !== 1 || deepest.length !== 1) {
    const identity = [...repositoryIdentities].sort()[0] ?? candidate;
    throw new AmbiguousRepositoryConnectionError(
      identity,
      deepest.map((entry) => entry.connection.id).sort(),
    );
  }
  return { connection: deepest[0]!.connection, store };
}
