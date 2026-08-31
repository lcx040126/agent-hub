import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import express from "express";
import { createAgentHubApp } from "./app.js";
import { startActivityRetentionScheduler } from "./activity-retention.js";
import type { AgentHubDatabase } from "./db.js";
import { UpdateCoordinator } from "./update-coordinator.js";

export interface StartAgentHubServerOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  databasePath?: string;
  development?: boolean;
}

export interface AgentHubRuntime {
  server: Server;
  host: string;
  port: number;
  localUrl: string;
  close(): Promise<void>;
}

export async function startAgentHubServer(
  options: StartAgentHubServerOptions = {},
): Promise<AgentHubRuntime> {
  const host = options.host ?? "0.0.0.0";
  const databasePath = options.databasePath ?? resolve(options.dataDir ?? process.env.AGENT_HUB_DATA_DIR ?? join(process.cwd(), "data"), "agent-hub.sqlite");
  const updates = new UpdateCoordinator({
    manifestUrl: process.env.AGENT_HUB_UPDATE_MANIFEST_URL,
    stagingDirectory: resolve(options.dataDir ?? process.env.AGENT_HUB_DATA_DIR ?? join(process.cwd(), "data"), "updates"),
    databasePath,
  });
  const app = createAgentHubApp({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    includeNotFound: false,
    updateCoordinator: updates,
  });
  const development = options.development ?? process.env.NODE_ENV !== "production";
  let closeFrontend: () => Promise<void> = async () => {};

  if (development) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    closeFrontend = async () => vite.close();
  } else {
    const clientDirectory = fileURLToPath(new URL("../client", import.meta.url));
    app.use(express.static(clientDirectory));
    app.use((request, response) => {
      if (request.path.startsWith("/api/") || request.path.startsWith("/mcp")) {
        response.status(404).json({ error: "not_found", message: "Endpoint not found." });
        return;
      }
      response.sendFile(fileURLToPath(new URL("../client/index.html", import.meta.url)));
    });
  }

  const server = app.listen(options.port ?? 4173, host);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const port = address.port;
  const database = app.locals.agentHubDatabase as AgentHubDatabase;
  const activityRetention = startActivityRetentionScheduler({
    database,
    onReport: (report) => {
      for (const stat of report.stats) {
        console.info(
          `[agent-hub] activity cleanup room=${stat.roomId} type=${stat.activityType} deleted=${stat.deleted} before=${stat.cutoffAt}`,
        );
      }
      for (const failure of report.failures) {
        console.warn(
          `[agent-hub] activity cleanup deferred room=${failure.roomId} type=${failure.activityType}: ${failure.error}`,
        );
      }
    },
  });

  return {
    server,
    host,
    port,
    localUrl: `http://127.0.0.1:${port}`,
    async close() {
      await activityRetention.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await closeFrontend();
      database.close();
    },
  };
}
