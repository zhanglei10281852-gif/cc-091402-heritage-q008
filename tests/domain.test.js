import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeService, FakeClock, PEOPLE, t, D, openIncident, checkInAndAssign, assertThrowsCode, seed } from "./helpers.js";
import { EventStore } from "../src/store.js";
import { DisasterService } from "../src/domain.js";

// ---------- 1. 冲突上报合并，保留原始证据 ----------
test("同一房间重复/冲突上报：按发生时间合并，原始证据全部保留", () => {
  const { service, clock } = makeService();
  clock.set(t(9));
  const inc = openIncident(service);

  // 08:10 王芳电话记录：B1-A-01 进水
  service.reportRoom(inc.id, {
    roomId: "B1-A-01", status: "flooded", waterLevelCm: 12,
    source: "phone", reporterCaller: "内线8101", actorPersonId: PEOPLE.wang,
    occurredAt: t(8, 10),
  });
  // 08:15 陈静电话：同一房间报"干燥"（相互矛盾的电话记录）
  service.reportRoom(inc.id, {
    roomId: "B1-A-01", status: "dry", source: "phone", reporterCaller: "内线8102",
    actorPersonId: PEOPLE.chen, occurredAt: t(8, 15),
  });

  let a = service.getAssessment(inc.id, "B1-A-01");
  assert.equal(a.current.status, "dry"); // 发生时间更新者为准
  assert.equal(a.evidence.length, 2);
  assert.equal(a.conflicts.length, 1); // 旧的 flooded 与当前 dry 矛盾
  assert.equal(a.conflicts[0].status, "flooded");
  assert.equal(a.conflicts[0].reporterCaller, "内线8101"); // 原始证据保留

  // 08:20 复核：确认严重进水 critical，当前状态翻案
  service.reportRoom(inc.id, {
    roomId: "B1-A-01", status: "critical", waterLevelCm: 30,
    source: "field", actorPersonId: PEOPLE.commander, occurredAt: t(8, 20),
  });
  a = service.getAssessment(inc.id, "B1-A-01");
  assert.equal(a.current.status, "critical");
  assert.equal(a.current.waterLevelCm, 30);
  assert.equal(a.evidence.length, 3, "所有原始上报保留");
  // dry 与 critical 相差 3 级，仍标记为冲突证据；flooded 与 critical 相差 1，不再冲突
  const dryEvidence = a.evidence.find((e) => e.status === "dry");
  const floodedEvidence = a.evidence.find((e) => e.status === "flooded");
  assert.equal(dryEvidence.contradictsCurrent, true);
  assert.equal(floodedEvidence.contradictsCurrent, false);
});

test("网络恢复后的补报按发生时间重排，而非接收顺序", () => {
  const { service, clock } = makeService();
  const inc = openIncident(service);

  clock.set(t(9, 0)); // 当前 09:00，网络刚恢复
  // 08:05 的旧报告晚到
  service.reportRoom(inc.id, { roomId: "B1-B-01", status: "seepage", actorPersonId: PEOPLE.zhao, occurredAt: t(8, 5) });
  // 08:30 的报告也晚到
  service.reportRoom(inc.id, { roomId: "B1-B-01", status: "flooded", actorPersonId: PEOPLE.zhao, occurredAt: t(8, 30) });

  const a = service.getAssessment(inc.id, "B1-B-01");
  assert.equal(a.current.status, "flooded", "以发生时间最新为准，而非最后接收");
  assert.deepEqual(a.evidence.map((e) => e.status), ["seepage", "flooded"], "证据按发生时间排序");
  assert.ok(ms(a.evidence[0].receivedAt) >= ms(t(9, 0)));

  const tl = service.timeline(inc.id);
  const reports = tl.filter((e) => e.type === "room.reported");
  assert.deepEqual(reports.map((e) => Date.parse(e.at)), [ms(t(8, 5)), ms(t(8, 30))], "时间线按发生时间重排");
  // 落盘序号仍反映真实接收顺序，可审计
  assert.ok(reports[0].seq < reports[1].seq);
});

