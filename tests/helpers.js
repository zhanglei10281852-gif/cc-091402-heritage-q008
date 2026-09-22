// 测试辅助：可控时钟 + 内存服务。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { EventStore } from "../src/store.js";
import { DisasterService } from "../src/domain.js";

const here = dirname(fileURLToPath(import.meta.url));
export const seed = JSON.parse(readFileSync(resolve(here, "..", "reference", "seed.json"), "utf8"));

export class FakeClock {
  constructor(initial = "2026-07-10T08:00:00+08:00") {
    this.current = initial;
  }
  iso() {
    return new Date(this.current).toISOString();
  }
  set(t) {
    this.current = t;
  }
}

export function makeService(filePath = null, clock = new FakeClock()) {
  const store = new EventStore(filePath, () => clock.iso());
  const service = new DisasterService(store, seed, () => clock.iso());
  return { service, store, clock };
}

export const PEOPLE = {
  commander: "P-ZHANG", // 值班长
  admin: "P-LI", // 管理员
  wang: "P-WANG", // 保护人员
  chen: "P-CHEN", // 保护人员
  zhao: "P-ZHAO", // 工程保障
  liu: "P-LIU", // 安保
};

export const D = "2026-07-10";
export function t(h, m = 0) {
  return `${D}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+08:00`;
}

// 断言某调用以指定错误码拒绝。
export function assertThrowsCode(fn, code, status) {
  let thrown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.equal(thrown === undefined ? undefined : thrown.code, code, thrown ? thrown.message : `应当抛出 ${code}，但没有`);
  if (status && thrown) assert.equal(thrown.status, status);
  return thrown;
}

export function openIncident(service, body = {}) {
  return service.openIncident({
    type: "暴雨地下进水",
    title: "测试事件",
    actorPersonId: PEOPLE.commander,
    zoneIds: ["B1-A"],
    ...body,
  });
}

export function checkInAndAssign(service, incidentId, personId, duty, zoneId, start = t(8), end = t(20), actor = PEOPLE.commander) {
  service.checkIn(personId, { incidentId, at: t(7, 50), actorPersonId: personId });
  return service.assignPerson(incidentId, {
    personId,
    duty,
    zoneId,
    startAt: start,
    endAt: end,
    actorPersonId: actor,
  });
}
