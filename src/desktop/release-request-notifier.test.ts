import { describe, expect, it, vi } from "vitest";
import { startReleaseRequestNotificationScheduler } from "./release-request-notifier.js";

describe("release request notification scheduler", () => {
  it("notifies the lease holder once for each pending request", async () => {
    const notify = vi.fn();
    const request = vi.fn(async () => ({
      status: 200,
      body: {
        currentMember: { id: "holder-1" },
        releaseRequests: [
          {
            id: "request-1",
            status: "pending",
            holderMemberId: "holder-1",
            requesterName: "成员 B",
            requestTitle: "修改背包拖拽",
            requestedPaths: ["Assets/Vanguard/Inventory"],
          },
          {
            id: "request-for-someone-else",
            status: "pending",
            holderMemberId: "holder-2",
            requesterName: "成员 C",
            requestTitle: "其他申请",
            requestedPaths: [],
          },
        ],
      },
    }));
    const store = connectionLookup();
    const scheduler = startReleaseRequestNotificationScheduler({
      store,
      request,
      notify,
      intervalMs: 60_000,
    });
    await scheduler.scanNow();
    await scheduler.scanNow();
    await scheduler.stop();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      id: "request-1",
      requesterName: "成员 B",
      requestedPaths: ["Assets/Vanguard/Inventory"],
    }), expect.objectContaining({ id: "connection-1" }));
  });

  it("waits for an in-flight notification scan before stopping", async () => {
    let finishRequest!: (value: { status: number; body: object }) => void;
    const request = vi.fn(() => new Promise<{ status: number; body: object }>((resolve) => {
      finishRequest = resolve;
    }));
    const scheduler = startReleaseRequestNotificationScheduler({
      store: connectionLookup(),
      request,
      notify: vi.fn(),
      intervalMs: 60_000,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishRequest({ status: 200, body: {} });
    await stopping;
    expect(stopped).toBe(true);
  });
});

function connectionLookup() {
  const connection = {
    id: "connection-1",
    serverUrl: "http://127.0.0.1:4173",
    repositoryPath: "D:\\UGit\\projectvanguard",
    roomName: "先锋协作",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
  return {
    list: vi.fn(async () => [connection]),
    get: vi.fn(async () => connection),
    readMemberToken: vi.fn(async () => "member-token"),
  };
}