function ms(iso) {
  return Date.parse(iso);
}

// ---------- 2. 资源：容量 + 可用时段 ----------
test("资源分配不能超过实时可用量，跨并行事件统一核算", () => {
  const { service } = makeService();
  const inc1 = openIncident(service, { title: "事件一" });
  const inc2 = openIncident(service, { title: "事件二" });

  const alloc = (incidentId, qty) =>
    service.allocateResource(incidentId, {
      resourceId: "RES-PUMP", quantity: qty,
      startAt: t(10), endAt: t(12), roomId: "B1-X-01", actorPersonId: PEOPLE.zhao,
    });

  alloc(inc1.id, 1);
  alloc(inc2.id, 1); // 共 2 台，恰好满
  assertThrowsCode(() => alloc(inc1.id, 1), "capacity_exceeded", 409);

  const avail = service.resourceAvailability("RES-PUMP", t(10), t(12));
  assert.equal(avail.allocated, 2);
  assert.equal(avail.available, 0);
  // 不重叠时段仍可分配满额
  const later = service.allocateResource(inc1.id, {
    resourceId: "RES-PUMP", quantity: 2, startAt: t(13), endAt: t(15),
    roomId: "B1-X-01", actorPersonId: PEOPLE.zhao,
  });
  assert.ok(later.id);
  // 仅部分重叠（11-13 与两条分配都冲突）也不行
  assertThrowsCode(
    () => service.allocateResource(inc2.id, {
      resourceId: "RES-PUMP", quantity: 1, startAt: t(11), endAt: t(13, 30),
      roomId: "B1-X-01", actorPersonId: PEOPLE.zhao,
    }),
    "capacity_exceeded", 409
  );
});

test("设备只能在可用时段内调度（发电机 08:00-22:00）", () => {
  const { service } = makeService();
  const inc = openIncident(service);
  const base = { resourceId: "RES-GEN", quantity: 1, roomId: "B1-C-01", actorPersonId: PEOPLE.zhao };
  assertThrowsCode(() => service.allocateResource(inc.id, { ...base, startAt: t(6), endAt: t(9) }), "outside_window", 409);
  assertThrowsCode(() => service.allocateResource(inc.id, { ...base, startAt: t(20), endAt: t(23) }), "outside_window", 409);
  const ok = service.allocateResource(inc.id, { ...base, startAt: t(10), endAt: t(12) });
  assert.ok(ok.id);
  // 除湿机 always 窗口，任何时段都可
  const dh = service.allocateResource(inc.id, {
    resourceId: "RES-DEHUM", quantity: 1, startAt: t(2), endAt: t(4), roomId: "B1-A-02", actorPersonId: PEOPLE.zhao,
  });
  assert.ok(dh.id);
});

test("取消分配后容量即时释放", () => {
  const { service } = makeService();
  const inc = openIncident(service);
  const a1 = service.allocateResource(inc.id, {
    resourceId: "RES-PUMP", quantity: 2, startAt: t(10), endAt: t(12), actorPersonId: PEOPLE.zhao,
  });
  assertThrowsCode(
    () => service.allocateResource(inc.id, { resourceId: "RES-PUMP", quantity: 1, startAt: t(10), endAt: t(12), actorPersonId: PEOPLE.zhao }),
    "capacity_exceeded", 409
  );
  service.cancelAllocation(inc.id, a1.id, { actorPersonId: PEOPLE.zhao });
  const a2 = service.allocateResource(inc.id, {
    resourceId: "RES-PUMP", quantity: 2, startAt: t(10), endAt: t(12), actorPersonId: PEOPLE.zhao,
  });
  assert.ok(a2.id);
});

