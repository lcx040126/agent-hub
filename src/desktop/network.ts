import type { NetworkInterfaceInfo } from "node:os";

export interface NetworkInterfaceLike {
  address: string;
  family: NetworkInterfaceInfo["family"] | number;
  internal: boolean;
}

export type NetworkInterfacesLike = Record<string, NetworkInterfaceLike[] | undefined>;

export function candidatePorts(preferredPort = 4173, attempts = 100): number[] {
  if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65_535) {
    throw new Error("The preferred port must be an integer between 1 and 65535.");
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("The number of port attempts must be a positive integer.");
  }
  const lastPort = Math.min(65_535, preferredPort + attempts - 1);
  return Array.from({ length: lastPort - preferredPort + 1 }, (_, index) => preferredPort + index);
}

export function collectLanUrls(port: number, interfaces: NetworkInterfacesLike): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const isIpv4 = entry.family === "IPv4" || entry.family === 4;
      if (!isIpv4 || entry.internal || !isUsableLanAddress(entry.address)) continue;
      addresses.add(entry.address);
    }
  }
  return [...addresses]
    .sort((left, right) => left.localeCompare(right, "en-US", { numeric: true }))
    .map((address) => `http://${address}:${port}`);
}

function isUsableLanAddress(address: string): boolean {
  if (address === "0.0.0.0" || address.startsWith("127.")) return false;
  // APIPA addresses are not useful invitation addresses in normal LAN setups.
  if (address.startsWith("169.254.")) return false;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address);
}
