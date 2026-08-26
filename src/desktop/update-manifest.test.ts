import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  UPDATE_SIGNING_PUBLIC_KEY_PEM,
  verifyDesktopUpdateManifest,
} from "./update-manifest.js";

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

describe("signed desktop update manifest", () => {
  it("keeps the embedded verifier key synchronized with the release workflow key", async () => {
    const releaseKey = await readFile(new URL("../../assets/update-public-key.pem", import.meta.url), "utf8");
    const normalizedReleaseKey = releaseKey.replace(/\r\n/g, "\n");
    expect(`${UPDATE_SIGNING_PUBLIC_KEY_PEM.trim()}\n`).toBe(normalizedReleaseKey);
  });

  it("accepts a signed compatible GitHub Release installer", () => {
    const signed = signedManifest(manifest());
    expect(verifyDesktopUpdateManifest(signed.bytes, signed.signature, {
      publicKeyPem,
      currentVersion: "0.2.0",
      currentProtocolVersion: 1,
      currentSchemaVersion: 2,
    })).toMatchObject({
      manifest: { version: "0.3.0", asset: { fileName: "AgentHub-Setup-0.3.0-x64.exe" } },
    });
  });

  it("rejects any manifest byte changed after signing", () => {
    const signed = signedManifest(manifest());
    const tampered = Buffer.from(signed.bytes);
    tampered[tampered.length - 2] ^= 1;
    expect(() => verifyDesktopUpdateManifest(tampered, signed.signature, { publicKeyPem }))
      .toThrow(/signature/i);
  });

  it("rejects signed packages outside the fixed GitHub repository", () => {
    const value = manifest();
    value.asset.url = "https://evil.example/AgentHub-Setup-0.3.0-x64.exe";
    const signed = signedManifest(value);
    expect(() => verifyDesktopUpdateManifest(signed.bytes, signed.signature, { publicKeyPem }))
      .toThrow(/trusted GitHub Release/i);
  });

  it("rejects downgrade, replay, and incompatible source ranges", () => {
    const signed = signedManifest(manifest());
    expect(() => verifyDesktopUpdateManifest(signed.bytes, signed.signature, {
      publicKeyPem,
      currentVersion: "0.4.0",
      currentProtocolVersion: 1,
      currentSchemaVersion: 2,
    })).toThrow(/downgrade/i);
    expect(() => verifyDesktopUpdateManifest(signed.bytes, signed.signature, {
      publicKeyPem,
      currentVersion: "0.2.0",
      currentProtocolVersion: 1,
      currentSchemaVersion: 2,
      highestSeenVersion: "0.4.0",
    })).toThrow(/previously verified/i);

    const incompatible = manifest();
    incompatible.minimumSourceProtocolVersion = 2;
    incompatible.protocolVersion = 2;
    const incompatibleSigned = signedManifest(incompatible);
    expect(() => verifyDesktopUpdateManifest(incompatibleSigned.bytes, incompatibleSigned.signature, {
      publicKeyPem,
      currentVersion: "0.2.0",
      currentProtocolVersion: 1,
      currentSchemaVersion: 2,
    })).toThrow(/protocol/i);
  });
});

function manifest() {
  return {
    formatVersion: 1,
    product: "agent-hub",
    channel: "stable",
    repository: "lcx040126/agent-hub",
    version: "0.3.0",
    publishedAt: "2026-08-26T12:00:00.000Z",
    protocolVersion: 1,
    minimumSourceProtocolVersion: 1,
    schemaVersion: 2,
    minimumSourceSchemaVersion: 2,
    notes: "Signed update test",
    asset: {
      fileName: "AgentHub-Setup-0.3.0-x64.exe",
      url: "https://github.com/lcx040126/agent-hub/releases/download/v0.3.0/AgentHub-Setup-0.3.0-x64.exe",
      sizeBytes: 123,
      sha256: "a".repeat(64),
    },
  };
}

function signedManifest(value: ReturnType<typeof manifest>) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  return { bytes, signature: sign(null, bytes, keys.privateKey).toString("base64") };
}