// ---------- 3. 封锁 ----------
test("危险区域封锁后普通调度不能覆盖，值班长紧急作业例外", () => {
  const { service } = makeService();
  const inc = openIncident(service);
  service.lockScope(inc.id, {
    scope: "zone", targetId: "B1-C", reason: "配电室漏电风险",
    actorPersonId: PEOPLE.commander,
  });

  // 普通人员向封锁分区下调度 → 409
  assertThrowsCode(
    () => service.allocateResource(inc.id, {
      resourceId: "RES-PUMP", quantity: 1, startAt: t(10), endAt: t(11),
      zoneId: "B1-C", actorPersonId: PEOPLE.zhao,
    }),
    "zone_locked", 409
  );
  // 普通路线经过封锁分区 → 拒绝，要求紧急路线
  assertThrowsCode(
    () => service.activateRoute(inc.id, {
      zonePath: ["B1-A", "B1-X", "B1-C"], actorPersonId: PEOPLE.liu,
    }),
    "zone_locked", 409
  );
  // 重复封锁 → 409
  assertThrowsCode(
    () => service.lockScope(inc.id, { scope: "zone", targetId: "B1-C", reason: "再次", actorPersonId: PEOPLE.commander }),
    "already_locked", 409
  );
  // 非值班长不能封锁
  assertThrowsCode(
    () => service.lockScope(inc.id, { scope: "room", targetId: "B1-B-01", reason: "x", actorPersonId: PEOPLE.wang }),
    "forbidden", 403
  );
});

test("紧急替代路线必须记录批准人与失效时间，过期即不可用", () => {
  const { service } = makeService();
  const inc = openIncident(service);
  service.lockScope(inc.id, { scope: "zone", targetId: "B1-X", reason: "走廊结构风险", actorPersonId: PEOPLE.commander });

  // 缺少批准人/失效时间
  assertThrowsCode(
    () => service.activateRoute(inc.id, { zonePath: ["B1-A", "B1-X", "G1"], kind: "emergency", actorPersonId: PEOPLE.liu }),
    "missing_field"
  );
  // 保护人员无权批准
  assertThrowsCode(
    () => service.activateRoute(inc.id, {
      zonePath: ["B1-A", "B1-X", "G1"], kind: "emergency",
      approvedByPersonId: PEOPLE.wang, validUntil: t(12), actorPersonId: PEOPLE.liu,
    }),
    "forbidden", 403
  );

  const route = service.activateRoute(inc.id, {
    zonePath: ["B1-A", "B1-X", "G1"], kind: "emergency", reason: "电梯井被淹，绕行楼梯",
    approvedByPersonId: PEOPLE.commander, validUntil: t(12), actorPersonId: PEOPLE.liu,
  });
  assert.equal(route.approvedByPersonId, PEOPLE.commander);
  assert.equal(Date.parse(route.validUntil), Date.parse(t(12)));

  // 失效时间后路线不可用于转移（在 createTransfer/出发时校验）
  checkInAndAssign(service, inc.id, PEOPLE.wang, "zone_lead", "B1-A");
  const batch = service.createTransfer(inc.id, {
    artifactIds: ["ART-001"], routeId: route.id, toRoomId: "G1-01",
    leaderPersonId: PEOPLE.wang, actorPersonId: PEOPLE.commander,
  });
  assert.ok(batch.id);
  // 11:00 出发可以
  service.recordTransferEvent(batch.id, { event: "depart", leaderPersonId: PEOPLE.wang, at: t(11), actorPersonId: PEOPLE.wang });
  service.recordTransferEvent(batch.id, { event: "arrive", at: t(11, 30), actorPersonId: PEOPLE.wang });

  // 第二个批次 12:00 后出发：路线失效
  const batch2 = service.createTransfer(inc.id, {
    artifactIds: ["ART-002"], routeId: route.id, toRoomId: "G1-01",
    leaderPersonId: PEOPLE.wang, actorPersonId: PEOPLE.commander,
  });
  assertThrowsCode(
    () => service.recordTransferEvent(batch2.id, { event: "depart", leaderPersonId: PEOPLE.wang, at: t(12, 1), actorPersonId: PEOPLE.wang }),
    "route_unavailable", 409
  );
});

