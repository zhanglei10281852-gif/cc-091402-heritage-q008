import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "./helpers.js";

async function createIncident(server) {
  const incident = await server.post("/incidents", {
    title: "进水",
    type: "暴雨",
    commanderId: "staff-01",
  });
  return incident.body.id;
}

test("同一房间重复上报合并并保留全部原始证据", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  const incidentId = await createIncident(server);

  await server.post(`/incidents/${incidentId}/reports`, {
    zoneId: "B2-01",
    reporterId: "staff-03",
    status: "进水",
    waterLevel: 12,
    note: "门口漫水",
    occurredAt: "2026-09-22T15:00:00+08:00",
  });
  const merged = await server.post(`/incidents/${incidentId}/reports`, {
    zoneId: "B2-01",
    reporterId: "staff-04",
    status: "进水",
    waterLevel: 15,
    note: "水位上涨",
    occurredAt: "2026-09-22T15:10:00+08:00",
  });

  // 只有一份评估，原始证据两条都保留
  assert.equal(merged.body.reports.length, 2);
  assert.equal(merged.body.currentStatus, "进水");
  assert.equal(merged.body.currentReportId, merged.body.reports[1].id);
  assert.equal(merged.body.conflicting, false);

  const assessment = await server.get(`/incidents/${incidentId}/zones/B2-01/assessment`);
  assert.equal(assessment.body.reports.length, 2);
  // 另一个房间是独立评估
  const other = await server.get(`/incidents/${incidentId}/zones/B2-02/assessment`);
  assert.deepEqual(other.body.reports, []);
  assert.equal(other.body.currentStatus, "未知");
});

test("冲突房间状态被标记，但不丢弃任何一方的证据", async (context) => {
  const server = await startServer({ conflictWindowMinutes: 30 });
  context.after(() => server.close());
  const incidentId = await createIncident(server);

  await server.post(`/incidents/${incidentId}/reports`, {
    zoneId: "B2-走廊",
    reporterId: "staff-03",
    status: "进水",
    occurredAt: "2026-09-22T15:00:00+08:00",
  });
  const conflictReport = await server.post(`/incidents/${incidentId}/reports`, {
    zoneId: "B2-走廊",
    reporterId: "staff-08",
    status: "正常",
    note: "电话里说已退水",
    occurredAt: "2026-09-22T15:05:00+08:00",
  });
  assert.equal(conflictReport.body.conflicting, true);
  assert.equal(conflictReport.body.currentStatus, "正常");
  assert.equal(conflictReport.body.reports.length, 2);

  // 窗口外的旧状态上报不再构成冲突
  const server2 = await startServer({ conflictWindowMinutes: 30 });
  context.after(() => server2.close());
  const id2 = await createIncident(server2);
  await server2.post(`/incidents/${id2}/reports`, {
    zoneId: "B2-走廊",
    reporterId: "staff-03",
    status: "进水",
    occurredAt: "2026-09-22T14:00:00+08:00",
  });
  const later = await server2.post(`/incidents/${id2}/reports`, {
    zoneId: "B2-走廊",
    reporterId: "staff-08",
    status: "正常",
    occurredAt: "2026-09-22T15:00:00+08:00",
  });
  assert.equal(later.body.conflicting, false);
});

test("网络恢复后的迟到批量补报按发生时间重排，当前状态取最新发生时间", async (context) => {
  const server = await startServer({ startTime: Date.parse("2026-09-22T15:30:00+08:00") });
  context.after(() => server.close());
  const incidentId = await createIncident(server);

  // 先收到一条 15:30 的正常上报
  await server.post(`/incidents/${incidentId}/reports`, {
    zoneId: "B2-01",
    reporterId: "staff-08",
    status: "正常",
    occurredAt: "2026-09-22T15:30:00+08:00",
  });
  server.setTime(Date.parse("2026-09-22T16:30:00+08:00"));
  // 网络恢复，补报 15:00 危险 和 15:20 进水（都比 15:30 早发生但晚到达）
  const batch = await server.post(`/incidents/${incidentId}/reports/batch`, {
    reports: [
      {
        zoneId: "B2-02",
        reporterId: "staff-03",
        status: "进水",
        occurredAt: "2026-09-22T15:20:00+08:00",
      },
      {
        zoneId: "B2-01",
        reporterId: "staff-03",
        status: "危险",
        occurredAt: "2026-09-22T15:00:00+08:00",
      },
    ],
  });
  const feed = batch.body.reorderedFeed;
  const occurred = feed.map((r) => r.occurredAt);
  assert.deepEqual(occurred, [...occurred].sort());
  const lateOnes = feed.filter((r) => r.lateArrival);
  assert.equal(lateOnes.length, 2);
  assert.ok(lateOnes.every((r) => Date.parse(r.receivedAt) > Date.parse(r.occurredAt)));

  // B2-01 当前状态仍是发生时间最新的"正常"，而不是后到的"危险"
  const b201 = batch.body.assessments.find((a) => a.zoneId === "B2-01");
  assert.equal(b201.currentStatus, "正常");
  assert.equal(b201.reports.length, 2);

  const receivedOrder = await server.get(`/incidents/${incidentId}/feed?order=receivedAt`);
  assert.equal(receivedOrder.body.feed[0].status, "正常");
  assert.deepEqual(
    receivedOrder.body.feed.slice(1).map((r) => r.status).sort(),
    ["危险", "进水"],
  );
});

test("非法时间和非法状态被拒绝", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  const incidentId = await createIncident(server);
  const noZone = await server.post(
    `/incidents/${incidentId}/reports`,
    { zoneId: "NOPE", reporterId: "staff-03", status: "进水", occurredAt: "2026-09-22T15:00:00+08:00" },
    404,
  );
  assert.equal(noZone.body.error, "not_found");
  const badTime = await server.post(
    `/incidents/${incidentId}/reports`,
    { zoneId: "B2-01", reporterId: "staff-03", status: "进水", occurredAt: "2026-09-22 15:00" },
    400,
  );
  assert.equal(badTime.body.error, "validation_error");
  const badStatus = await server.post(
    `/incidents/${incidentId}/reports`,
    { zoneId: "B2-01", reporterId: "staff-03", status: "坍塌", occurredAt: "2026-09-22T15:00:00+08:00" },
    400,
  );
  assert.equal(badStatus.body.error, "validation_error");
});
