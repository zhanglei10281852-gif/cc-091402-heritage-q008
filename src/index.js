import { createApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";

const server = createApp({
  dataDir: process.env.DATA_DIR,
  zoneRecheckMinutes: process.env.ZONE_RECHECK_MINUTES ? Number(process.env.ZONE_RECHECK_MINUTES) : undefined,
  signoffDeadlineMinutes: process.env.SIGNOFF_DEADLINE_MINUTES ? Number(process.env.SIGNOFF_DEADLINE_MINUTES) : undefined,
});

server.listen(port, host, () => console.log("文物保护服务已启动"));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