test("定时封锁到期自动失效，人工解封后可恢复普通调度", () => {
  const { service } = makeService();
  const inc = openIncident(service);
  service.lockScope(inc.id, {
    scope: "room", targetId: "B1-C-02", reason: "短时拉闸",
    unlockAt: t(10), actorPersonId: PEOPLE.commander,
  });
  assert.equal(service.isLockedAt("room", "B1-C-02", t(9, 59)), true);
  assert.equal(service.isLockedAt("room", "B1-C-02", t(10)), false);
  service.unlockScope(inc.id, { scope: "room", targetId: "B1-C-02", actorPersonId: PEOPLE.commander, at: t(9, 30) });
  assert.equal(service.isLockedAt("room", "B1-C-02", t(9, 45)), false);
});

// ---------- 4. 多事件并行 + 人员/设备冲突 ----------
test("多个事件并行，但人员不能同时出现在冲突班次", () => {
  const { service } = makeService();
  const inc1 = openIncident(service, { title: "事件一" });
  const inc2 = openIncident(service, { title: "事件二" });
  checkInAndAssign(service, inc1.id, PEOPLE.wang, "patrol", "B1-A", t(8), t(12));
  // 王芳不能在另一事件的重叠时段再排班（冲突检测跨事件，先于签到校验）
  assertThrowsCode(
    () => service.assignPerson(inc2.id, {
      personId: PEOPLE.wang, duty: "patrol", zoneId: "G1",
      startAt: t(11), endAt: t(15), actorPersonId: PEOPLE.commander,
    }),
    "assignment_conflict", 409
  );
  // 同一时间不能在两个事件重复签到（一次只能在一个岗位签到）
  assertThrowsCode(
    () => service.checkIn(PEOPLE.wang, { incidentId: inc2.id, actorPersonId: PEOPLE.wang }),
    "already_checked_in", 409
  );
  // 不重叠班次可以（先签退再签到新事件）
  service.checkOut(PEOPLE.wang, { actorPersonId: PEOPLE.wang, at: t(12) });
  service.checkIn(PEOPLE.wang, { incidentId: inc2.id, at: t(12, 1), actorPersonId: PEOPLE.wang });
  const asg = service.assignPerson(inc2.id, {
    personId: PEOPLE.wang, duty: "patrol", zoneId: "G1", startAt: t(12, 30), endAt: t(18), actorPersonId: PEOPLE.commander,
  });
  assert.ok(asg.id);
  // 排班必须被签到区间覆盖
  assertThrowsCode(
    () => service.assignPerson(inc2.id, {
      personId: PEOPLE.chen, duty: "patrol", zoneId: "G1",
      startAt: t(12), endAt: t(18), actorPersonId: PEOPLE.commander,
    }),
    "not_checked_in", 409
  );
});

test("同一设备不能在重叠时段超量分配到两个事件", () => {
  const { service } = makeService();
  const inc1 = openIncident(service);
  const inc2 = openIncident(service);
  service.allocateResource(inc1.id, {
    resourceId: "RES-GEN", quantity: 1, startAt: t(10), endAt: t(14), actorPersonId: PEOPLE.zhao,
  });
  assertThrowsCode(
    () => service.allocateResource(inc2.id, {
      resourceId: "RES-GEN", quantity: 1, startAt: t(13), endAt: t(16), actorPersonId: PEOPLE.zhao,
    }),
    "capacity_exceeded", 409
  );
});

