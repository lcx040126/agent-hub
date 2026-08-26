import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { EntryScreen, nextPendingReleaseRequestId } from "./App";

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("dashboard modal coordination", () => {
  const requests = [
    { id: "request-other", status: "pending", holderMemberId: "member-other" },
    { id: "request-dismissed", status: "pending", holderMemberId: "member-current" },
    { id: "request-next", status: "pending", holderMemberId: "member-current" },
  ] as const;

  it("queues release requests until the current modal closes", () => {
    const dismissed = new Set(["request-dismissed"]);

    expect(nextPendingReleaseRequestId(
      { type: "claim" },
      requests,
      "member-current",
      dismissed,
    )).toBeUndefined();

    expect(nextPendingReleaseRequestId(
      null,
      requests,
      "member-current",
      dismissed,
    )).toBe("request-next");
  });

  it("does not reopen dismissed or already resolved requests", () => {
    expect(nextPendingReleaseRequestId(
      null,
      [
        { id: "request-dismissed", status: "pending", holderMemberId: "member-current" },
        { id: "request-resolved", status: "approved", holderMemberId: "member-current" },
      ],
      "member-current",
      new Set(["request-dismissed"]),
    )).toBeUndefined();
  });
});

describe("entry screen updates", () => {
  it("mounts the desktop update control before a room is opened", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        agentHubDesktop: {},
        location: { origin: "http://127.0.0.1:4173" },
      },
    });

    const markup = renderToStaticMarkup(<EntryScreen onConnected={() => undefined} />);

    expect(markup).toContain("entry-update-control");
    expect(markup).toContain('aria-label="软件更新"');
  });
});
