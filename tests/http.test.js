import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { makeService, PEOPLE, t } from "./helpers.js";

async function harness() {
  const { service, clock } = makeService();
  clock.set(t(10)); // 当前时间 10:00，所有 08/09 点的现场记录均为历史上报
  const server = createApp(service);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    return { status: res.status, json };
  };
  const stop = () => new Promise((resolve) => server.close(resolve));
  return { call, stop, service, base };
}

test("HTTP 端到端：暴雨进水全流程指挥记录", async () => {
  const { call, stop } = await harness();
  try {
    // 1. 开通事件
    const opened = await call("POST", "/v1/incidents", {
      type: "暴雨地下进水",
      title: "7·10 地下库房进水",
      actorPersonId: PEOPLE.commander,
      zoneIds: ["B1-A"],
    });
    assert.equal(opened.status, 201);
    const incId = opened.json.id;

    // 2. 冲突电话上报合并
    await call("POST", `/v1/incidents/${incId}/reports`, {
      roomId: "B1-A-01", status: "flooded", source: "phone", reporterCaller: "内线8101",
      actorPersonId: PEOPLE.wang, occurredAt: t(8, 10),
    });
    await call("POST", `/v1/incidents/${incId}/reports`, {
      roomId: "B1-A-01", status: "critical", source: "field",
      actorPersonId: PEOPLE.commander, occurredAt: t(8, 20),
    });
    const assessment = await call("GET", `/v1/incidents/${incId}/rooms/B1-A-01/assessment`);
    assert.equal(assessment.json.current.status, "critical");
    assert.equal(assessment.json.evidence.length, 2);

    // 3. 封锁配电区
    const locked = await call("POST", `/v1/incidents/${incId}/locks`, {
      scope: "zone", targetId: "B1-C", reason: "漏电风险", actorPersonId: PEOPLE.commander,
    });
    assert.equal(locked.status, 201);
    // 普通调度进入封锁区被拒
    const blocked = await call("POST", `/v1/incidents/${incId}/allocations`, {
      resourceId: "RES-PUMP", quantity: 1, startAt: t(10), endAt: t(11),
      zoneId: "B1-C", actorPersonId: PEOPLE.zhao,
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error, "zone_locked");

    // 4. 设备超量分配被拒
    await call("POST", `/v1/incidents/${incId}/allocations`, {
      resourceId: "RES-PUMP", quantity: 2, startAt: t(10), endAt: t(12), actorPersonId: PEOPLE.zhao,
    });
    const over = await call("POST", `/v1/incidents/${incId}/allocations`, {
      resourceId: "RES-PUMP", quantity: 1, startAt: t(10), endAt: t(12), actorPersonId: PEOPLE.zhao,
    });
    assert.equal(over.status, 409);
    assert.equal(over.json.error, "capacity_exceeded");

    // 5. 签到 + 负责人排班
    await call("POST", `/v1/people/${PEOPLE.wang}/check-in`, { incidentId: incId, at: t(7, 30) });
    const asg = await call("POST", `/v1/incidents/${incId}/assignments`, {
      personId: PEOPLE.wang, duty: "zone_lead", zoneId: "B1-A",
      startAt: t(8), endAt: t(20), actorPersonId: PEOPLE.commander,
    });
    assert.equal(asg.status, 201);

    // 6. 紧急替代路线
    const route = await call("POST", `/v1/incidents/${incId}/routes`, {
      zonePath: ["B1-A", "B1-X", "G1"], kind: "emergency", toRoomId: "G1-01",
      reason: "主通道被淹", approvedByPersonId: PEOPLE.commander,
      validUntil: t(18), actorPersonId: PEOPLE.liu,
    });
    assert.equal(route.status, 201);
    assert.equal(route.json.approvedByPersonId, PEOPLE.commander);

    // 7. 转移批次完整轨迹
    const batch = await call("POST", `/v1/incidents/${incId}/transfers`, {
      artifactIds: ["ART-001", "ART-002"], routeId: route.json.id,
      leaderPersonId: PEOPLE.wang, actorPersonId: PEOPLE.commander,
    });
    assert.equal(batch.json.priority, 4); // 极脆弱
    for (const ev of [
      { event: "depart", leaderPersonId: PEOPLE.wang, at: t(9) },
      { event: "arrive", at: t(9, 30) },
      { event: "confirm", artifactId: "ART-001", at: t(9, 35) },
      { event: "confirm", artifactId: "ART-002", at: t(9, 36) },
      { event: "complete", at: t(9, 40) },
    ]) {
      const r = await call("POST", `/v1/transfers/${batch.json.id}/events`, { ...ev, actorPersonId: PEOPLE.wang });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    const traj = await call("GET", `/v1/transfers/${batch.json.id}/trajectory`);
    assert.equal(traj.json.events.length, 6);
    assert.equal(traj.json.batch.status, "completed");

    // 8. 区域视图含当前负责人
    const view = await call("GET", `/v1/incidents/${incId}/zones/B1-A`);
    assert.equal(view.json.currentLeader.personId, PEOPLE.wang);

    // 9. 时间线按发生时间排序
    const timeline = await call("GET", `/v1/incidents/${incId}/timeline`);
    const ats = timeline.json.events.map((e) => Date.parse(e.at));
    const sorted = ats.every((v, i) => i === 0 || ats[i - 1] <= v);
    assert.equal(sorted, true);

    // 错误请求体
    const bad = await call("POST", "/v1/incidents", { not: "valid" });
    assert.equal(bad.status, 400);
    const notFound = await call("GET", "/v1/incidents/nope");
    assert.equal(notFound.status, 404);
  } finally {
    await stop();
  }
});

test("HTTP：非法 JSON 返回 400", async () => {
  const { stop, base } = await harness();
  try {
    const res = await fetch(base + "/v1/incidents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{不是合法json",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_json");
  } finally {
    await stop();
  }
});
