import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "./helpers.js";

async function createIncident(server, commanderId = "staff-01") {
  return (
    await server.post("/incidents", { title: "进水", type: "暴雨", commanderId })
  ).body.id;
}

async function reportFlood(server, incidentId, zoneId, occurredAt = "2026-09-22T15:00:00+08:00") {
  await server.post(`/incidents/${incidentId}/reports`, {
    zoneId,
    reporterId: "staff-03",
    status: "进水",
    occurredAt,
  });
}

test("人员不能在冲突班次同时签到（跨事件）", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  const a = await createIncident(server);
  const b = await createIncident(server, "staff-02");

  await server.post(`/incidents/${a}/checkins`, {
    personId: "staff-03",
    shiftFrom: "2026-09-22T14:00:00+08:00",
    shiftTo: "2026-09-22T18:00:00+08:00",
  });
  const clash = await server.post(
    `/incidents/${b}/checkins`,
    {
      personId: "staff-03",
      shiftFrom: "2026-09-22T17:00:00+08:00",
      shiftTo: "2026-09-22T20:00:00+08:00",
    },
    409,
  );
  assert.equal(clash.body.error, "shift_conflict");

  // 首尾相接不算重叠；已结束的班次也释放冲突
  const adjacent = await server.post(`/incidents/${b}/checkins`, {
    personId: "staff-03",
    shiftFrom: "2026-09-22T18:00:00+08:00",
    shiftTo: "2026-09-22T20:00:00+08:00",
  });
  await server.post(`/incidents/${b}/checkins/${adjacent.body.id}/end`, { by: "staff-03" }, 200);
  const afterEnd = await server.post(`/incidents/${b}/checkins`, {
    personId: "staff-03",
    shiftFrom: "2026-09-22T18:30:00+08:00",
    shiftTo: "2026-09-22T19:30:00+08:00",
  });
  assert.ok(afterEnd.body.id);
});

test("资源分配不得超过实时可用量，跨事件共用库存并计入设备停用窗口", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  const a = await createIncident(server);
  const b = await createIncident(server, "staff-02");

  // 抽水泵总量 6；14:00-16:00 有 2 台保养停用，期间可用 4
  const ok = await server.post(`/incidents/${a}/allocations`, {
    by: "staff-06",
    equipmentType: "抽水泵",
    quantity: 4,
    from: "2026-09-22T14:30:00+08:00",
    to: "2026-09-22T15:30:00+08:00",
  });
  assert.ok(ok.body.id);

  // 事件 B 在重叠时段再要 1 台：4(已分)+2(停用)=6，超出
  const over = await server.post(
    `/incidents/${b}/allocations`,
    {
      by: "staff-07",
      equipmentType: "抽水泵",
      quantity: 1,
      from: "2026-09-22T15:00:00+08:00",
      to: "2026-09-22T15:30:00+08:00",
    },
    409,
  );
  assert.equal(over.body.error, "insufficient_availability");
  assert.equal(over.body.details.available, 0);

  // 16:30 停用结束，只剩事件 A 的 4 台？A 15:30 结束，所以可用 6
  const evening = await server.post(`/incidents/${b}/allocations`, {
    by: "staff-07",
    equipmentType: "抽水泵",
    quantity: 6,
    from: "2026-09-22T16:30:00+08:00",
    to: "2026-09-22T17:00:00+08:00",
  });
  assert.ok(evening.body.id);

  // 实时库存视图：15:00 时 4 已分、2 停用、0 可用
  const view = await server.get(`/incidents/${a}/resources?at=2026-09-22T15:00:00%2B08:00`);
  const pumps = view.body.resources.find((r) => r.type === "抽水泵");
  assert.equal(pumps.totalQuantity, 6);
  assert.equal(pumps.allocatedNow, 4);
  assert.equal(pumps.unavailableNow, 2);
  assert.equal(pumps.availableNow, 0);

  // 释放后可用量回升
  await server.post(`/incidents/${a}/allocations/${ok.body.id}/release`, { by: "staff-06" }, 200);
  const released = await server.post(`/incidents/${a}/allocations`, {
    by: "staff-06",
    equipmentType: "抽水泵",
    quantity: 4,
    from: "2026-09-22T15:00:00+08:00",
    to: "2026-09-22T15:30:00+08:00",
  });
  assert.ok(released.body.id);
});

