import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SaveRoomConnectionInput, SavedRoomConnection } from "./contracts.js";

export const CONNECTION_STORE_FILENAME = "connections.json";

export interface SecretProtector {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface EncryptedRoomConnection extends SavedRoomConnection {
  tokenCiphertext: string;
  tokenProtection: "windows-dpapi-v1";
}

interface ConnectionStoreDocument {
  version: 1;
  connections: EncryptedRoomConnection[];
}

export class ConnectionStore {
  constructor(
    readonly filePath: string,
    private readonly protector: SecretProtector,
  ) {}

  async list(): Promise<SavedRoomConnection[]> {
    return (await this.readDocument()).connections
      .map(toPublicConnection)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async save(input: SaveRoomConnectionInput): Promise<SavedRoomConnection> {
    if (!this.protector.isEncryptionAvailable()) {
      throw new Error("Windows secure storage is unavailable, so Agent Hub refused to save the member token.");
    }
    const normalized = normalizeConnectionInput(input);
    const document = await this.readDocument();
    const existingIndex = normalized.id
      ? document.connections.findIndex((connection) => connection.id === normalized.id)
      : -1;
    if (normalized.id && existingIndex < 0) {
      throw new Error("The room connection to update does not exist.");
    }

    const now = new Date().toISOString();
    const existing = existingIndex >= 0 ? document.connections[existingIndex] : undefined;
    const encrypted: EncryptedRoomConnection = {
      id: existing?.id ?? randomUUID(),
      serverUrl: normalized.serverUrl,
      repositoryPath: normalized.repositoryPath,
      roomId: normalized.roomId,
      roomName: normalized.roomName,
      memberName: normalized.memberName,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      tokenCiphertext: this.protector.encryptString(normalized.memberToken).toString("base64"),
      tokenProtection: "windows-dpapi-v1",
    };

    if (existingIndex >= 0) document.connections[existingIndex] = encrypted;
    else document.connections.push(encrypted);
    await this.writeDocument(document);
    return toPublicConnection(encrypted);
  }

  async get(connectionId: string): Promise<SavedRoomConnection | undefined> {
    const connection = (await this.readDocument()).connections.find((item) => item.id === connectionId);
    return connection ? toPublicConnection(connection) : undefined;
  }

  async readMemberToken(connectionId: string): Promise<string> {
    if (!this.protector.isEncryptionAvailable()) {
      throw new Error("Windows secure storage is unavailable, so the member token cannot be decrypted.");
    }
    const connection = (await this.readDocument()).connections.find((item) => item.id === connectionId);
    if (!connection) throw new Error("The requested room connection does not exist.");
    return this.protector.decryptString(Buffer.from(connection.tokenCiphertext, "base64"));
  }

  private async readDocument(): Promise<ConnectionStoreDocument> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return { version: 1, connections: [] };
      throw error;
    }
    return parseStoreDocument(raw);
  }

  private async writeDocument(document: ConnectionStoreDocument): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await restrictPermissions(directory, 0o700);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.filePath);
      await restrictPermissions(this.filePath, 0o600);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

export function parseStoreDocument(raw: string): ConnectionStoreDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Agent Hub's connection store is not valid JSON.");
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.connections)) {
    throw new Error("Agent Hub's connection store uses an unsupported format.");
  }
  return {
    version: 1,
    connections: parsed.connections.map(parseEncryptedConnection),
  };
}

export function normalizeConnectionInput(input: SaveRoomConnectionInput): SaveRoomConnectionInput {
  if (!isRecord(input)) throw new Error("A room connection object is required.");
  const serverUrl = normalizeServerUrl(requiredText(input.serverUrl, "server URL", 2048));
  const memberToken = requiredText(input.memberToken, "member token", 8192);
  const repositoryPath = path.resolve(requiredText(input.repositoryPath, "repository path", 4096));
  return {
    id: optionalText(input.id, 128),
    serverUrl,
    memberToken,
    repositoryPath,
    roomId: optionalText(input.roomId, 256),
    roomName: optionalText(input.roomName, 256),
    memberName: optionalText(input.memberName, 256),
  };
}

function parseEncryptedConnection(value: unknown): EncryptedRoomConnection {
  if (!isRecord(value) || value.tokenProtection !== "windows-dpapi-v1") {
    throw new Error("Agent Hub found an invalid encrypted room connection.");
  }
  const tokenCiphertext = requiredText(value.tokenCiphertext, "encrypted member token", 64_000);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(tokenCiphertext)) {
    throw new Error("Agent Hub found an invalid encrypted member token.");
  }
  return {
    id: requiredText(value.id, "connection ID", 128),
    serverUrl: normalizeServerUrl(requiredText(value.serverUrl, "server URL", 2048)),
    repositoryPath: path.resolve(requiredText(value.repositoryPath, "repository path", 4096)),
    roomId: optionalText(value.roomId, 256),
    roomName: optionalText(value.roomName, 256),
    memberName: optionalText(value.memberName, 256),
    createdAt: requiredIsoDate(value.createdAt, "createdAt"),
    updatedAt: requiredIsoDate(value.updatedAt, "updatedAt"),
    tokenCiphertext,
    tokenProtection: "windows-dpapi-v1",
  };
}

function toPublicConnection(connection: EncryptedRoomConnection): SavedRoomConnection {
  const { tokenCiphertext: _ciphertext, tokenProtection: _protection, ...publicConnection } = connection;
  return publicConnection;
}

function normalizeServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The Agent Hub server URL is invalid.");
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("The Agent Hub server URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The Agent Hub server URL cannot contain credentials, query parameters, or a fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function requiredText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`The ${name} is required.`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`The ${name} is too long.`);
  return trimmed;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("An optional connection field must be a string.");
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) throw new Error("An optional connection field is too long.");
  return trimmed;
}

function requiredIsoDate(value: unknown, name: string): string {
  const text = requiredText(value, name, 64);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`The ${name} value is not a valid date.`);
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function restrictPermissions(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // The token itself is protected by Windows DPAPI for the current user.
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
