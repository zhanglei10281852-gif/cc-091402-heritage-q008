import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { EventStore } from "./store.js";
import { DisasterService } from "./domain.js";
import { createApp } from "./app.js";

const here = dirname(fileURLToPath(import.meta.url));
const seedPath = process.env.SEED_PATH ?? resolve(here, "..", "reference", "seed.json");
const seed = JSON.parse(readFileSync(seedPath, "utf8"));

// 指挥记录落盘位置；默认 ./data/events.jsonl，设为 "memory" 时纯内存运行。
const dataFile = process.env.DATA_FILE ?? resolve(here, "..", "data", "events.jsonl");
const store = new EventStore(dataFile === "memory" ? null : dataFile);
const service = new DisasterService(store, seed);
// 启动即扫描到期提醒；定时循环继续兜底。重启后待签收任务由事件重放恢复。
service.startReminderLoop();

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const server = createApp(service);
server.listen(port, host, () => console.log(`灾害响应指挥服务已启动：http://${host}:${port}`));

const shutdown = () => {
  server.close(() => {
    service.stop();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
