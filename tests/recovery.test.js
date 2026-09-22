import assert from "node:assert/strict";
import test from "node:test";
import { sleep, startServer } from "./helpers.js";

async function poll(fn, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await sleep(50);
  }
}

test("重启后事件状态、待签收任务和待触发提醒完整恢复", async (context) => {
  const first = await startServer({ snapshotEvery: 5 });
  const incidentId = (
    await first.post("/incidents", { title: "进水", type: "暴雨", commanderId: "staff-01" })
  ).body.id;
  await first.post(`/incidents/${incidentId}/reports`, {
    zoneId: "B2-01",
    reporterId: "staff-03",
    status: "进水",
    occurredAt: "2026-09-22T15:00:00+08:00",
  });
  const route = (
    await first.post(`/incidents/${incidentId}/routes`, {
      by: "staff-03",
      fromZoneId: "B2-01",
      toZoneId: "B1-缓冲间",
    })
  ).body;
  const transfer = (
    await first.post(`/incidents/${incidentId}/transfers`, {
      by: "staff-03",
      routeId: route.id,
      autoSelect: { count: 2 },
    })
  ).body;
  await first.post(`/incidents/${incidentId}/transfers/${transfer.id}/depart`, { by: "staff-03" }, 200);
  await first.post(`/incidents/${incidentId}/reminders`, {
    by: "staff-01",
    message: "两小时后复查除湿机",
    fireAt: "2026-09-22T17:00:00+08:00",
  });
  const dataDir = first.dataDir;
  await first.close();

  // 重启：同一数据目录
  const second = await startServer({ dataDir });
  context.after(() => second.close());

  const incident = await second.get(`/incidents/${incidentId}`);
  assert.equal(incident.body.status, "open");
  const assessment = await second.get(`/incidents/${incidentId}/zones/B2-01/assessment`);
  assert.equal(assessment.body.currentStatus, "进水");
  assert.equal(assessment.body.reports.length, 1);

  // 待签收任务不丢
  const pending = await second.get(`/incidents/${incidentId}/pending-signoffs`);
  assert.equal(pending.body.pending.length, 1);
  assert.equal(pending.body.pending[0].id, transfer.id);
  assert.deepEqual(
    pending.body.pending[0].trajectory.map((t) => t.event),
    ["created", "departed"],
  );

  // 待触发提醒不丢：手动提醒 + 区域复查 + 签收时限
  const reminders = await second.get(`/incidents/${incidentId}/reminders?status=pending`);
  const kinds = reminders.body.reminders.map((r) => r.kind).sort();
  assert.deepEqual(kinds, ["manual", "signoff-deadline", "zone-recheck"]);

  // 重启后可以继续签收，轨迹连续
  await second.post(`/incidents/${incidentId}/transfers/${transfer.id}/arrive`, { by: "staff-03" }, 200);
  const signed = await second.post(`/incidents/${incidentId}/transfers/${transfer.id}/signoff`, {
    by: "staff-04",
  }, 200);
  assert.deepEqual(
    signed.body.trajectory.map((t) => t.event),
    ["created", "departed", "arrived", "signed"],
  );
  // 签收后签收时限提醒被取消
  const after = await second.get(`/incidents/${incidentId}/reminders?status=pending`);
  assert.ok(!after.body.reminders.some((r) => r.kind === "signoff-deadline"));
});

test("重启时已过期的提醒立即补发为通知", async (context) => {
  const first = await startServer();
  const incidentId = (
    await first.post("/incidents", { title: "进水", type: "暴雨", commanderId: "staff-01" })
  ).body.id;
  await first.post(`/incidents/${incidentId}/reminders`, {
    by: "staff-01",
    message: "15:20 前汇报水位",
    fireAt: "2026-09-22T15:20:00+08:00",
  });
  const dataDir = first.dataDir;
  await first.close();

  // 时钟走到 15:30 才重启：提醒已过期，启动即补发
  const second = await startServer({
    dataDir,
    startTime: Date.parse("2026-09-22T15:30:00+08:00"),
  });
  context.after(() => second.close());
  const notifications = await poll(async () => {
    const result = await second.get(`/incidents/${incidentId}/notifications`);
    return result.body.notifications.length > 0 ? result.body.notifications : null;
  });
  assert.equal(notifications[0].message, "15:20 前汇报水位");
  assert.equal(notifications[0].kind, "manual");
  const pending = await second.get(`/incidents/${incidentId}/reminders?status=pending`);
  assert.equal(pending.body.reminders.length, 0);
});

test("进水上报自动生成复查提醒并按时触发；恢复正常后取消", async (context) => {
  const server = await startServer({ realClock: true, zoneRecheckMinutes: 0.02 });
  context.after(() => server.close());
  const incidentId = (
    await server.post("/incidents", { title: "进水", type: "暴雨", commanderId: "staff-01" })
  ).body.id;
  const now = new Date().toISOString();
  await server.post(`/incidents/${incidentId}/reports`, {
    zoneId: "B2-03",
    reporterId: "staff-05",
    status: "进水",
    occurredAt: now,
  });
  const notifications = await poll(async () => {
    const result = await server.get(`/incidents/${incidentId}/notifications`);
    return result.body.notifications.some((n) => n.kind === "zone-recheck")
      ? result.body.notifications
      : null;
  });
  assert.ok(notifications.find((n) => n.kind === "zone-recheck").message.includes("B2-03"));

  // 恢复正常后，新的复查提醒被取消
  await server.post(`/incidents/${incidentId}/reports`, {
    zoneId: "B2-03",
    reporterId: "staff-05",
    status: "正常",
    occurredAt: new Date().toISOString(),
  });
  const pending = await server.get(`/incidents/${incidentId}/reminders?status=pending`);
  assert.ok(!pending.body.reminders.some((r) => r.related?.zoneId === "B2-03"));
});

test("批次出发后超时未签收触发签收时限提醒", async (context) => {
  const server = await startServer({ realClock: true, signoffDeadlineMinutes: 0.02 });
  context.after(() => server.close());
  const incidentId = (
    await server.post("/incidents", { title: "进水", type: "暴雨", commanderId: "staff-01" })
  ).body.id;
  const route = (
    await server.post(`/incidents/${incidentId}/routes`, {
      by: "staff-03",
      fromZoneId: "B2-01",
      toZoneId: "B1-缓冲间",
    })
  ).body;
  const transfer = (
    await server.post(`/incidents/${incidentId}/transfers`, {
      by: "staff-03",
      routeId: route.id,
      autoSelect: { count: 1 },
    })
  ).body;
  await server.post(`/incidents/${incidentId}/transfers/${transfer.id}/depart`, { by: "staff-03" }, 200);
  const notifications = await poll(async () => {
    const result = await server.get(`/incidents/${incidentId}/notifications`);
    return result.body.notifications.some((n) => n.kind === "signoff-deadline")
      ? result.body.notifications
      : null;
  });
  assert.ok(
    notifications.find((n) => n.kind === "signoff-deadline").message.includes(transfer.id),
  );
});