test("危险区域封锁后普通调度被拒，紧急替代路线必须有值班长批准和失效时间", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  const incidentId = await createIncident(server);
  await reportFlood(server, incidentId, "B2-走廊");

  // 非值班长不能封锁
  await server.post(
    `/incidents/${incidentId}/zones/B2-走廊/seal`,
    { by: "staff-03", reason: "积水漏电风险" },
    403,
  );
  await server.post(`/incidents/${incidentId}/zones/B2-走廊/seal`, {
    by: "staff-01",
    reason: "积水漏电风险",
  });

  // 普通路线经过封锁区 → 拒绝
  const normalRoute = await server.post(
    `/incidents/${incidentId}/routes`,
    { by: "staff-03", fromZoneId: "B2-01", toZoneId: "B1-楼梯间", waypoints: ["B2-走廊"] },
    409,
  );
  assert.equal(normalRoute.body.error, "zone_sealed");
  // 在封锁区下动作也被拒
  const blockedAction = await server.post(
    `/incidents/${incidentId}/zones/B2-走廊/actions`,
    { by: "staff-03", type: "巡查", description: "进走廊查看" },
    409,
  );
  assert.equal(blockedAction.body.error, "zone_sealed");
  // 设备也不能调度进封锁区
  const blockedAlloc = await server.post(
    `/incidents/${incidentId}/allocations`,
    {
      by: "staff-06",
      equipmentType: "抽水泵",
      quantity: 1,
      from: "2026-09-22T15:00:00+08:00",
      to: "2026-09-22T16:00:00+08:00",
      zoneId: "B2-走廊",
    },
    409,
  );
  assert.equal(blockedAlloc.body.error, "zone_sealed");

  // 紧急替代路线缺批准人/失效时间 → 拒绝
  await server.post(
    `/incidents/${incidentId}/routes`,
    { by: "staff-03", fromZoneId: "B2-01", toZoneId: "B1-楼梯间", emergency: true },
    400,
  );
  await server.post(
    `/incidents/${incidentId}/routes`,
    {
      by: "staff-03",
      fromZoneId: "B2-01",
      toZoneId: "B1-楼梯间",
      emergency: true,
      approvedBy: "staff-01",
    },
    400,
  );
  // 非值班长批准无效
  await server.post(
    `/incidents/${incidentId}/routes`,
    {
      by: "staff-03",
      fromZoneId: "B2-01",
      toZoneId: "B1-楼梯间",
      emergency: true,
      approvedBy: "staff-03",
      expiresAt: "2026-09-22T18:00:00+08:00",
    },
    403,
  );
  const emergencyRoute = await server.post(`/incidents/${incidentId}/routes`, {
    by: "staff-03",
    fromZoneId: "B2-01",
    toZoneId: "B1-楼梯间",
    emergency: true,
    approvedBy: "staff-01",
    expiresAt: "2026-09-22T18:00:00+08:00",
  });
  assert.equal(emergencyRoute.body.approvedBy, "staff-01");
  assert.equal(emergencyRoute.body.expiresAt, "2026-09-22T10:00:00.000Z");

  // 失效后路线不可用
  server.setTime(Date.parse("2026-09-22T18:30:00+08:00"));
  const expired = await server.post(
    `/incidents/${incidentId}/transfers`,
    { by: "staff-03", routeId: emergencyRoute.body.id, autoSelect: { count: 1 } },
    409,
  );
  assert.equal(expired.body.error, "route_expired");
});

test("受潮文物按脆弱等级与区域严重度计算转移优先级", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  const incidentId = await createIncident(server);
  await reportFlood(server, incidentId, "B2-02");
  const priority = await server.get(`/incidents/${incidentId}/zones/B2-02/transfer-priority`);
  const scores = priority.body.artifacts.map((a) => a.priorityScore);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  // 进水严重度 2；二级陶瓷 2×2=4，三级陶器 1×2=2
  const threeColor = priority.body.artifacts.find((a) => a.id === "artifact-0005");
  assert.equal(threeColor.priorityScore, 4);
  const pottery = priority.body.artifacts.find((a) => a.id === "artifact-0008");
  assert.equal(pottery.priorityScore, 2);
});

