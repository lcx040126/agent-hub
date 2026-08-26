import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  AGENT_HUB_PROTOCOL_VERSION,
  AGENT_HUB_RELEASE_OWNER,
  AGENT_HUB_RELEASE_REPOSITORY,
  AGENT_HUB_SCHEMA_VERSION,
  AGENT_HUB_UPDATE_MANIFEST_URL,
  AGENT_HUB_UPDATE_SIGNATURE_URL,
  AGENT_HUB_VERSION,
} from "../shared/version.js";

export const UPDATE_MANIFEST_FORMAT_VERSION = 1;
export const UPDATE_SIGNING_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAF/Q89n4cLckAoXcYvae2wBy/r7IsSnYluR8UMsGWn7o=
-----END PUBLIC KEY-----`;

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SIGNATURE_TEXT_BYTES = 1024;
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface DesktopUpdateManifest {
  formatVersion: 1;
  product: "agent-hub";
  channel: "stable";
  repository: string;
  version: string;
  publishedAt: string;
  protocolVersion: number;
  minimumSourceProtocolVersion: number;
  schemaVersion: number;
  minimumSourceSchemaVersion: number;
  notes?: string;
  asset: {
    fileName: string;
    url: string;
    sizeBytes: number;
    sha256: string;
  };
}

export interface VerifiedDesktopUpdateManifest {
  manifest: DesktopUpdateManifest;
  manifestSha256: string;
}

export interface LoadSignedManifestOptions {
  currentVersion?: string;
  currentProtocolVersion?: number;
  currentSchemaVersion?: number;
  highestSeenVersion?: string;
  fetchImpl?: typeof fetch;
  publicKeyPem?: string;
}

export async function loadSignedDesktopUpdateManifest(
  options: LoadSignedManifestOptions = {},
): Promise<VerifiedDesktopUpdateManifest> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const [manifestResponse, signatureResponse] = await Promise.all([
    fetchImpl(AGENT_HUB_UPDATE_MANIFEST_URL, {
      headers: { Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    }),
    fetchImpl(AGENT_HUB_UPDATE_SIGNATURE_URL, {
      headers: { Accept: "text/plain" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    }),
  ]);
  if (!manifestResponse.ok) {
    throw new Error(`GitHub update manifest returned HTTP ${manifestResponse.status}.`);
  }
  if (!signatureResponse.ok) {
    throw new Error(`GitHub update signature returned HTTP ${signatureResponse.status}.`);
  }
  const [manifestBytes, signatureBytes] = await Promise.all([
    readLimitedResponse(manifestResponse, MAX_MANIFEST_BYTES, "update manifest"),
    readLimitedResponse(signatureResponse, MAX_SIGNATURE_TEXT_BYTES, "update signature"),
  ]);
  const signatureText = Buffer.from(signatureBytes).toString("utf8");
  return verifyDesktopUpdateManifest(manifestBytes, signatureText, options);
}

export function verifyDesktopUpdateManifest(
  manifestBytes: Uint8Array,
  signatureText: string,
  options: Omit<LoadSignedManifestOptions, "fetchImpl"> = {},
): VerifiedDesktopUpdateManifest {
  if (manifestBytes.byteLength < 2 || manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("The signed update manifest size is invalid.");
  }
  if (Buffer.byteLength(signatureText, "utf8") > MAX_SIGNATURE_TEXT_BYTES) {
    throw new Error("The update manifest signature is invalid.");
  }
  const signature = decodeSignature(signatureText);
  const publicKey = createPublicKey(options.publicKeyPem ?? UPDATE_SIGNING_PUBLIC_KEY_PEM);
  if (!verifySignature(null, manifestBytes, publicKey, signature)) {
    throw new Error("The update manifest signature could not be verified.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  } catch {
    throw new Error("The signed update manifest is not valid JSON.");
  }
  const manifest = parseDesktopUpdateManifest(raw);
  assertUpdateCompatibility(manifest, {
    currentVersion: options.currentVersion ?? AGENT_HUB_VERSION,
    currentProtocolVersion: options.currentProtocolVersion ?? AGENT_HUB_PROTOCOL_VERSION,
    currentSchemaVersion: options.currentSchemaVersion ?? AGENT_HUB_SCHEMA_VERSION,
    highestSeenVersion: options.highestSeenVersion,
  });
  return {
    manifest,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
  };
}

export function parseDesktopUpdateManifest(value: unknown): DesktopUpdateManifest {
  const input = record(value, "update manifest");
  if (input.formatVersion !== UPDATE_MANIFEST_FORMAT_VERSION) {
    throw new Error("The update manifest format version is not supported.");
  }
  if (input.product !== "agent-hub" || input.channel !== "stable") {
    throw new Error("The update manifest product or channel is invalid.");
  }
  const repository = text(input.repository, "repository", 200);
  if (repository !== `${AGENT_HUB_RELEASE_OWNER}/${AGENT_HUB_RELEASE_REPOSITORY}`) {
    throw new Error("The update manifest repository is not trusted.");
  }
  const version = stableVersion(input.version, "version");
  const publishedAt = isoDate(input.publishedAt, "publishedAt");
  const protocolVersion = positiveInteger(input.protocolVersion, "protocolVersion");
  const minimumSourceProtocolVersion = positiveInteger(
    input.minimumSourceProtocolVersion,
    "minimumSourceProtocolVersion",
  );
  const schemaVersion = positiveInteger(input.schemaVersion, "schemaVersion");
  const minimumSourceSchemaVersion = positiveInteger(
    input.minimumSourceSchemaVersion,
    "minimumSourceSchemaVersion",
  );
  if (minimumSourceProtocolVersion > protocolVersion) {
    throw new Error("The update manifest protocol compatibility range is invalid.");
  }
  if (minimumSourceSchemaVersion > schemaVersion) {
    throw new Error("The update manifest schema compatibility range is invalid.");
  }

  const assetInput = record(input.asset, "update asset");
  const expectedFileName = `AgentHub-Setup-${version}-x64.exe`;
  const fileName = text(assetInput.fileName, "asset.fileName", 200);
  if (fileName !== expectedFileName) {
    throw new Error("The update manifest installer name does not match its version.");
  }
  const url = trustedInstallerUrl(assetInput.url, version, fileName);
  const sizeBytes = positiveInteger(assetInput.sizeBytes, "asset.sizeBytes");
  if (sizeBytes > MAX_INSTALLER_BYTES) {
    throw new Error("The update installer is larger than the supported limit.");
  }
  const sha256 = text(assetInput.sha256, "asset.sha256", 64).toLowerCase();
  if (!SHA256.test(sha256)) throw new Error("The update installer SHA-256 is invalid.");
  const notes = optionalText(input.notes, 8_000);

  return {
    formatVersion: UPDATE_MANIFEST_FORMAT_VERSION,
    product: "agent-hub",
    channel: "stable",
    repository,
    version,
    publishedAt,
    protocolVersion,
    minimumSourceProtocolVersion,
    schemaVersion,
    minimumSourceSchemaVersion,
    notes,
    asset: { fileName, url, sizeBytes, sha256 },
  };
}

export function compareStableVersions(left: string, right: string): number {
  const a = stableVersion(left, "version").split(".").map(Number);
  const b = stableVersion(right, "version").split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function assertUpdateCompatibility(
  manifest: DesktopUpdateManifest,
  current: {
    currentVersion: string;
    currentProtocolVersion: number;
    currentSchemaVersion: number;
    highestSeenVersion?: string;
  },
): void {
  if (compareStableVersions(manifest.version, current.currentVersion) < 0) {
    throw new Error("The update manifest attempts to downgrade Agent Hub.");
  }
  if (
    current.highestSeenVersion
    && compareStableVersions(manifest.version, current.highestSeenVersion) < 0
  ) {
    throw new Error("The update manifest is older than a previously verified release.");
  }
  if (
    current.currentProtocolVersion < manifest.minimumSourceProtocolVersion
    || current.currentProtocolVersion > manifest.protocolVersion
  ) {
    throw new Error("This Agent Hub protocol version cannot safely install the update.");
  }
  if (
    current.currentSchemaVersion < manifest.minimumSourceSchemaVersion
    || current.currentSchemaVersion > manifest.schemaVersion
  ) {
    throw new Error("This Agent Hub database schema cannot safely install the update.");
  }
}

function trustedInstallerUrl(value: unknown, version: string, fileName: string): string {
  const raw = text(value, "asset.url", 2_048);
  const url = new URL(raw);
  const expectedPath = `/${AGENT_HUB_RELEASE_OWNER}/${AGENT_HUB_RELEASE_REPOSITORY}/releases/download/v${version}/${fileName}`;
  if (
    url.protocol !== "https:"
    || url.origin !== "https://github.com"
    || url.pathname !== expectedPath
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("The update installer URL is not a trusted GitHub Release asset.");
  }
  return url.toString();
}

function decodeSignature(value: string): Buffer {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error("The update manifest signature is invalid.");
  }
  const signature = Buffer.from(normalized, "base64");
  if (signature.byteLength !== 64 || signature.toString("base64") !== normalized) {
    throw new Error("The update manifest signature is invalid.");
  }
  return signature;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${name} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`The update manifest ${name} is invalid.`);
  }
  return value.trim();
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) {
    throw new Error("The update manifest notes are invalid.");
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function stableVersion(value: unknown, name: string): string {
  const version = text(value, name, 80);
  if (!STABLE_VERSION.test(version)) {
    throw new Error(`The update manifest ${name} must be a stable semantic version.`);
  }
  return version;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`The update manifest ${name} is invalid.`);
  }
  return value;
}

function isoDate(value: unknown, name: string): string {
  const date = text(value, name, 80);
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== date) {
    throw new Error(`The update manifest ${name} is invalid.`);
  }
  return date;
}

async function readLimitedResponse(response: Response, maximumBytes: number, name: string): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > maximumBytes) {
    throw new Error(`The ${name} response is larger than the supported limit.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error(`The ${name} response is larger than the supported limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
