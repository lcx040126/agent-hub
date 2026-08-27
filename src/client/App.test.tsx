import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeleteConnectionModal,
  EntryScreen,
  SavedConnectionList,
  nextPendingReleaseRequestId,
  noticeForActivatedConnection,
  noticeForDeletedConnection,
} from "./App";
import type { SavedRoomConnection } from "./api";

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
  it("surfaces pause and remote-cleanup warnings from create or join activation", () => {
    expect(noticeForActivatedConnection({
      pausedConnectionIds: ["connection-old"],
      warnings: ["旧房间离线，远端清理将在稍后重试。"],
    })).toEqual({
      tone: "warning",
      message: "已暂停同一项目的 1 个旧房间连接。 旧房间离线，远端清理将在稍后重试。",
    });
    expect(noticeForActivatedConnection({
      pausedConnectionIds: [],
      warnings: [],
    })).toBeNull();
  });

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

  it("shows a warning after local exit succeeds but remote cleanup fails", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        agentHubDesktop: {},
        location: { origin: "http://127.0.0.1:4173" },
      },
    });

    const markup = renderToStaticMarkup(
      <EntryScreen
        onConnected={() => undefined}
        initialNotice={{ tone: "warning", message: "房间中的会话或租约未能立即清理。" }}
      />,
    );

    expect(markup).toContain("toast warning");
    expect(markup).toContain("房间中的会话或租约未能立即清理。");
  });

  it("renders the full room history with separate open and delete buttons", () => {
    const connections: SavedRoomConnection[] = Array.from({ length: 4 }, (_, index) => ({
      id: `connection-${index + 1}`,
      serverUrl: `http://127.0.0.1:417${index}`,
      repositoryPath: "D:\\UGit\\projectvanguard",
      roomName: `房间 ${index + 1}`,
      memberName: "本机成员",
      memberRole: "member",
      integrationEnabled: true,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    }));

    const markup = renderToStaticMarkup(
      <SavedConnectionList
        connections={connections}
        deletingConnectionId="connection-2"
        onOpen={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(markup.match(/class="saved-connection-row"/g)).toHaveLength(4);
    expect(markup).toContain("房间 4");
    expect(markup).toContain('aria-label="打开房间 1"');
    expect(markup).toContain('aria-label="从本机移除房间 1"');
    expect(markup.match(/ disabled=""/g)).toHaveLength(2);
    expect(markup).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
  });

  it("makes the local-only scope explicit before deletion", () => {
    const markup = renderToStaticMarkup(
      <DeleteConnectionModal
        connection={{
          id: "connection-a",
          roomName: "先锋协作",
          memberName: "成员 A",
          serverUrl: "http://10.30.25.108:4173",
          repositoryPath: "D:\\UGit\\projectvanguard",
        }}
        busy={false}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(markup).toContain("只从这台电脑移除");
    expect(markup).toContain("不会删除远端房间或团队记录");
    expect(markup).toContain("远端会话或租约可能需要等待");
    expect(markup).toContain("从本机移除");
  });

  it("reports online deletion as complete and offline cleanup as a retry warning", () => {
    const completed = noticeForDeletedConnection({
      deletedConnectionId: "connection-a",
      remoteCleanup: "completed",
      codexConfigChanged: false,
      codexRestartRequired: false,
      warnings: [],
    });
    const offline = noticeForDeletedConnection({
      deletedConnectionId: "connection-b",
      remoteCleanup: "pending",
      codexConfigChanged: true,
      codexRestartRequired: true,
      warnings: [],
    });

    expect(completed).toEqual({
      tone: "success",
      message: "房间已从本机移除，本机保存的成员凭证和接入数据已删除。",
    });
    expect(offline.tone).toBe("warning");
    expect(offline.message).toContain("远端会话或租约可能要等到过期后才会清理");
    expect(offline.message).toContain("请重启 Codex");
  });

  it("keeps the confirmation available and displays a retryable deletion error", () => {
    const markup = renderToStaticMarkup(
      <DeleteConnectionModal
        connection={{
          id: "connection-a",
          roomName: "先锋协作",
          memberName: "成员 A",
          serverUrl: "http://10.30.25.108:4173",
          repositoryPath: "D:\\UGit\\projectvanguard",
        }}
        busy={false}
        error="Codex 配置无法安全写回，请重试。"
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Codex 配置无法安全写回，请重试。");
    expect(markup).toContain("从本机移除");
    expect(markup).not.toContain('disabled=""');
  });

  it("locks every dismissal control while local deletion is running", () => {
    const markup = renderToStaticMarkup(
      <DeleteConnectionModal
        connection={{
          id: "connection-a",
          roomName: "先锋协作",
          memberName: "成员 A",
          serverUrl: "http://10.30.25.108:4173",
          repositoryPath: "D:\\UGit\\projectvanguard",
        }}
        busy
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(markup).toContain("正在移除");
    expect(markup.match(/ disabled=""/g)).toHaveLength(3);
  });
});