test("转移批次完整轨迹、签收与重复转移防护", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  const incidentId = await createIncident(server);
  await reportFlood(server, incidentId, "B2-01");
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
      artifactIds: ["artifact-0001", "artifact-0004"],
    })
  ).body;
  // 批次内按优先级排序：一级书画在前
  assert.deepEqual(transfer.artifactIds, ["artifact-0001", "artifact-0004"]);
  assert.deepEqual(transfer.trajectory.map((t) => t.event), ["created"]);
  assert.equal(transfer.status, "prepared");

  // 在途文物不能进入另一个批次
  const dup = await server.post(
    `/incidents/${incidentId}/transfers`,
    { by: "staff-03", routeId: route.id, artifactIds: ["artifact-0001"] },
    409,
  );
  assert.equal(dup.body.error, "artifact_in_transit");

  // 状态机：不能跳步
  await server.post(`/incidents/${incidentId}/transfers/${transfer.id}/signoff`, { by: "staff-04" }, 409);

  const departed = await server.post(`/incidents/${incidentId}/transfers/${transfer.id}/depart`, { by: "staff-03" }, 200);
  assert.equal(departed.body.status, "departed");
  const arrived = await server.post(`/incidents/${incidentId}/transfers/${transfer.id}/arrive`, { by: "staff-03" }, 200);
  assert.equal(arrived.body.status, "arrived");
  const signed = await server.post(`/incidents/${incidentId}/transfers/${transfer.id}/signoff`, {
    by: "staff-04",
    condition: "外包装受潮，文物本体完好",
  }, 200);
  assert.equal(signed.body.status, "signed");
  assert.equal(signed.body.signedCondition, "外包装受潮，文物本体完好");
  assert.deepEqual(
    signed.body.trajectory.map((t) => t.event),
    ["created", "departed", "arrived", "signed"],
  );

  // 签收后文物位置更新，可在新区域再次转移
  const stillThere = await server.get(`/incidents/${incidentId}/zones/B1-缓冲间/transfer-priority`);
  assert.ok(stillThere.body.artifacts.some((a) => a.id === "artifact-0001"));
  assert.equal((await server.get(`/incidents/${incidentId}/pending-signoffs`)).body.pending.length, 0);
});

test("区域看板展示负责人、未完成动作和批次轨迹", async (context) => {
  const server = await startServer();
  context.after(() => server.close());
  const incidentId = await createIncident(server);
  await server.post(`/incidents/${incidentId}/checkins`, {
    personId: "staff-03",
    shiftFrom: "2026-09-22T14:00:00+08:00",
    shiftTo: "2026-09-22T20:00:00+08:00",
  });
  await reportFlood(server, incidentId, "B2-01");
  await server.post(`/incidents/${incidentId}/zones/B2-01/owner`, {
    personId: "staff-03",
    by: "staff-01",
  });
  const action = await server.post(`/incidents/${incidentId}/zones/B2-01/actions`, {
    by: "staff-03",
    type: "沙袋封堵",
    description: "库房门口堆两层沙袋",
  });
  const board = await server.get(`/incidents/${incidentId}/zones/B2-01/board`);
  assert.equal(board.body.owner.personId, "staff-03");
  assert.equal(board.body.owner.name, "张文博");
  assert.equal(board.body.openActions.length, 1);
  assert.equal(board.body.openActions[0].id, action.body.id);

  await server.post(`/incidents/${incidentId}/actions/${action.body.id}/complete`, {
    by: "staff-03",
    note: "已完成",
  }, 200);
  const board2 = await server.get(`/incidents/${incidentId}/zones/B2-01/board`);
  assert.equal(board2.body.openActions.length, 0);

  // 未签到人员不能当负责人
  const notCheckedIn = await server.post(
    `/incidents/${incidentId}/zones/B2-02/owner`,
    { personId: "staff-04", by: "staff-01" },
    409,
  );
  assert.equal(notCheckedIn.body.error, "not_checked_in");
});