// ---------- 5. 转移批次完整轨迹 ----------
test("转移批次：优先级、逐件签收、完整轨迹与房间更新", () => {
  const { service } = makeService();
  const inc = openIncident(service);
  checkInAndAssign(service, inc.id, PEOPLE.wang, "zone_lead", "B1-A");
  const route = service.activateRoute(inc.id, {
    zonePath: ["B1-A", "B1-X", "G1"], toRoomId: "G1-01", actorPersonId: PEOPLE.commander,
  });

  // ART-003 极脆弱(v1) + ART-004 脆弱(v2)，同在 B1-A-02：默认优先级按最脆弱 = 4
  const batch = service.createTransfer(inc.id, {
    artifactIds: ["ART-003", "ART-004"], routeId: route.id,
    leaderPersonId: PEOPLE.wang, actorPersonId: PEOPLE.commander,
  });
  assert.equal(batch.priority, 4);
  assert.equal(batch.vulnerabilityWorst, 1);
  // 同一文物不能重复进入在途批次
  assertThrowsCode(
    () => service.createTransfer(inc.id, {
      artifactIds: ["ART-003"], routeId: route.id, leaderPersonId: PEOPLE.wang, actorPersonId: PEOPLE.commander,
    }),
    "already_in_transit", 409
  );

  service.recordTransferEvent(batch.id, { event: "depart", at: t(9), leaderPersonId: PEOPLE.wang, actorPersonId: PEOPLE.wang });
  service.recordTransferEvent(batch.id, { event: "arrive", at: t(9, 40), actorPersonId: PEOPLE.wang });
  // 未全部签收不能完成
  service.recordTransferEvent(batch.id, { event: "confirm", artifactId: "ART-003", at: t(9, 45), conditionNote: "卷宗边角水浸", actorPersonId: PEOPLE.chen });
  assertThrowsCode(() => service.recordTransferEvent(batch.id, { event: "complete", at: t(9, 50), actorPersonId: PEOPLE.wang }), "unconfirmed_artifacts", 409);
  service.recordTransferEvent(batch.id, { event: "confirm", artifactId: "ART-004", at: t(9, 46), actorPersonId: PEOPLE.chen });
  service.recordTransferEvent(batch.id, { event: "complete", at: t(9, 50), actorPersonId: PEOPLE.wang });

  const traj = service.transferTrajectory(batch.id);
  assert.deepEqual(traj.events.map((e) => e.event), [
    "transfer.created", "transfer.departed", "transfer.arrived",
    "transfer.artifactConfirmed", "transfer.artifactConfirmed", "transfer.completed",
  ]);
  assert.equal(traj.batch.status, "completed");
  // 完成后文物房间更新到 G1-01，可再次转移
  assert.equal(service.state.artifacts.get("ART-003").roomId, "G1-01");
  assert.equal(service.state.artifacts.get("ART-003").batchId, null);
});

test("批次出发时负责人必须有有效排班", () => {
  const { service } = makeService();
  const inc = openIncident(service);
  checkInAndAssign(service, inc.id, PEOPLE.chen, "zone_lead", "B1-A", t(8), t(10));
  const route = service.activateRoute(inc.id, { zonePath: ["B1-A", "B1-X", "G1"], toRoomId: "G1-01", actorPersonId: PEOPLE.commander });
  const batch = service.createTransfer(inc.id, {
    artifactIds: ["ART-003"], routeId: route.id, leaderPersonId: PEOPLE.chen, actorPersonId: PEOPLE.commander,
  });
  assertThrowsCode(
    () => service.recordTransferEvent(batch.id, { event: "depart", leaderPersonId: PEOPLE.chen, at: t(10, 1), actorPersonId: PEOPLE.chen }),
    "no_duty", 409
  );
});

// ---------- 6. 区域视图：负责人、未完成动作 ----------
test("区域视图展示当前负责人与未完成动作", () => {
  const { service, clock } = makeService();
  const inc = openIncident(service);
  checkInAndAssign(service, inc.id, PEOPLE.wang, "zone_lead", "B1-A", t(8), t(12));
  checkInAndAssign(service, inc.id, PEOPLE.chen, "salvage", "B1-A", t(8), t(12));
  service.createAction(inc.id, { title: "封堵书画库门坎", kind: "sandbag", roomId: "B1-A-01", actorPersonId: PEOPLE.commander });
  service.createAction(inc.id, {
    title: "转移前拍照取证", roomId: "B1-A-01",
    dueAt: t(9), actorPersonId: PEOPLE.commander,
  });

  clock.set(t(10));
  const view = service.zoneView("B1-A", inc.id);
  assert.equal(view.currentLeader.name, "王芳");
  assert.equal(view.openActions.length, 2);

  // 负责人班次结束后视图无负责人
  clock.set(t(12, 1));
  const later = service.zoneView("B1-A", inc.id);
  assert.equal(later.currentLeader, null);
});

