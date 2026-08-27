import path from "node:path";
import type { ConnectionStore } from "./connection-store.js";
import type { RoomServerResponse } from "./contracts.js";
import { IntegrationOperationTracker } from "../companion/integration-operations.js";
import { hasPendingPauseForConnection } from "../companion/pause-retry.js";
import { hasPendingPausePreparationForConnection } from "../companion/pause-preparation.js";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

const BOOTSTRAP_ROUTES = new Map([
  ["GET", new Set(["/api/health"])],
  ["POST", new Set(["/api/rooms", "/api/rooms/join"])],
]);

const SAVED_GET_ROUTES = new Set([
  "/api/health",
  "/api/dashboard",
  "/api/snapshot",
  "/api/context",
  "/api/activity",
  "/api/release-requests",
  "/api/sessions",
  "/api/room/settings",
  "/api/room/context/export",
  "/api/update/status",
]);

const SAVED_GET_ROUTE_PATTERNS = [
  /^\/api\/features\/[A-Za-z0-9_-]{1,128}\/history$/,
];

const SAVED_POST_ROUTES = [
  /^\/api\/context$/,
  /^\/api\/leases$/,
  /^\/api\/leases\/[A-Za-z0-9_-]{1,128}\/(?:renew|close)$/,
  /^\/api\/release-requests\/[A-Za-z0-9_-]{1,128}\/resolve$/,
  /^\/api\/edits\/check$/,
  /^\/api\/edits\/prepare$/,
  /^\/api\/features\/query$/,
  /^\/api\/features\/revisions$/,
  /^\/api\/features\/[A-Za-z0-9_-]{1,128}\/rollback$/,
  /^\/api\/feature-confirmations\/[A-Za-z0-9_-]{1,128}\/resolve$/,
  /^\/api\/records$/,
  /^\/api\/decisions$/,
  /^\/api\/verifications$/,
  /^\/api\/handoffs$/,
  /^\/api\/sessions$/,
  /^\/api\/sessions\/[A-Za-z0-9_-]{1,128}\/(?:heartbeat|scan|close|sync|rebaseline)$/,
  /^\/api\/room\/settings$/,
  /^\/api\/room\/transfer$/,
  /^\/api\/room\/dissolve$/,
  /^\/api\/room\/context\/import$/,
  /^\/api\/room\/members\/[A-Za-z0-9_-]{1,128}\/(?:role|remove)$/,
  /^\/api\/update\/(?:check|stage)$/,
];

interface RoomConnectionLookup {
  readonly filePath?: string;
  get(connectionId: string): ReturnType<ConnectionStore["get"]>;
  readMemberToken(connectionId: string): ReturnType<ConnectionStore["readMemberToken"]>;
}

interface RequestPlan {
  url: string;
  pathname: string;
  method: "GET" | "POST";
  body?: string;
  memberToken?: string;
}

export async function requestRoomServer(
  input: unknown,
  connections: RoomConnectionLookup,
  fetchImplementation: typeof fetch = fetch,
): Promise<RoomServerResponse> {
  const value = requireRecord(input, "A room server request object is required.");
  const connectionId = optionalString(value.connectionId, "connection ID", 128);
  const savedMutation = Boolean(
    connectionId
    && typeof value.method === "string"
    && value.method.trim().toUpperCase() === "POST",
  );
  if (connectionId && savedMutation && connections.filePath) {
    return new IntegrationOperationTracker(path.dirname(connections.filePath)).run(
      connectionId,
      () => requestRoomServerResolved(
        value,
        connections,
        fetchImplementation,
        connectionId,
        true,
      ),
    );
  }
  return requestRoomServerResolved(
    value,
    connections,
    fetchImplementation,
    connectionId,
    savedMutation,
  );
}

async function requestRoomServerResolved(
  value: Record<string, unknown>,
  connections: RoomConnectionLookup,
  fetchImplementation: typeof fetch,
  connectionId: string | undefined,
  savedMutation: boolean,
): Promise<RoomServerResponse> {
  let serverUrl: string;
  let memberToken: string | undefined;
  let savedConnection = false;

  if (connectionId) {
    if (value.serverUrl !== undefined) {
      throw new Error("A saved room request cannot override its server URL.");
    }
    const connection = await connections.get(connectionId);
    if (!connection) throw new Error("The selected room connection does not exist.");
    if (savedMutation && connection.integrationEnabled === false) {
      throw new Error("Agent Hub room changes are disabled while this connection is paused.");
    }
    if (
      savedMutation
      && connections.filePath
      && (
        await hasPendingPausePreparationForConnection(path.dirname(connections.filePath), connectionId)
        || await hasPendingPauseForConnection(path.dirname(connections.filePath), connectionId)
      )
    ) {
      throw new Error(
        "Agent Hub is finishing the previous shutdown cleanup before allowing new room changes.",
      );
    }
    serverUrl = connection.serverUrl;
    memberToken = await connections.readMemberToken(connectionId);
    savedConnection = true;
  } else {
    serverUrl = requiredString(value.serverUrl, "server URL", 2048);
  }

  const plan = createRequestPlan(value, serverUrl, memberToken, savedConnection);
  const headers = new Headers({ Accept: "application/json" });
  if (plan.body !== undefined) headers.set("Content-Type", "application/json");
  if (plan.memberToken) headers.set("Authorization", `Bearer ${plan.memberToken}`);

  let response: Response;
  try {
    response = await fetchImplementation(plan.url, {
      method: plan.method,
      headers,
      body: plan.body,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown network error";
    throw new Error(`Agent Hub could not reach the room server: ${message}`);
  }

  if (response.status === 204) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, body: null };
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("The room server returned a non-JSON response.");
  }
  const responseText = await readLimitedResponse(response, MAX_RESPONSE_BYTES);
  let body: unknown;
  try {
    body = responseText ? JSON.parse(responseText) : null;
  } catch {
    throw new Error("The room server returned invalid JSON.");
  }
  return {
    status: response.status,
    body: plan.memberToken ? redactSecret(body, plan.memberToken) : body,
  };
}

