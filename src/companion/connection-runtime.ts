import path from "node:path";
import { realpath } from "node:fs/promises";
import { CONNECTION_STORE_FILENAME, ConnectionStore, type SecretProtector } from "../desktop/connection-store.js";
import type { SavedRoomConnection } from "../desktop/contracts.js";
import { isPathInside } from "./git-state.js";
import { WindowsDpapiProtector } from "./windows-dpapi.js";

export interface ResolvedRoomConnection {
  connection: SavedRoomConnection;
  memberToken: string;
  store: ConnectionStore;
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
  const store = await openConnectionStore(userDataPath, protector);
  const connection = await store.get(connectionId);
  if (!connection) throw new Error("The Agent Hub room connection no longer exists.");
  return {
    connection,
    memberToken: await store.readMemberToken(connection.id),
    store,
  };
}

export async function resolveConnectionForPath(
  userDataPath: string,
  selectedPath: string,
  protector?: SecretProtector,
): Promise<ResolvedRoomConnection | undefined> {
  const store = await openConnectionStore(userDataPath, protector);
  const candidate = await canonicalPath(selectedPath);
  const connectionsWithPaths = await Promise.all(
    (await store.list()).map(async (connection) => ({
      connection,
      repositoryPath: await canonicalPath(connection.repositoryPath),
    })),
  );
  const connections = connectionsWithPaths
    .filter((entry) => isPathInside(entry.repositoryPath, candidate))
    .map((entry) => entry.connection)
    .sort((left, right) => right.repositoryPath.length - left.repositoryPath.length);
  const connection = connections[0];
  if (!connection) return undefined;
  return {
    connection,
    memberToken: await store.readMemberToken(connection.id),
    store,
  };
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}
