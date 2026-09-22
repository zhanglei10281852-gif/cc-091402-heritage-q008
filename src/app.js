import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";
import { createScheduler } from "./reminders.js";
import { seedIfEmpty } from "./seed.js";
import { createRouter, sendJson } from "./router.js";
import { HttpError } from "./errors.js";
import { registerCoreRoutes } from "./api/core.js";
import { registerZoneRoutes } from "./api/zones.js";
import { registerLogisticsRoutes } from "./api/logistics.js";

const DEFAULT_SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

export function createApp(options = {}) {
  const dataDir = options.dataDir ?? path.join(process.cwd(), ".runtime");
  const store = createStore({
    dataDir,
    now: options.now,
    snapshotEvery: options.snapshotEvery,
    conflictWindowMinutes: options.conflictWindowMinutes,
  });
  seedIfEmpty(store, options.seedDir ?? DEFAULT_SEED_DIR);
  const scheduler = createScheduler({ store });
  const config = {
    zoneRecheckMinutes: options.zoneRecheckMinutes ?? 30,
    signoffDeadlineMinutes: options.signoffDeadlineMinutes ?? 45,
  };
  const ctx = { store, scheduler, config };
  const router = createRouter();

  router.get("/health", () => ({ payload: { status: "ok", service: "museum-disaster-response" } }));
  registerCoreRoutes(router, ctx);
  registerZoneRoutes(router, ctx);
  registerLogisticsRoutes(router, ctx);

  const server = createServer(async (request, response) => {
    try {
      await router.handle(request, response);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.status, {
          error: error.code,
          message: error.message,
          details: error.details ?? null,
        });
      } else {
        console.error(error);
        sendJson(response, 500, { error: "internal_error", message: "服务内部错误" });
      }
    }
  });

  // 重启恢复：为持久化的待触发提醒重新定时，过期的立即补发
  scheduler.armAll();

  server.store = store;
  server.scheduler = scheduler;
  server.shutdown = () => {
    scheduler.stop();
    store.close();
  };
  return server;
}
