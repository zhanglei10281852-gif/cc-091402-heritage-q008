// 灾害响应领域模型：命令校验 + 事件投影（重放）。
// 所有状态变更都先校验、再以事件落盘，由 project() 统一应用；重启重放即可恢复。
import { newId, toTime, ms, overlaps, coveredByWindows, badRequest, requireFields } from "./util.js";

const AUTHORITY_ROLES = new Set(["值班长", "管理员"]);
const DEFAULT_ACTION_DUE_MINUTES = 60;

export class DisasterService {
  constructor(store, seed, clock = () => new Date().toISOString()) {
    this.store = store;
    this.seed = seed;
    this.clock = clock;
    this.state = freshState(seed);
    this._timer = null;
    store.start((event) => this.project(event));
  }

  get now() {
    return this.clock();
  }

  // ---------- 到期提醒扫描（重启后立即补扫，不丢提醒） ----------
  startReminderLoop(intervalMs = 15_000) {
    this.raiseDueReminders();
    this._timer = setInterval(() => this.raiseDueReminders(), intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.store.close();
  }

  // ================= 事件开关 =================
  openIncident(body) {
    requireFields(body, ["type", "title"]);
    const actor = this.person(body.actorPersonId);
    const commander = this.person(body.commanderPersonId ?? actor.id);
    const id = newId("inc");
    const at = toTime(body.at, () => ms(this.now));
    const zoneIds = [];
    for (const zid of body.zoneIds ?? []) {
      if (!this.zone(zid)) throw badRequest("unknown_zone", `未知分区: ${zid}`);
      zoneIds.push(zid);
    }
    return this.store.append(
      "incident.opened",
      { id, type: body.type, title: body.title, commanderPersonId: commander.id, zoneIds },
      { incidentId: id, actor: actor.id, occurredAt: at }
    ).data;
  }

  closeIncident(incidentId, body = {}) {
    const incident = this.requireOpen(incidentId);
    const actor = this.person(body.actorPersonId);
    if (!AUTHORITY_ROLES.has(actor.role)) throw badRequest("forbidden", "仅值班长/管理员可关闭事件", 403);
    return this.store.append(
      "incident.closed",
      { at: toTime(body.at, () => ms(this.now)) },
      { incidentId: incident.id, actor: actor.id }
    ).data;
  }

  // ================= 现场上报（冲突合并，保留原始证据） =================
  reportRoom(incidentId, body) {
    this.requireOpen(incidentId);
    requireFields(body, ["roomId", "status"]);
    const actor = this.person(body.actorPersonId);
    const room = this.room(body.roomId);
    const allowed = ["dry", "seepage", "flooded", "critical"];
    if (!allowed.includes(body.status)) {
      throw badRequest("invalid_status", `房间状态必须是: ${allowed.join("/")}`);
    }
    if (body.waterLevelCm !== undefined && (!Number.isFinite(Number(body.waterLevelCm)) || Number(body.waterLevelCm) < 0)) {
      throw badRequest("invalid_level", "waterLevelCm 必须是非负数字");
    }
    // 网络恢复后的补报：occurredAt 可早于当前时间，按发生时间而非接收时间裁定。
    const occurredAt = toTime(body.occurredAt ?? body.at, () => ms(this.now));
    if (ms(occurredAt) > ms(this.now) + 60_000) {
      throw badRequest("future_report", "上报发生时间不能晚于当前时间");
    }
    const assessment = this.state.assessments.get(incidentId)?.get(room.id);
    const current = assessment?.current ?? null;
    const report = {
      id: newId("rpt"),
      roomId: room.id,
      status: body.status,
      waterLevelCm: body.waterLevelCm ?? null,
      note: body.note ?? "",
      reporterPersonId: body.reporterPersonId ?? actor.id,
      reporterCaller: body.reporterCaller ?? null, // 电话来源（来显/记录人），原始证据的一部分
      source: body.source ?? "radio", // radio | phone | field
      occurredAt,
      receivedAt: this.now,
    };
    return this.store.append("room.reported", report, {
      incidentId,
      actor: actor.id,
      occurredAt,
    }).data;
  }

  getAssessment(incidentId, roomId) {
    this.incident(incidentId);
    this.room(roomId);
    const a = this.state.assessments.get(incidentId)?.get(roomId);
    if (!a) return { roomId, current: null, evidence: [], conflicts: [] };
    const evidence = [...a.evidence].sort((x, y) =>
      ms(x.occurredAt) === ms(y.occurredAt) ? x.seq - y.seq : ms(x.occurredAt) - ms(y.occurredAt)
    );
    return {
      roomId,
      current: a.current,
      evidence,
      conflicts: evidence.filter((e) => e.contradictsCurrent),
    };
  }

  // ================= 封锁 =================
  lockScope(incidentId, body) {
    this.requireOpen(incidentId);
    const actor = this.requireAuthority(body.actorPersonId, "封锁区域");
    requireFields(body, ["scope", "targetId", "reason"]);
    if (!["zone", "room"].includes(body.scope)) throw badRequest("invalid_scope", "scope 必须是 zone/room");
    if (body.scope === "zone") this.zone(body.targetId);
    else this.room(body.targetId);
    const key = `${body.scope}:${body.targetId}`;
    if (this.isLockedAt(body.scope, body.targetId, this.now)) {
      throw badRequest("already_locked", "该区域已在封锁中", 409);
    }
    const at = toTime(body.at, () => ms(this.now));
    const unlockAt = body.unlockAt ? toTime(body.unlockAt) : null;
    if (unlockAt && ms(unlockAt) <= ms(at)) throw badRequest("invalid_validity", "解封时间必须晚于封锁时间");
    return this.store.append(
      "zone.locked",
      {
        scope: body.scope,
        targetId: body.targetId,
        reason: body.reason,
        approvedByPersonId: actor.id,
        unlockAt,
      },
      { incidentId, actor: actor.id, occurredAt: at }
    ).data;
  }

  unlockScope(incidentId, body) {
    this.requireOpen(incidentId);
    const actor = this.requireAuthority(body.actorPersonId, "解除封锁");
    requireFields(body, ["scope", "targetId"]);
    const key = `${body.scope}:${body.targetId}`;
    if (!this.isLockedAt(body.scope, body.targetId, this.now)) {
      throw badRequest("not_locked", "该区域当前未封锁（或封锁已定时失效）", 404);
    }
    const at = toTime(body.at, () => ms(this.now));
    return this.store.append(
      "zone.unlocked",
      { scope: body.scope, targetId: body.targetId, reason: body.reason ?? "人工解除", approvedByPersonId: actor.id },
      { incidentId, actor: actor.id, occurredAt: at }
    ).data;
  }

  // 封锁在某时刻是否有效；定时封锁到期自动失效。
  isLockedAt(scope, targetId, at) {
    const lock = this.state.locks.get(`${scope}:${targetId}`);
    if (!lock) return false;
    if (lock.unlockAt && ms(at) >= ms(lock.unlockAt)) return false;
    return true;
  }

  // ================= 资源分配 =================
  allocateResource(incidentId, body) {
    this.requireOpen(incidentId);
    requireFields(body, ["resourceId", "quantity", "startAt", "endAt"]);
    const actor = this.person(body.actorPersonId);
    const resource = this.resource(body.resourceId);
    const qty = Number(body.quantity);
    if (!Number.isInteger(qty) || qty <= 0) throw badRequest("invalid_quantity", "数量必须是正整数");
    const startAt = toTime(body.startAt);
    const endAt = toTime(body.endAt);
    if (!(ms(endAt) > ms(startAt))) throw badRequest("invalid_interval", "结束时间必须晚于开始时间");
    const roomId = body.roomId ?? null;
    const zoneId = body.zoneId ?? null;
    if (roomId) this.room(roomId);
    if (zoneId) this.zone(zoneId);
    // 设备只能在其可用时段内被调度。
    if (!coveredByWindows(startAt, endAt, resource.windows)) {
      throw badRequest("outside_window", `设备 ${resource.name} 在该时段不可用`, 409);
    }
    // 分配不能超过实时可用量（跨所有并行事件统一核算）。
    const used = this.usedQuantity(resource.id, startAt, endAt, null);
    if (used + qty > resource.total) {
      throw badRequest(
        "capacity_exceeded",
        `${resource.name} 该时段已分配 ${used}/${resource.total}${resource.unit}，无法再分配 ${qty}`,
        409
      );
    }
    // 普通调度不能覆盖封锁区域（紧急作业须由值班长改走专项命令，见 routes/emergency）。
    if (roomId && this.isLockedAt("room", roomId, startAt)) {
      throw badRequest("zone_locked", `房间 ${roomId} 已封锁，普通调度禁止进入`, 409);
    }
    if (zoneId && this.isLockedAt("zone", zoneId, startAt)) {
      throw badRequest("zone_locked", `分区 ${zoneId} 已封锁，普通调度禁止进入`, 409);
    }
    const allocation = {
      id: newId("alloc"),
      resourceId: resource.id,
      quantity: qty,
      startAt,
      endAt,
      purpose: body.purpose ?? "",
      roomId,
      zoneId,
      byPersonId: actor.id,
    };
    return this.store.append("resource.allocated", allocation, { incidentId, actor: actor.id }).data;
  }

  cancelAllocation(incidentId, allocationId, body = {}) {
    this.requireOpen(incidentId);
    const actor = this.person(body.actorPersonId);
    const allocation = this.state.allocations.find((a) => a.id === allocationId && !a.cancelledAt);
    if (!allocation || allocation.incidentId !== incidentId) {
      throw badRequest("not_found", "未找到本事件下的有效分配", 404);
    }
    return this.store.append(
      "resource.allocationCancelled",
      { id: allocationId, at: toTime(body.at, () => ms(this.now)) },
      { incidentId, actor: actor.id }
    ).data;
  }

  resourceAvailability(resourceId, atIso, untilIso) {
    const resource = this.resource(resourceId);
    const at = toTime(atIso);
    const until = toTime(untilIso ?? atIso);
    if (!(ms(until) >= ms(at))) throw badRequest("invalid_interval", "until 不能早于 at");
    const used = this.usedQuantity(resource.id, at, until, null);
    return {
      resourceId: resource.id,
      name: resource.name,
      unit: resource.unit,
      total: resource.total,
      windows: resource.windows,
      interval: { startAt: at, endAt: until },
      allocated: used,
      available: Math.max(0, resource.total - used),
      withinOperatingWindows: coveredByWindows(at, until, resource.windows),
    };
  }

  usedQuantity(resourceId, startAt, endAt, excludeAllocationId) {
    return this.state.allocations
      .filter((a) => !a.cancelledAt && a.id !== excludeAllocationId && a.resourceId === resourceId)
      .filter((a) => overlaps(a.startAt, a.endAt, startAt, endAt))
      .reduce((sum, a) => sum + a.quantity, 0);
  }

  // ================= 人员签到与班次 =================
  checkIn(personId, body = {}) {
    const person = this.person(personId);
    requireFields(body, ["incidentId"]);
    const actor = this.person(body.actorPersonId ?? personId);
    this.requireOpen(body.incidentId);
    const open = this.openSession(personId);
    if (open) throw badRequest("already_checked_in", `该人员已在事件 ${open.incidentId} 签到且未签退`, 409);
    const at = toTime(body.at, () => ms(this.now));
    return this.store.append(
      "person.checkedIn",
      { personId: person.id, incidentId: body.incidentId },
      { incidentId: body.incidentId, actor: actor.id, occurredAt: at }
    ).data;
  }

  checkOut(personId, body = {}) {
    const person = this.person(personId);
    const actor = this.person(body.actorPersonId ?? personId);
    const open = this.openSession(personId);
    if (!open) throw badRequest("not_checked_in", "该人员当前未签到", 409);
    const at = toTime(body.at, () => ms(this.now));
    return this.store.append(
      "person.checkedOut",
      { personId: person.id },
      { incidentId: open.incidentId, actor: actor.id, occurredAt: at }
    ).data;
  }

  openSession(personId) {
    return (this.state.sessions.get(personId) ?? []).find((s) => !s.endAt) ?? null;
  }

  assignPerson(incidentId, body) {
    this.requireOpen(incidentId);
    requireFields(body, ["personId", "startAt", "endAt", "duty"]);
    const actor = this.person(body.actorPersonId);
    const person = this.person(body.personId);
    const startAt = toTime(body.startAt);
    const endAt = toTime(body.endAt);
    if (!(ms(endAt) > ms(startAt))) throw badRequest("invalid_interval", "结束时间必须晚于开始时间");
    const duty = String(body.duty);
    const zoneId = body.zoneId ?? null;
    if (zoneId) this.zone(zoneId);
    const roomId = body.roomId ?? null;
    if (roomId) this.room(roomId);

    // 同一人员不能同时出现在冲突班次（跨所有并行事件检测）。
    const clash = this.state.assignments.find(
      (a) => !a.cancelledAt && a.personId === person.id && overlaps(a.startAt, a.endAt, startAt, endAt)
    );
    if (clash) {
      throw badRequest(
        "assignment_conflict",
        `${person.name} 在 ${clash.startAt}~${clash.endAt} 已有班次（事件 ${clash.incidentId}：${clash.duty}）`,
        409
      );
    }
    // 值班区间必须被该人员的签到区间覆盖（签到针对人，并行事件间通用）。
    const covered = (this.state.sessions.get(person.id) ?? []).some(
      (s) => ms(s.startAt) <= ms(startAt) && (!s.endAt || ms(s.endAt) >= ms(endAt))
    );
    if (!covered) throw badRequest("not_checked_in", "排班区间必须被该人员的签到区间覆盖", 409);
    // 封锁区域不接受普通调度：进入封锁分区/房间的排班必须由值班长/管理员下达。
    const targetLocked =
      (roomId && this.isLockedAt("room", roomId, startAt)) ||
      (zoneId && this.isLockedAt("zone", zoneId, startAt));
    if (targetLocked && !AUTHORITY_ROLES.has(actor.role)) {
      throw badRequest("zone_locked", "目标区域已封锁，进入封锁区的排班须由值班长/管理员下达", 409);
    }

    const assignment = { id: newId("asg"), personId: person.id, duty, zoneId, roomId, startAt, endAt, note: body.note ?? "" };
    return this.store.append("person.assigned", assignment, { incidentId, actor: actor.id }).data;
  }

  cancelAssignment(incidentId, assignmentId, body = {}) {
    this.requireOpen(incidentId);
    const actor = this.person(body.actorPersonId);
    const a = this.state.assignments.find((x) => x.id === assignmentId && !x.cancelledAt);
    if (!a || a.incidentId !== incidentId) throw badRequest("not_found", "未找到本事件下的有效班次", 404);
    return this.store.append(
      "person.assignmentCancelled",
      { id: assignmentId, at: toTime(body.at, () => ms(this.now)) },
      { incidentId, actor: actor.id }
    ).data;
  }

  // ================= 路线（含紧急替代路线） =================
  activateRoute(incidentId, body) {
    this.requireOpen(incidentId);
    requireFields(body, ["zonePath"]);
    const actor = this.person(body.actorPersonId);
    const zonePath = body.zonePath;
    if (!Array.isArray(zonePath) || zonePath.length < 2) {
      throw badRequest("invalid_path", "zonePath 必须是至少两个分区的有序数组");
    }
    for (const zid of zonePath) this.zone(zid);
    // 路线必须沿建筑分区图相邻分区行进（紧急路线也要物理连通，只是允许穿越封锁分区）。
    for (let i = 0; i < zonePath.length - 1; i++) {
      if (!this.adjacent(zonePath[i], zonePath[i + 1])) {
        throw badRequest("disconnected_path", `路线在 ${zonePath[i]} → ${zonePath[i + 1]} 处不连通`);
      }
    }
    const kind = body.kind === "emergency" ? "emergency" : "normal";
    const at = toTime(body.at, () => ms(this.now));
    const lockedZones = zonePath.filter((zid) => this.isLockedAt("zone", zid, at));
    if (lockedZones.length > 0 && kind !== "emergency") {
      throw badRequest("zone_locked", `路线经过封锁分区 ${lockedZones.join(", ")}，须申请紧急替代路线`, 409);
    }
    const route = {
      id: newId("route"),
      zonePath,
      kind,
      reason: body.reason ?? "",
      fromRoomId: body.fromRoomId ?? null,
      toRoomId: body.toRoomId ?? null,
      activatedAt: at,
      approvedByPersonId: null,
      validUntil: null,
    };
    if (kind === "emergency") {
      // 紧急替代路线必须记录批准人与失效时间。
      requireFields(body, ["approvedByPersonId", "validUntil"]);
      const approver = this.requireAuthority(body.approvedByPersonId, "批准紧急替代路线");
      const validUntil = toTime(body.validUntil);
      if (ms(validUntil) <= ms(at)) throw badRequest("invalid_validity", "失效时间必须晚于启用时间");
      route.approvedByPersonId = approver.id;
      route.validUntil = validUntil;
    }
    return this.store.append("route.activated", route, { incidentId, actor: actor.id, occurredAt: at }).data;
  }

  closeRoute(incidentId, routeId, body = {}) {
    this.requireOpen(incidentId);
    const actor = this.person(body.actorPersonId);
    const route = this.state.routes.find((r) => r.id === routeId && !r.closedAt);
    if (!route || route.incidentId !== incidentId) throw badRequest("not_found", "未找到本事件下的有效路线", 404);
    return this.store.append(
      "route.closed",
      { id: routeId, at: toTime(body.at, () => ms(this.now)), reason: body.reason ?? "人工关闭" },
      { incidentId, actor: actor.id }
    ).data;
  }

  routeUsableAt(route, at) {
    if (!route || route.closedAt) return false;
    if (route.kind === "emergency" && ms(at) >= ms(route.validUntil)) return false; // 过期即失效
    return true;
  }

  // ================= 动作（待办/提醒/签收） =================
  createAction(incidentId, body) {
    this.requireOpen(incidentId);
    requireFields(body, ["title"]);
    const actor = this.person(body.actorPersonId);
    const roomId = body.roomId ?? null;
    if (roomId) this.room(roomId);
    const zoneId = body.zoneId ?? (roomId ? this.room(roomId).zoneId : null);
    if (zoneId) this.zone(zoneId);
    const createdAt = toTime(body.at, () => ms(this.now));
    const dueAt = body.dueAt
      ? toTime(body.dueAt)
      : new Date(ms(createdAt) + DEFAULT_ACTION_DUE_MINUTES * 60_000).toISOString();
    if (ms(dueAt) <= ms(createdAt)) throw badRequest("invalid_due", "截止时间必须晚于创建时间");
    // 封锁房间不接受普通调度下发；值班长/管理员可下达紧急处置动作。
    if (roomId && this.isLockedAt("room", roomId, createdAt) && !AUTHORITY_ROLES.has(actor.role)) {
      throw badRequest("zone_locked", `房间 ${roomId} 已封锁，普通调度禁止下发`, 409);
    }
    if (body.assigneePersonId) this.person(body.assigneePersonId);
    const action = {
      id: newId("act"),
      title: body.title,
      kind: body.kind ?? "general",
      roomId,
      zoneId,
      assigneePersonId: body.assigneePersonId ?? null,
      dueAt,
      requiresAck: body.requiresAck ?? true,
      source: body.source ?? "manual",
      createdAt,
      acknowledgedAt: null,
      completedAt: null,
      cancelledAt: null,
    };
    return this.store.append("action.created", action, { incidentId, actor: actor.id, occurredAt: createdAt }).data;
  }

  // 依据演练案例批量生成处置动作（动作进入事件流，重启不丢）。
  instantiatePlaybook(incidentId, body) {
    this.requireOpen(incidentId);
    requireFields(body, ["drillId"]);
    const actor = this.person(body.actorPersonId);
    const drill = this.seed.drillCases.find((d) => d.id === body.drillId);
    if (!drill) throw badRequest("unknown_drill", `未知演练案例: ${body.drillId}`, 404);
    const ids = [];
    for (const step of drill.playbook) {
      const action = {
        id: newId("act"),
        title: step.title,
        kind: step.type,
        roomId: step.roomId ?? null,
        zoneId: step.roomId ? this.room(step.roomId).zoneId : null,
        assigneePersonId: null,
        dueAt: new Date(ms(this.now) + (step.dueInMinutes ?? DEFAULT_ACTION_DUE_MINUTES) * 60_000).toISOString(),
        requiresAck: true,
        source: `playbook:${drill.id}`,
        createdAt: this.now,
        acknowledgedAt: null,
        completedAt: null,
        cancelledAt: null,
      };
      this.store.append("action.created", action, { incidentId, actor: actor.id });
      ids.push(action.id);
    }
    return { drillId: drill.id, actionIds: ids };
  }

  acknowledgeAction(actionId, body = {}) {
    const actor = this.person(body.actorPersonId);
    const action = this.action(actionId);
    if (action.acknowledgedAt) return { id: actionId, acknowledgedAt: action.acknowledgedAt, idempotent: true };
    return this.store.append(
      "action.acknowledged",
      { id: actionId, at: toTime(body.at, () => ms(this.now)) },
      { incidentId: action.incidentId, actor: actor.id }
    ).data;
  }

  completeAction(actionId, body = {}) {
    const actor = this.person(body.actorPersonId);
    const action = this.action(actionId);
    if (action.cancelledAt) throw badRequest("cancelled", "动作已取消", 409);
    if (action.completedAt) return { id: actionId, completedAt: action.completedAt, idempotent: true };
    return this.store.append(
      "action.completed",
      { id: actionId, at: toTime(body.at, () => ms(this.now)), note: body.note ?? "" },
      { incidentId: action.incidentId, actor: actor.id }
    ).data;
  }

  cancelAction(actionId, body = {}) {
    const actor = this.person(body.actorPersonId);
    const action = this.action(actionId);
    if (action.completedAt) throw badRequest("completed", "动作已完成，不可取消", 409);
    if (action.cancelledAt) return { id: actionId, cancelledAt: action.cancelledAt, idempotent: true };
    return this.store.append(
      "action.cancelled",
      { id: actionId, at: toTime(body.at, () => ms(this.now)), reason: body.reason ?? "" },
      { incidentId: action.incidentId, actor: actor.id }
    ).data;
  }

  raiseDueReminders() {
    const nowIso = this.now;
    for (const action of this.state.actions.values()) {
      if (action.completedAt || action.cancelledAt || action.remindedAt) continue;
      const incident = this.state.incidents.get(action.incidentId);
      if (incident?.closedAt) continue; // 已关闭事件不再产生新提醒
      if (ms(action.dueAt) <= ms(nowIso)) {
        this.store.append("reminder.raised", { actionId: action.id, dueAt: action.dueAt }, {
          incidentId: action.incidentId,
          occurredAt: nowIso,
        });
      }
    }
  }

  // 已提醒但尚未完成/签收的任务；重启后由事件重放恢复。
  pendingReminders() {
    return [...this.state.actions.values()]
      .filter((a) => a.remindedAt && !a.completedAt && !a.cancelledAt)
      .map((a) => ({
        actionId: a.id,
        incidentId: a.incidentId,
        title: a.title,
        kind: a.kind,
        zoneId: a.zoneId,
        roomId: a.roomId,
        assigneePersonId: a.assigneePersonId,
        dueAt: a.dueAt,
        remindedAt: a.remindedAt,
        requiresAck: a.requiresAck,
        acknowledged: Boolean(a.acknowledgedAt),
      }))
      .sort((a, b) => ms(a.dueAt) - ms(b.dueAt));
  }

  // ================= 转移批次 =================
  createTransfer(incidentId, body) {
    this.requireOpen(incidentId);
    requireFields(body, ["artifactIds", "routeId", "actorPersonId"]);
    const actor = this.person(body.actorPersonId);
    if (!Array.isArray(body.artifactIds) || body.artifactIds.length === 0) {
      throw badRequest("invalid_artifacts", "artifactIds 必须是非空数组");
    }
    const uniqueIds = [...new Set(body.artifactIds)];
    const artifacts = uniqueIds.map((id) => {
      const art = this.state.artifacts.get(id);
      if (!art) throw badRequest("unknown_artifact", `未知文物: ${id}`, 404);
      if (art.batchId) throw badRequest("already_in_transit", `文物 ${id} 已在转移批次 ${art.batchId} 中`, 409);
      return art;
    });
    const route = this.state.routes.find((r) => r.id === body.routeId);
    if (!route || route.incidentId !== incidentId) throw badRequest("unknown_route", "路线不存在或不属于本事件", 404);
    if (!this.routeUsableAt(route, this.now)) throw badRequest("route_unavailable", "路线已关闭或紧急路线已失效", 409);
    const fromRoomId = body.fromRoomId ?? this.commonRoom(artifacts);
    if (!fromRoomId) throw badRequest("missing_from_room", "文物不在同一房间，请显式提供 fromRoomId");
    this.room(fromRoomId);
    const toRoomId = body.toRoomId ?? route.toRoomId;
    if (!toRoomId) throw badRequest("missing_to_room", "请提供目的地房间 toRoomId");
    this.room(toRoomId);

    // 默认优先级：最脆弱文物决定（脆弱等级 1→优先级 4，4→优先级 1），可显式覆盖。
    const vulnerabilityWorst = Math.min(...artifacts.map((a) => a.vulnerability));
    const priority = Number(body.priority ?? 5 - vulnerabilityWorst);
    if (!Number.isInteger(priority) || priority < 1 || priority > 4) {
      throw badRequest("invalid_priority", "优先级必须是 1~4 的整数（1 最高）");
    }
    const batch = {
      id: newId("batch"),
      artifactIds: uniqueIds,
      vulnerabilityWorst,
      priority,
      fromRoomId,
      toRoomId,
      routeId: route.id,
      leaderPersonId: body.leaderPersonId ?? null,
      status: "created",
      createdAt: this.now,
      departedAt: null,
      arrivedAt: null,
      completedAt: null,
      cancelledAt: null,
      confirmedArtifactIds: [],
    };
    this.store.append("transfer.created", batch, { incidentId, actor: actor.id });
    return { ...batch };
  }

  recordTransferEvent(batchId, body) {
    requireFields(body, ["event", "actorPersonId"]);
    const actor = this.person(body.actorPersonId);
    const batch = this.state.transfers.get(batchId);
    if (!batch) throw badRequest("not_found", "未找到转移批次", 404);
    this.requireOpen(batch.incidentId);
    const at = toTime(body.at, () => ms(this.now));
    const event = body.event;

    if (event === "depart") {
      if (batch.status !== "created") throw badRequest("invalid_transition", `当前状态 ${batch.status} 不能出发`, 409);
      const leader = this.person(body.leaderPersonId ?? batch.leaderPersonId);
      // 负责人出发时刻必须有有效排班（意味着已签到且无冲突班次）。
      const duty = this.state.assignments.find(
        (a) =>
          !a.cancelledAt &&
          a.personId === leader.id &&
          a.incidentId === batch.incidentId &&
          ms(a.startAt) <= ms(at) &&
          ms(at) < ms(a.endAt)
      );
      if (!duty) throw badRequest("no_duty", "负责人在出发时刻没有有效排班", 409);
      const route = this.state.routes.find((r) => r.id === batch.routeId);
      if (!this.routeUsableAt(route, at)) throw badRequest("route_unavailable", "路线已关闭或紧急路线已失效", 409);
      return this.store.append(
        "transfer.departed",
        { id: batchId, leaderPersonId: leader.id, at },
        { incidentId: batch.incidentId, actor: actor.id, occurredAt: at }
      ).data;
    }
    if (event === "arrive") {
      if (batch.status !== "in_transit") throw badRequest("invalid_transition", `当前状态 ${batch.status} 不能到达`, 409);
      return this.store.append(
        "transfer.arrived",
        { id: batchId, at, toRoomId: body.toRoomId ?? batch.toRoomId },
        { incidentId: batch.incidentId, actor: actor.id, occurredAt: at }
      ).data;
    }
    if (event === "confirm") {
      requireFields(body, ["artifactId"]);
      if (!batch.artifactIds.includes(body.artifactId)) throw badRequest("unknown_artifact", "文物不在本批次", 404);
      if (batch.status !== "arrived") throw badRequest("invalid_transition", "文物须在批次到达后签收", 409);
      if (batch.confirmedArtifactIds.includes(body.artifactId)) {
        return { id: batchId, artifactId: body.artifactId, idempotent: true };
      }
      return this.store.append(
        "transfer.artifactConfirmed",
        { id: batchId, artifactId: body.artifactId, at, conditionNote: body.conditionNote ?? "" },
        { incidentId: batch.incidentId, actor: actor.id, occurredAt: at }
      ).data;
    }
    if (event === "complete") {
      if (batch.status !== "arrived") throw badRequest("invalid_transition", `当前状态 ${batch.status} 不能完成`, 409);
      const missing = batch.artifactIds.filter((id) => !batch.confirmedArtifactIds.includes(id));
      if (missing.length) throw badRequest("unconfirmed_artifacts", `尚有文物未逐件签收: ${missing.join(", ")}`, 409);
      return this.store.append(
        "transfer.completed",
        { id: batchId, at },
        { incidentId: batch.incidentId, actor: actor.id, occurredAt: at }
      ).data;
    }
    if (event === "cancel") {
      if (["completed", "cancelled"].includes(batch.status)) {
        throw badRequest("invalid_transition", `当前状态 ${batch.status} 不能取消`, 409);
      }
      return this.store.append(
        "transfer.cancelled",
        { id: batchId, at, reason: body.reason ?? "" },
        { incidentId: batch.incidentId, actor: actor.id, occurredAt: at }
      ).data;
    }
    throw badRequest("unknown_event", `未知批次事件: ${event}`);
  }

  transferTrajectory(batchId) {
    const batch = this.state.transfers.get(batchId);
    if (!batch) throw badRequest("not_found", "未找到转移批次", 404);
    const events = this.state.timeline
      .filter((e) => e.type.startsWith("transfer.") && e.data.id === batchId)
      .map((e) => ({ seq: e.seq, event: e.type, at: e.occurredAt, recordedAt: e.recordedAt, actor: e.actor, data: e.data }))
      .sort((a, b) => (ms(a.at) === ms(b.at) ? a.seq - b.seq : ms(a.at) - ms(b.at)));
    return { batch: summarizeBatch(batch, this.state), events };
  }

  // ================= 读模型 =================
  incidentDetail(incidentId) {
    const incident = this.incident(incidentId);
    const zones = new Set(incident.zoneIds);
    const assessments = this.state.assessments.get(incidentId);
    if (assessments) for (const roomId of assessments.keys()) zones.add(this.room(roomId).zoneId);
    for (const a of this.state.actions.values()) if (a.incidentId === incidentId && a.zoneId) zones.add(a.zoneId);

    return {
      incident: { ...incident },
      zones: [...zones].map((zid) => this.zoneView(zid, incidentId)),
      routes: this.state.routes.filter((r) => r.incidentId === incidentId).map((r) => ({ ...r })),
      openActions: [...this.state.actions.values()]
        .filter((a) => a.incidentId === incidentId && !a.completedAt && !a.cancelledAt)
        .map((a) => ({ ...a })),
      batches: [...this.state.transfers.values()]
        .filter((b) => b.incidentId === incidentId)
        .map((b) => summarizeBatch(b, this.state)),
      assignments: this.state.assignments.filter((a) => a.incidentId === incidentId).map((a) => ({ ...a })),
      allocations: this.state.allocations.filter((a) => a.incidentId === incidentId).map((a) => ({ ...a })),
    };
  }

  zoneView(zoneId, incidentId) {
    this.zone(zoneId);
    if (incidentId) this.incident(incidentId);
    const at = this.now;
    const leader = this.currentZoneLeader(zoneId, at);
    const rooms = this.state.roomsByZone.get(zoneId).map((room) => {
      const a = incidentId ? this.state.assessments.get(incidentId)?.get(room.id) : null;
      return {
        roomId: room.id,
        name: room.name,
        locked: this.isLockedAt("room", room.id, at),
        current: a?.current ?? null,
        evidenceCount: a?.evidence.length ?? 0,
        conflict: a ? a.evidence.some((e) => e.contradictsCurrent) : false,
      };
    });
    return {
      zoneId,
      name: this.zone(zoneId).name,
      locked: this.isLockedAt("zone", zoneId, at),
      currentLeader: leader
        ? { personId: leader.personId, name: this.person(leader.personId).name, assignmentId: leader.id, duty: leader.duty }
        : null,
      openActions: incidentId
        ? [...this.state.actions.values()]
            .filter((a) => a.incidentId === incidentId && a.zoneId === zoneId && !a.completedAt && !a.cancelledAt)
            .map((a) => ({
              id: a.id,
              title: a.title,
              kind: a.kind,
              roomId: a.roomId,
              assigneePersonId: a.assigneePersonId,
              dueAt: a.dueAt,
              acknowledged: Boolean(a.acknowledgedAt),
            }))
        : [],
      rooms,
    };
  }

  currentZoneLeader(zoneId, at) {
    const candidates = this.state.assignments
      .filter((a) => !a.cancelledAt && a.duty === "zone_lead" && a.zoneId === zoneId)
      .filter((a) => ms(a.startAt) <= ms(at) && ms(at) < ms(a.endAt))
      .sort((a, b) => (ms(a.startAt) === ms(b.startAt) ? b.seq - a.seq : ms(b.startAt) - ms(a.startAt)));
    return candidates[0] ?? null;
  }

  // 网络恢复后的补报在此按发生时间重排（并列按落盘序号）。
  timeline(incidentId) {
    this.incident(incidentId);
    return this.state.timeline
      .filter((e) => e.incidentId === incidentId)
      .map((e) => ({ seq: e.seq, type: e.type, at: e.occurredAt, recordedAt: e.recordedAt, actor: e.actor, data: e.data }))
      .sort((a, b) => (ms(a.at) === ms(b.at) ? a.seq - b.seq : ms(a.at) - ms(b.at)));
  }

  roster() {
    const at = this.now;
    return this.seed.people.map((p) => {
      const session = this.openSession(p.id);
      const duty = this.state.assignments
        .filter((a) => !a.cancelledAt && a.personId === p.id && ms(a.startAt) <= ms(at) && ms(at) < ms(a.endAt))
        .sort((a, b) => b.seq - a.seq)[0];
      return {
        personId: p.id,
        name: p.name,
        role: p.role,
        phone: p.phone,
        checkedIn: Boolean(session),
        session: session ? { incidentId: session.incidentId, startAt: session.startAt } : null,
        currentDuty: duty
          ? { assignmentId: duty.id, incidentId: duty.incidentId, duty: duty.duty, zoneId: duty.zoneId, roomId: duty.roomId }
          : null,
      };
    });
  }

  directory() {
    return {
      zones: this.seed.building.zones.map((z) => ({
        id: z.id,
        name: z.name,
        level: z.level,
        rooms: z.rooms.map((r) => ({ id: r.id, name: r.name })),
      })),
      adjacency: this.seed.building.adjacency,
      artifacts: this.seed.artifacts,
      resources: this.seed.resources,
      people: this.seed.people,
      drillCases: this.seed.drillCases,
    };
  }

  // ================= 内部工具 =================
  commonRoom(artifacts) {
    const room = artifacts[0].roomId;
    return artifacts.every((a) => a.roomId === room) ? room : null;
  }

  person(id) {
    if (!id) throw badRequest("missing_actor", "缺少操作人 actorPersonId");
    const p = this.seed.people.find((x) => x.id === id);
    if (!p) throw badRequest("unknown_person", `未知人员: ${id}`, 404);
    return p;
  }

  requireAuthority(personId, action) {
    const p = this.person(personId);
    if (!AUTHORITY_ROLES.has(p.role)) throw badRequest("forbidden", `仅值班长/管理员可${action}`, 403);
    return p;
  }

  requireOpen(id) {
    const incident = this.incident(id);
    if (incident.closedAt) throw badRequest("incident_closed", `事件 ${id} 已关闭，禁止再写入`, 409);
    return incident;
  }

  zone(id) {
    const z = this.seed.building.zones.find((x) => x.id === id);
    if (!z) throw badRequest("unknown_zone", `未知分区: ${id}`, 404);
    return z;
  }

  adjacent(a, b) {
    return this.seed.building.adjacency.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  }

  room(id) {
    const r = this.state.roomIndex.get(id);
    if (!r) throw badRequest("unknown_room", `未知房间: ${id}`, 404);
    return r;
  }

  resource(id) {
    const r = this.seed.resources.find((x) => x.id === id);
    if (!r) throw badRequest("unknown_resource", `未知设备: ${id}`, 404);
    return r;
  }

  incident(id) {
    const inc = this.state.incidents.get(id);
    if (!inc) throw badRequest("unknown_incident", `未知事件: ${id}`, 404);
    return inc;
  }

  action(id) {
    const a = this.state.actions.get(id);
    if (!a) throw badRequest("unknown_action", `未知动作: ${id}`, 404);
    return a;
  }

  // ================= 投影 =================
  project(event) {
    const s = this.state;
    s.timeline.push(event);
    const d = event.data;
    switch (event.type) {
      case "incident.opened": {
        s.incidents.set(d.id, {
          id: d.id,
          type: d.type,
          title: d.title,
          commanderPersonId: d.commanderPersonId,
          zoneIds: [...d.zoneIds],
          openedAt: event.occurredAt,
          closedAt: null,
        });
        s.assessments.set(d.id, new Map());
        break;
      }
      case "incident.closed": {
        const inc = s.incidents.get(event.incidentId);
        if (inc) inc.closedAt = d.at;
        break;
      }
      case "room.reported": {
        const map = s.assessments.get(event.incidentId);
        const entry = map.get(d.roomId) ?? { current: null, evidence: [] };
        const stored = { ...d, seq: event.seq };
        entry.evidence.push(stored);
        // 当前状态按"发生时间"最新者裁定（并列以落盘序号为准）；旧报告全部保留为证据。
        if (
          !entry.current ||
          ms(d.occurredAt) > ms(entry.current.occurredAt) ||
          (ms(d.occurredAt) === ms(entry.current.occurredAt) && event.seq > entry.current.seq)
        ) {
          entry.current = stored;
        }
        for (const e of entry.evidence) {
          e.contradictsCurrent = e.id !== entry.current.id && contradictsStatus(e.status, entry.current.status);
        }
        map.set(d.roomId, entry);
        const inc = s.incidents.get(event.incidentId);
        const zoneId = s.roomIndex.get(d.roomId)?.zoneId;
        if (zoneId && inc && !inc.zoneIds.includes(zoneId)) inc.zoneIds.push(zoneId);
        break;
      }
      case "zone.locked": {
        s.locks.set(`${d.scope}:${d.targetId}`, { ...d, at: event.occurredAt, seq: event.seq });
        break;
      }
      case "zone.unlocked": {
        s.locks.delete(`${d.scope}:${d.targetId}`);
        break;
      }
      case "resource.allocated": {
        s.allocations.push({ ...d, incidentId: event.incidentId, seq: event.seq, cancelledAt: null });
        break;
      }
      case "resource.allocationCancelled": {
        const a = s.allocations.find((x) => x.id === d.id);
        if (a) a.cancelledAt = d.at;
        break;
      }
      case "person.checkedIn": {
        const list = s.sessions.get(d.personId) ?? [];
        list.push({ incidentId: d.incidentId, startAt: event.occurredAt, endAt: null });
        s.sessions.set(d.personId, list);
        break;
      }
      case "person.checkedOut": {
        const open = (s.sessions.get(d.personId) ?? []).find((x) => !x.endAt);
        if (open) open.endAt = event.occurredAt;
        break;
      }
      case "person.assigned": {
        s.assignments.push({ ...d, incidentId: event.incidentId, seq: event.seq, cancelledAt: null });
        break;
      }
      case "person.assignmentCancelled": {
        const a = s.assignments.find((x) => x.id === d.id);
        if (a) a.cancelledAt = d.at;
        break;
      }
      case "route.activated": {
        s.routes.push({ ...d, incidentId: event.incidentId, seq: event.seq, closedAt: null });
        break;
      }
      case "route.closed": {
        const r = s.routes.find((x) => x.id === d.id);
        if (r) r.closedAt = d.at;
        break;
      }
      case "action.created": {
        s.actions.set(d.id, { ...d, incidentId: event.incidentId, seq: event.seq });
        break;
      }
      case "action.acknowledged": {
        const a = s.actions.get(d.id);
        if (a && !a.acknowledgedAt) a.acknowledgedAt = d.at;
        break;
      }
      case "action.completed": {
        const a = s.actions.get(d.id);
        if (a) a.completedAt = d.at;
        break;
      }
      case "action.cancelled": {
        const a = s.actions.get(d.id);
        if (a) a.cancelledAt = d.at;
        break;
      }
      case "reminder.raised": {
        const a = s.actions.get(d.actionId);
        if (a && !a.remindedAt) a.remindedAt = event.occurredAt;
        break;
      }
      case "transfer.created": {
        s.transfers.set(d.id, { ...d, incidentId: event.incidentId, seq: event.seq });
        for (const id of d.artifactIds) {
          const art = s.artifacts.get(id);
          if (art) art.batchId = d.id;
        }
        break;
      }
      case "transfer.departed": {
        const b = s.transfers.get(d.id);
        if (b) {
          b.status = "in_transit";
          b.departedAt = d.at;
          b.leaderPersonId = d.leaderPersonId ?? b.leaderPersonId;
        }
        break;
      }
      case "transfer.arrived": {
        const b = s.transfers.get(d.id);
        if (b) {
          b.status = "arrived";
          b.arrivedAt = d.at;
          b.toRoomId = d.toRoomId ?? b.toRoomId;
        }
        break;
      }
      case "transfer.artifactConfirmed": {
        const b = s.transfers.get(d.id);
        if (b && !b.confirmedArtifactIds.includes(d.artifactId)) b.confirmedArtifactIds.push(d.artifactId);
        s.confirmations.push({ batchId: d.id, artifactId: d.artifactId, at: d.at, byPersonId: event.actor, note: d.conditionNote });
        break;
      }
      case "transfer.completed": {
        const b = s.transfers.get(d.id);
        if (b) {
          b.status = "completed";
          b.completedAt = d.at;
          for (const id of b.artifactIds) {
            const art = s.artifacts.get(id);
            if (art) {
              art.roomId = b.toRoomId;
              art.batchId = null;
            }
          }
        }
        break;
      }
      case "transfer.cancelled": {
        const b = s.transfers.get(d.id);
        if (b) {
          b.status = "cancelled";
          b.cancelledAt = d.at;
          for (const id of b.artifactIds) {
            const art = s.artifacts.get(id);
            if (art && art.batchId === d.id) art.batchId = null;
          }
        }
        break;
      }
      default:
        // 未知事件类型（新版本写入、旧版本读取）忽略，保持前向兼容。
        break;
    }
  }
}

function freshState(seed) {
  const roomIndex = new Map();
  const roomsByZone = new Map();
  for (const zone of seed.building.zones) {
    roomsByZone.set(zone.id, []);
    for (const room of zone.rooms) {
      const record = { id: room.id, name: room.name, zoneId: zone.id, level: zone.level };
      roomIndex.set(room.id, record);
      roomsByZone.get(zone.id).push(record);
    }
  }
  const artifacts = new Map();
  for (const a of seed.artifacts) artifacts.set(a.id, { ...a, batchId: null });
  return {
    incidents: new Map(),
    assessments: new Map(),
    locks: new Map(),
    allocations: [],
    sessions: new Map(),
    assignments: [],
    routes: [],
    actions: new Map(),
    transfers: new Map(),
    confirmations: [],
    artifacts,
    roomIndex,
    roomsByZone,
    timeline: [],
  };
}

function contradictsStatus(a, b) {
  if (!a || !b || a === b) return false;
  const severity = { dry: 0, seepage: 1, flooded: 2, critical: 3 };
  // "干" 与任一进水状态直接矛盾；危急与渗水相差两级以上同样视为冲突电话上报。
  if (a === "dry" || b === "dry") return true;
  return Math.abs(severity[a] - severity[b]) >= 2;
}

function summarizeBatch(b, state) {
  const artifacts = b.artifactIds.map((id) => {
    const art = state.artifacts.get(id);
    let currentRoomId;
    if (b.status === "completed") currentRoomId = b.toRoomId;
    else if (b.status === "in_transit") currentRoomId = null; // 在途
    else currentRoomId = art?.roomId ?? b.fromRoomId;
    return {
      artifactId: id,
      name: art?.name,
      vulnerability: art?.vulnerability,
      confirmed: b.confirmedArtifactIds.includes(id),
      currentRoomId,
    };
  });
  return {
    id: b.id,
    incidentId: b.incidentId,
    status: b.status,
    priority: b.priority,
    vulnerabilityWorst: b.vulnerabilityWorst,
    fromRoomId: b.fromRoomId,
    toRoomId: b.toRoomId,
    routeId: b.routeId,
    leaderPersonId: b.leaderPersonId,
    createdAt: b.createdAt,
    departedAt: b.departedAt,
    arrivedAt: b.arrivedAt,
    completedAt: b.completedAt,
    cancelledAt: b.cancelledAt,
    artifacts,
  };
}
