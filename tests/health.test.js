import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createApp } from "../src/app.js";
import { EventStore } from "../src/store.js";
import { DisasterService } from "../src/domain.js";

const here = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(resolve(here, "..", "reference", "seed.json"), "utf8"));

export function makeService(clock) {
  const store = new EventStore(null, clock ?? (() => new Date().toISOString()));
  return new DisasterService(store, seed, clock ?? (() => new Date().toISOString()));
}

test("健康接口返回服务标识", async (context) => {
  const service = makeService();
  const server = createApp(service);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch("http://127.0.0.1:" + address.port + "/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", service: "museum-disaster-response" });
});
