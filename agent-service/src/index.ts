import express from "express";
import { config, assertBootConfig } from "./config.js";
import { loadSecrets } from "./secrets.js";
import { audit } from "./db.js";
import { dataRouter } from "./routes/data.js";
import { adminRouter } from "./routes/admin.js";
import { startHealthLoop, closeAll } from "./mcp/pool.js";

assertBootConfig();
loadSecrets();

const app = express();
app.use(express.json({ limit: "4mb" }));

app.use((req, res, next) => {
  res.setHeader("X-Service", "station-llm-agent");
  next();
});

app.use(dataRouter);
app.use("/admin", adminRouter);

app.use((_req, res) => {
  res.status(404).json({ error: { message: "not found", type: "not_found" } });
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[http]", err);
  res.status(500).json({ error: { message: "internal error", type: "server_error" } });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`[agent-service] listening on ${config.host}:${config.port}`);
  console.log(`[agent-service] litellm: ${config.litellmBaseUrl}`);
  audit("boot", { port: config.port });
});

startHealthLoop(config.healthIntervalMs);

let shuttingDown = false;
async function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[agent-service] ${sig}: shutting down`);
  server.close();
  await closeAll().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
