import { startAgentHubServer } from "./runtime.js";

const runtime = await startAgentHubServer({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 4173),
  dataDir: process.env.AGENT_HUB_DATA_DIR,
  development: process.env.NODE_ENV !== "production",
});

console.log(`Agent Hub is running at ${runtime.localUrl}`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await runtime.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