// ---------- 7. 演练案例生成动作 ----------
test("演练案例一键生成处置动作", () => {
  const { service } = makeService();
  const inc = openIncident(service);
  const { actionIds } = service.instantiatePlaybook(inc.id, { drillId: "DRILL-2025-B1", actorPersonId: PEOPLE.commander });
  assert.equal(actionIds.length, seed.drillCases[0].playbook.length);
  const detail = service.incidentDetail(inc.id);
  const titles = detail.openActions.map((a) => a.title);
  assert.ok(titles.includes("优先转移极脆弱书画至一层大厅"));
});

// ---------- 8. 重启恢复：提醒 + 待签收任务不丢 ----------
test("重启后重放事件：待签收任务、到期提醒、批次轨迹全部恢复", () => {
  const dir = mkdtempSync(join(tmpdir(), "disaster-"));
  const file = join(dir, "events.jsonl");
  try {
    const clock1 = new FakeClock(t(8));
    let bundle = makeService(file, clock1);
    const inc = openIncident(bundle.service);
    checkInAndAssign(bundle.service, inc.id, PEOPLE.wang, "zone_lead", "B1-A");
    // 一个 08:30 到期的动作
    bundle.service.createAction(inc.id, { title: "切断配电室非必要电源", dueAt: t(8, 30), actorPersonId: PEOPLE.commander });
    bundle.service.raiseDueReminders(); // 未到期，无提醒
    assert.equal(bundle.service.pendingReminders().length, 0);

    clock1.set(t(9));
    bundle.service.raiseDueReminders(); // 到期产生提醒事件
    assert.equal(bundle.service.pendingReminders().length, 1);
    bundle.service.stop();
    assert.ok(existsSync(file));

    // 新进程：新时钟、新 store、重放
    const clock2 = new FakeClock(t(9, 30));
    const store2 = new EventStore(file, () => clock2.iso());
    const service2 = new DisasterService(store2, seed, () => clock2.iso());
    service2.startReminderLoop(10_000_000);

    const reminders = service2.pendingReminders();
    assert.equal(reminders.length, 1, "重启后提醒恢复");
    assert.equal(reminders[0].title, "切断配电室非必要电源");
    assert.equal(reminders[0].acknowledged, false);

    // 签收后不再出现在待提醒列表
    service2.acknowledgeAction(reminders[0].actionId, { actorPersonId: PEOPLE.wang });
    const detail = service2.incidentDetail(inc.id);
    const act = detail.openActions.find((a) => a.title === "切断配电室非必要电源");
    assert.ok(act.acknowledgedAt, "签不收状态持久化");
    assert.equal(service2.pendingReminders().filter((r) => r.actionId === act.id && !r.acknowledged).length, 0);

    // 负责人视图也恢复
    const view = service2.zoneView("B1-A", inc.id);
    assert.equal(view.currentLeader.name, "王芳");
    service2.stop();

    // 日志是只追加的 JSONL，每行一个事件
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.ok(lines.length >= 6);
    for (const line of lines) {
      const e = JSON.parse(line);
      assert.ok(e.seq && e.type && e.occurredAt);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("关闭事件后拒绝新的写入，查询仍可用", () => {
  const { service } = makeService();
  const inc = openIncident(service);
  service.closeIncident(inc.id, { actorPersonId: PEOPLE.commander });
  assertThrowsCode(
    () => service.reportRoom(inc.id, { roomId: "B1-A-01", status: "dry", actorPersonId: PEOPLE.commander }),
    "incident_closed", 409
  );
  const detail = service.incidentDetail(inc.id);
  assert.ok(detail.incident.closedAt);
});