export function createRequestPlan(
  value: Record<string, unknown>,
  rawServerUrl: string,
  memberToken: string | undefined,
  savedConnection: boolean,
): RequestPlan {
  const method = requiredString(value.method, "HTTP method", 8).toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new Error("Room server requests only support GET and POST.");
  }
  const path = requiredString(value.path, "API path", 4096);
  const serverUrl = normalizeServerUrl(rawServerUrl);
  const target = new URL(path, `${serverUrl}/`);
  if (target.origin !== new URL(serverUrl).origin || target.username || target.password) {
    throw new Error("The room server API path must stay on the selected server.");
  }
  validatePathEncoding(target.pathname);

  if (savedConnection) validateSavedRoute(method, target);
  else validateBootstrapRoute(method, target);
  if (method === "GET" && value.body !== undefined) {
    throw new Error("GET room server requests cannot include a body.");
  }

  let body: string | undefined;
  if (method === "POST") {
    if (value.body === undefined) throw new Error("POST room server requests require a JSON body.");
    rejectSensitiveFields(value.body);
    try {
      body = JSON.stringify(value.body);
    } catch {
      throw new Error("The room server request body must be valid JSON data.");
    }
    if (body === undefined) throw new Error("The room server request body must be valid JSON data.");
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
      throw new Error("The room server request body is too large.");
    }
  }

  return { url: target.toString(), pathname: target.pathname, method, body, memberToken };
}

function validateBootstrapRoute(method: "GET" | "POST", target: URL): void {
  if (target.search) throw new Error("Initial room server requests cannot include query parameters.");
  if (!BOOTSTRAP_ROUTES.get(method)?.has(target.pathname)) {
    throw new Error("This API route is not allowed before a room connection is saved.");
  }
}

function validateSavedRoute(method: "GET" | "POST", target: URL): void {
  if (method === "GET") {
    if (
      !SAVED_GET_ROUTES.has(target.pathname)
      && !SAVED_GET_ROUTE_PATTERNS.some((pattern) => pattern.test(target.pathname))
    ) {
      throw new Error("This Agent Hub GET route is not allowed through the desktop proxy.");
    }
    validateQuery(target);
    return;
  }
  if (target.search || !SAVED_POST_ROUTES.some((pattern) => pattern.test(target.pathname))) {
    throw new Error("This Agent Hub POST route is not allowed through the desktop proxy.");
  }
}

function validateQuery(target: URL): void {
  const allowed = target.pathname === "/api/context"
    ? new Set(["path", "paths"])
    : target.pathname === "/api/activity"
      ? new Set(["limit", "after"])
      : target.pathname === "/api/release-requests"
        ? new Set(["status"])
      : new Set<string>();
  for (const key of target.searchParams.keys()) {
    if (!allowed.has(key)) throw new Error("The Agent Hub API query parameter is not allowed.");
  }
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
  return url.origin;
}

function validatePathEncoding(pathname: string): void {
  if (/%(?:2e|2f|5c)/i.test(pathname) || pathname.includes("\\")) {
    throw new Error("Encoded path traversal is not allowed in a room server request.");
  }
  if (!pathname.startsWith("/api/") || pathname.startsWith("/mcp")) {
    throw new Error("Only allowlisted Agent Hub API paths can be requested.");
  }
}

function rejectSensitiveFields(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new Error("The room server request body must not contain cycles.");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) rejectSensitiveFields(entry, seen);
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (/^(?:authorization|memberToken|token)$/i.test(key)) {
        throw new Error("Member tokens cannot be supplied through the room server proxy body.");
      }
      rejectSensitiveFields(entry, seen);
    }
  }
  seen.delete(value);
}

async function readLimitedResponse(response: Response, limit: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("The room server response is too large.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("The room server response is too large.");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function redactSecret(value: unknown, secret: string): unknown {
  if (typeof value === "string") return value.split(secret).join("[redacted]");
  if (Array.isArray(value)) return value.map((entry) => redactSecret(entry, secret));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactSecret(entry, secret)]),
  );
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`The ${name} is required.`);
  const result = value.trim();
  if (result.length > maxLength) throw new Error(`The ${name} is too long.`);
  return result;
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, name, maxLength);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}
