import { describe, expect, it } from "vitest";
import { candidatePorts, collectLanUrls } from "./network.js";

describe("candidatePorts", () => {
  it("starts at 4173 and increments predictably", () => {
    expect(candidatePorts(4173, 4)).toEqual([4173, 4174, 4175, 4176]);
  });

  it("does not cross the highest TCP port", () => {
    expect(candidatePorts(65_534, 10)).toEqual([65_534, 65_535]);
  });
});

describe("collectLanUrls", () => {
  it("returns unique usable IPv4 invitation addresses", () => {
    expect(
      collectLanUrls(4173, {
        loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        wifi: [
          { address: "192.168.1.20", family: "IPv4", internal: false },
          { address: "fe80::1234", family: "IPv6", internal: false },
        ],
        ethernet: [
          { address: "10.0.0.4", family: 4, internal: false },
          { address: "169.254.12.5", family: "IPv4", internal: false },
          { address: "192.168.1.20", family: "IPv4", internal: false },
        ],
      }),
    ).toEqual(["http://10.0.0.4:4173", "http://192.168.1.20:4173"]);
  });
});
