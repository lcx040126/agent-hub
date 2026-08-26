import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
const releaseDirectory = path.resolve(projectRoot, options.releaseDirectory ?? "release");
const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const version = requiredStableVersion(packageMetadata.version, "package version");
const tag = options.tag ?? process.env.GITHUB_REF_NAME;
if (tag !== `v${version}`) {
  throw new Error(`Release tag ${tag || "<missing>"} must exactly match package version v${version}.`);
}

const signingKeyBase64 = process.env.AGENT_HUB_UPDATE_SIGNING_KEY_B64?.trim();
if (!signingKeyBase64) {
  throw new Error("GitHub secret AGENT_HUB_UPDATE_SIGNING_KEY_B64 is required to publish updates.");
}
const signingKeyPem = decodeSigningKey(signingKeyBase64);
const privateKey = createPrivateKey(signingKeyPem);
if (privateKey.asymmetricKeyType !== "ed25519") {
  throw new Error("AGENT_HUB_UPDATE_SIGNING_KEY_B64 must contain an Ed25519 PKCS#8 private key.");
}
const trustedPublicKeyPem = await readFile(path.join(projectRoot, "assets", "update-public-key.pem"), "utf8");
const expectedPublicKey = createPublicKey(trustedPublicKeyPem);
const signingPublicKey = createPublicKey(privateKey);
if (!signingPublicKey.export({ type: "spki", format: "der" }).equals(
  expectedPublicKey.export({ type: "spki", format: "der" }),
)) {
  throw new Error("The release signing secret does not match Agent Hub's embedded update public key.");
}

const files = await readdir(releaseDirectory);
const expectedInstallerName = `AgentHub-Setup-${version}-x64.exe`;
if (!files.includes(expectedInstallerName)) {
  throw new Error(`Expected NSIS installer ${expectedInstallerName} was not produced.`);
}
if (!files.includes("latest.yml")) {
  throw new Error("electron-builder did not produce release/latest.yml for the updater feed.");
}
const installerPath = path.join(releaseDirectory, expectedInstallerName);
const installer = await stat(installerPath);
if (!installer.isFile() || installer.size < 1) throw new Error("The NSIS installer is empty or invalid.");
const installerSha256 = await sha256File(installerPath);
const agentHub = packageMetadata.agentHub;
if (!agentHub || typeof agentHub !== "object") throw new Error("package.json is missing agentHub release metadata.");

const manifest = {
  formatVersion: 1,
  product: "agent-hub",
  channel: "stable",
  repository: "lcx040126/agent-hub",
  version,
  publishedAt: new Date().toISOString(),
  protocolVersion: requiredPositiveInteger(agentHub.protocolVersion, "protocolVersion"),
  minimumSourceProtocolVersion: requiredPositiveInteger(
    agentHub.minimumSourceProtocolVersion,
    "minimumSourceProtocolVersion",
  ),
  schemaVersion: requiredPositiveInteger(agentHub.schemaVersion, "schemaVersion"),
  minimumSourceSchemaVersion: requiredPositiveInteger(
    agentHub.minimumSourceSchemaVersion,
    "minimumSourceSchemaVersion",
  ),
  notes: normalizeNotes(process.env.AGENT_HUB_RELEASE_NOTES),
  asset: {
    fileName: expectedInstallerName,
    url: `https://github.com/lcx040126/agent-hub/releases/download/${tag}/${expectedInstallerName}`,
    sizeBytes: installer.size,
    sha256: installerSha256,
  },
};
if (!manifest.notes) delete manifest.notes;
if (manifest.minimumSourceProtocolVersion > manifest.protocolVersion) {
  throw new Error("minimumSourceProtocolVersion cannot exceed protocolVersion.");
}
if (manifest.minimumSourceSchemaVersion > manifest.schemaVersion) {
  throw new Error("minimumSourceSchemaVersion cannot exceed schemaVersion.");
}

const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const signature = sign(null, manifestBytes, privateKey);
if (!verify(null, manifestBytes, expectedPublicKey, signature)) {
  throw new Error("The generated update manifest signature failed local verification.");
}
await writeFile(path.join(releaseDirectory, "agent-hub-update.json"), manifestBytes);
await writeFile(path.join(releaseDirectory, "agent-hub-update.sig"), `${signature.toString("base64")}\n`, "utf8");
process.stdout.write(`Created signed Agent Hub ${version} update manifest.\n`);

function parseArguments(arguments_) {
  const result = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === "--release-dir" && value) {
      result.releaseDirectory = value;
      index += 1;
    } else if (name === "--tag" && value) {
      result.tag = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${name}`);
    }
  }
  return result;
}

function decodeSigningKey(value) {
  if (!/^[A-Za-z0-9+/=]+$/.test(value)) {
    throw new Error("AGENT_HUB_UPDATE_SIGNING_KEY_B64 is not valid base64.");
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.toString("base64") !== value) {
    throw new Error("AGENT_HUB_UPDATE_SIGNING_KEY_B64 is not canonical base64.");
  }
  const pem = bytes.toString("utf8");
  if (!pem.includes("BEGIN PRIVATE KEY")) {
    throw new Error("AGENT_HUB_UPDATE_SIGNING_KEY_B64 does not contain a PKCS#8 PEM private key.");
  }
  return pem;
}

function requiredStableVersion(value, name) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${name} must be a stable semantic version.`);
  }
  return value;
}

function requiredPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function normalizeNotes(value) {
  if (!value) return undefined;
  const notes = value.trim();
  if (!notes) return undefined;
  if (notes.length > 8_000) throw new Error("AGENT_HUB_RELEASE_NOTES exceeds 8,000 characters.");
  return notes;
}

async function sha256File(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}
