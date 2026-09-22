import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createApp } from "../src/app.js";

export async function startServer(options = {}) {
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "heritage-test-"));
  let currentTime = options.startTime ?? Date.parse("2026-09-22T15:00:00+08:00");
  const server = createApp({
    dataDir,
    now: options.realClock ? undefined : () => currentTime,
    zoneRecheckMinutes: options.zoneRecheckMinutes ?? 30,
    signoffDeadlineMinutes: options.signoffDeadlineMinutes ?? 45,
    snapshotEvery: options.snapshotEvery ?? 200,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(method, route, body, expectedStatus) {
    const response = await fetch(baseUrl + route, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    if (expectedStatus !== undefined && response.status !== expectedStatus) {
      throw new Error(`期望 ${expectedStatus}，实际 ${response.status}: ${JSON.stringify(json)}`);
    }
    return { status: response.status, body: json };
  }

  return {
    dataDir,
    setTime: (ms) => {
      currentTime = ms;
    },
    advance: (minutes) => {
      currentTime += minutes * 60 * 1000;
    },
    now: () => currentTime,
    request,
    get: (route, expectedStatus) => request("GET", route, undefined, expectedStatus),
    post: (route, body, expectedStatus) => request("POST", route, body, expectedStatus ?? 201),
    async close() {
      server.closeAllConnections?.();
      server.shutdown();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
