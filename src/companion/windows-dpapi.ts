import { spawnSync } from "node:child_process";
import type { SecretProtector } from "../desktop/connection-store.js";

const ENCRYPT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputStream = [Console]::OpenStandardInput()
$memory = [System.IO.MemoryStream]::new()
$inputStream.CopyTo($memory)
$protected = [System.Security.Cryptography.ProtectedData]::Protect(
  $memory.ToArray(),
  $null,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
$output = [Console]::OpenStandardOutput()
$output.Write($protected, 0, $protected.Length)
`;

const DECRYPT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$protected = [Convert]::FromBase64String($env:AGENT_HUB_DPAPI_CIPHERTEXT)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $protected,
  $null,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
$output = [Console]::OpenStandardOutput()
$output.Write($plain, 0, $plain.Length)
`;

export class WindowsDpapiProtector implements SecretProtector {
  constructor(private readonly powershellExecutable = "powershell.exe") {}

  isEncryptionAvailable(): boolean {
    return process.platform === "win32";
  }

  encryptString(plainText: string): Buffer {
    if (!this.isEncryptionAvailable()) {
      throw new Error("Windows DPAPI is unavailable on this operating system.");
    }
    return this.run(ENCRYPT_SCRIPT, Buffer.from(plainText, "utf8"));
  }

  decryptString(encrypted: Buffer): string {
    if (!this.isEncryptionAvailable()) {
      throw new Error("Windows DPAPI is unavailable on this operating system.");
    }
    const plain = this.run(DECRYPT_SCRIPT, undefined, {
      AGENT_HUB_DPAPI_CIPHERTEXT: encrypted.toString("base64"),
    });
    return plain.toString("utf8");
  }

  private run(script: string, input?: Buffer, environment?: Record<string, string>): Buffer {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const result = spawnSync(
      this.powershellExecutable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ],
      {
        input,
        encoding: null,
        env: { ...process.env, ...environment },
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
    if (result.error) throw new Error(`Windows DPAPI helper could not start: ${result.error.message}`);
    if (result.status !== 0) {
      const detail = result.stderr?.toString("utf8").trim();
      throw new Error(`Windows DPAPI operation failed${detail ? `: ${detail}` : "."}`);
    }
    return Buffer.from(result.stdout ?? []);
  }
}
