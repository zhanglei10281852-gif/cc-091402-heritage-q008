import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "./helpers.js";

const T = "2026-09-22T15:00:00+08:00";

test("事件创建、并行、关闭与指挥时间线", async (context) => {
  const server = await startServer();
  context.after(() => server.close());

  const zones = await server.get("/reference/zones");
  assert.ok(zones.body.zones.some((z) => z.id === "B2-01"));
  assert.ok((await server.get("/reference/equipment")).body.equipment.some((e) => e.type === "抽水泵"));
  assert.ok((await server.get("/reference/staff")).body.staff.some((s) => s.id === "staff-01"));
  assert.ok((await server.get("/reference/drills")).body.drills.length >= 2);

  const invalid = await server.post("/incidents", { title: "X", type: "暴雨", commanderId: "nobody" }, 400);
  assert.equal(invalid.body.error, "validation_error");
  const badDrill = await server.post(
    "/incidents",
    { title: "X", type: "暴雨", commanderId: "staff-01", drillCaseId: "nope" },
    409,
  );
  assert.equal(badDrill.body.error, "unknown_drill_case");

  const a = await server.post("/incidents", {
    title: "地下库房进水",
    type: "暴雨内涝",
    commanderId: "staff-01",
    drillCaseId: "drill-2025-06",
  });
  const b = await server.post("/incidents", { title: "配电房渗水", type: "设备险情", commanderId: "staff-02" });
  assert.notEqual(a.body.id, b.body.id);
  assert.equal(a.body.status, "open");

  const list = await server.get("/incidents");
  assert.equal(list.body.incidents.length, 2);
  assert.ok(list.body.incidents[0].zones.some((z) => z.zoneId === "B2-01"));

  // 未签收批次阻止关闭
  await server.post(`/incidents/${a.body.id}/checkins`, {
    personId: "staff-03",
    shiftFrom: T,
    shiftTo: "2026-09-22T20:00:00+08:00",
  });
  await server.post(`/incidents/${a.body.id}/reports`, {
    zoneId: "B2-01",
    reporterId: "staff-03",
    status: "进水",
    occurredAt: T,
  });
  await server.post(`/incidents/${a.body.id}/routes`, {
    by: "staff-03",
    fromZoneId: "B2-01",
    toZoneId: "B1-缓冲间",
  });
  const transfer = await server.post(`/incidents/${a.body.id}/transfers`, {
    by: "staff-03",
    routeId: (await server.get(`/incidents/${a.body.id}/routes`)).body.routes[0].id,
    autoSelect: { count: 1 },
  });
  const blocked = await server.post(`/incidents/${a.body.id}/close`, { by: "staff-01" }, 409);
  assert.equal(blocked.body.error, "pending_transfers");
  assert.ok(blocked.body.details.pendingTransferIds.includes(transfer.body.id));

  // 事件 B 可并行推进，互不干扰
  assert.equal((await server.get(`/incidents/${b.body.id}/feed`)).body.feed.length, 0);

  const forceClosed = await server.post(`/incidents/${b.body.id}/close`, { by: "staff-02", force: true }, 200);
  assert.equal(forceClosed.body.status, "closed");
  await server.post(`/incidents/${b.body.id}/reports`, {
    zoneId: "B2-03",
    reporterId: "staff-03",
    status: "进水",
    occurredAt: T,
  }, 409);
  // 已关闭事件仍可只读查看
  assert.equal((await server.get(`/incidents/${b.body.id}`)).body.status, "closed");

  // 指挥记录时间线包含事件创建等日志条目
  await server.post(`/incidents/${a.body.id}/transfers/${transfer.body.id}/depart`, { by: "staff-03" }, 200);
  await server.post(`/incidents/${a.body.id}/transfers/${transfer.body.id}/arrive`, { by: "staff-03" }, 200);
  await server.post(`/incidents/${a.body.id}/transfers/${transfer.body.id}/signoff`, { by: "staff-04" }, 200);
  const timeline = await server.get(`/incidents/${a.body.id}/timeline`);
  const types = timeline.body.entries.map((e) => e.type);
  assert.ok(types.includes("incident.created"));
  assert.ok(types.includes("report.received"));
  assert.ok(types.includes("transfer.created"));
  assert.ok(types.includes("transfer.departed"));
  assert.ok(types.includes("transfer.signed"));
  const seqs = timeline.body.entries.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));

  // 事件 B 的条目不会串到 A 的时间线
  const timelineB = await server.get(`/incidents/${b.body.id}/timeline`);
  assert.ok(!timelineB.body.entries.some((e) => e.type === "transfer.signed"));
});
