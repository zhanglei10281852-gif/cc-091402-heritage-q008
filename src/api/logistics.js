import { badRequest, conflict } from "../errors.js";
import {
  availableQuantity,
  isSealed,
  overlaps,
  parseTime,
  priorityScore,
  routePath,
} from "../domain.js";
import {
  cancelPendingReminders,
  createReminder,
  getIncident,
  getOpenIncident,
  getZone,
  optionalString,
  requireCommander,
  requirePositiveInt,
  requireStaff,
  requireString,
} from "./helpers.js";

const TRANSFER_OPEN_STATUSES = ["prepared", "departed", "arrived"];

function getEquipment(state, type) {
  const equipment = state.reference.equipment.find((item) => item.type === type);
  if (!equipment) throw badRequest(`未知设备类型: ${type}，可选: ${state.reference.equipment.map((i) => i.type).join("/")}`);
  return equipment;
}

function activeAllocations(state) {
  return Object.values(state.allocations).filter((item) => item.status === "active");
}

/** 封锁区域不可被普通调度覆盖；紧急替代路线在批准且未失效时例外。 */
function assertRouteUsable(state, route, nowMs) {
  if (route.emergency) {
    if (nowMs >= Date.parse(route.expiresAt)) {
      throw conflict("route_expired", `紧急替代路线 ${route.id} 已于 ${route.expiresAt} 失效`);
    }
    return;
  }
  for (const zoneId of routePath(route)) {
    if (isSealed(state, route.incidentId, zoneId)) {
      throw conflict("zone_sealed", `路线 ${route.id} 经过已封锁区域 ${zoneId}，普通调度不可覆盖封锁`);
    }
  }
}

function getRoute(state, incidentId, routeId) {
  const route = state.routes[routeId];
  if (!route || route.incidentId !== incidentId) throw badRequest(`路线不存在: ${routeId}`);
  return route;
}

function getTransfer(state, incidentId, transferId) {
  const transfer = state.transfers[transferId];
  if (!transfer || transfer.incidentId !== incidentId) throw badRequest(`转移批次不存在: ${transferId}`);
  return transfer;
}

function zoneStatusOf(state, incidentId, zoneId) {
  return state.assessments[`${incidentId}/${zoneId}`]?.currentStatus ?? "未知";
}

function sortedByPriority(state, incidentId, zoneId, artifactIds) {
  const status = zoneStatusOf(state, incidentId, zoneId);
  return artifactIds
    .map((id) => {
      const artifact = state.reference.artifacts.find((item) => item.id === id);
      return { id, score: priorityScore(state.reference, artifact, status) };
    })
    .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
    .map((item) => item.id);
}

export function registerLogisticsRoutes(router, ctx) {
  const { store } = ctx;

  // ---------- 人员签到：同一人不得在任何事件中出现重叠班次 ----------
  router.post("/incidents/:id/checkins", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    const person = requireStaff(store.state, body.personId, "personId");
    const fromMs = parseTime(requireString(body, "shiftFrom"), "shiftFrom");
    const toMs = parseTime(requireString(body, "shiftTo"), "shiftTo");
    if (fromMs >= toMs) throw badRequest("shiftFrom 必须早于 shiftTo");
    const clash = Object.values(store.state.checkins).find((checkin) => {
      if (checkin.personId !== person.id) return false;
      const cFrom = Date.parse(checkin.shiftFrom);
      const cTo = checkin.endedAt ? Math.min(Date.parse(checkin.shiftTo), Date.parse(checkin.endedAt)) : Date.parse(checkin.shiftTo);
      return overlaps(fromMs, toMs, cFrom, cTo);
    });
    if (clash) {
      throw conflict("shift_conflict", `${person.name} 在事件 ${clash.incidentId} 已有重叠班次`, {
        conflictingCheckinId: clash.id,
      });
    }
    const id = store.nextId("checkin");
    store.append("checkin.created", {
      id,
      incidentId: params.id,
      personId: person.id,
      shiftFrom: new Date(fromMs).toISOString(),
      shiftTo: new Date(toMs).toISOString(),
    });
    return { status: 201, payload: store.state.checkins[id] };
  });

  router.post("/incidents/:id/checkins/:checkinId/end", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    requireStaff(store.state, body.by);
    const checkin = store.state.checkins[params.checkinId];
    if (!checkin || checkin.incidentId !== params.id) throw badRequest(`签到记录不存在: ${params.checkinId}`);
    if (checkin.endedAt) throw conflict("already_ended", `签到已结束: ${params.checkinId}`);
    store.append("checkin.ended", { checkinId: checkin.id, at: new Date(store.now()).toISOString() });
    return { payload: store.state.checkins[checkin.id] };
  });

  router.get("/incidents/:id/checkins", ({ params }) => {
    getIncident(store.state, params.id);
    const checkins = Object.values(store.state.checkins).filter((item) => item.incidentId === params.id);
    return { payload: { checkins } };
  });

  // ---------- 资源分配：不得超过实时可用量（全局跨事件计算） ----------
  router.post("/incidents/:id/allocations", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    requireStaff(store.state, body.by);
    const equipment = getEquipment(store.state, requireString(body, "equipmentType"));
    const quantity = requirePositiveInt(body, "quantity");
    const fromMs = parseTime(requireString(body, "from"), "from");
    const toMs = parseTime(requireString(body, "to"), "to");
    if (fromMs >= toMs) throw badRequest("from 必须早于 to");
    const zoneId = optionalString(body, "zoneId");
    if (zoneId) {
      getZone(store.state, zoneId);
      if (isSealed(store.state, params.id, zoneId)) {
        throw conflict("zone_sealed", `区域 ${zoneId} 已封锁，普通调度不可覆盖`);
      }
    }
    const available = availableQuantity(equipment, activeAllocations(store.state), fromMs, toMs);
    if (quantity > available) {
      throw conflict("insufficient_availability", `${equipment.type} 在该时段实时可用量为 ${available}，申请 ${quantity} 超出`, {
        available,
        requested: quantity,
      });
    }
    const id = store.nextId("allocation");
    store.append("allocation.created", {
      id,
      incidentId: params.id,
      equipmentType: equipment.type,
      quantity,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      zoneId,
      createdBy: body.by,
      createdAt: new Date(store.now()).toISOString(),
    });
    return { status: 201, payload: store.state.allocations[id] };
  });

  router.post("/incidents/:id/allocations/:allocationId/release", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    requireStaff(store.state, body.by);
    const allocation = store.state.allocations[params.allocationId];
    if (!allocation || allocation.incidentId !== params.id) throw badRequest(`分配记录不存在: ${params.allocationId}`);
    if (allocation.status !== "active") throw conflict("already_released", `分配已释放: ${params.allocationId}`);
    store.append("allocation.released", { allocationId: allocation.id, by: body.by, at: new Date(store.now()).toISOString() });
    return { payload: store.state.allocations[allocation.id] };
  });

  // 实时库存视图：总量、当前占用、停用、可用（跨事件合并计算）
  router.get("/incidents/:id/resources", ({ params, query }) => {
    getIncident(store.state, params.id);
    const atMs = query.at ? parseTime(query.at, "at") : store.now();
    const resources = store.state.reference.equipment.map((equipment) => {
      const allocated = activeAllocations(store.state).filter(
        (item) => item.equipmentType === equipment.type && Date.parse(item.from) <= atMs && atMs < Date.parse(item.to),
      );
      const unavailableNow = (equipment.unavailable ?? [])
        .filter((window) => Date.parse(window.from) <= atMs && atMs < Date.parse(window.to))
        .reduce((sum, window) => sum + window.quantity, 0);
      const allocatedNow = allocated.reduce((sum, item) => sum + item.quantity, 0);
      return {
        type: equipment.type,
        totalQuantity: equipment.totalQuantity,
        allocatedNow,
        unavailableNow,
        availableNow: equipment.totalQuantity - allocatedNow - unavailableNow,
        unavailableWindows: equipment.unavailable ?? [],
        allocations: allocated.map((item) => ({
          id: item.id,
          incidentId: item.incidentId,
          quantity: item.quantity,
          from: item.from,
          to: item.to,
          zoneId: item.zoneId,
        })),
      };
    });
    return { payload: { at: new Date(atMs).toISOString(), resources } };
  });

  // ---------- 转移路线：紧急替代路线必须记录批准人（值班长）与失效时间 ----------
  router.post("/incidents/:id/routes", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    requireStaff(store.state, body.by);
    const fromZoneId = requireString(body, "fromZoneId");
    const toZoneId = requireString(body, "toZoneId");
    getZone(store.state, fromZoneId);
    getZone(store.state, toZoneId);
    if (fromZoneId === toZoneId) throw badRequest("起点与终点不能相同");
    const waypoints = Array.isArray(body.waypoints) ? body.waypoints : [];
    for (const waypoint of waypoints) getZone(store.state, waypoint);
    const emergency = body.emergency === true;
    let approvedBy = null;
    let expiresAt = null;
    if (emergency) {
      const approver = requireCommander(store.state, body.approvedBy, "approvedBy");
      approvedBy = approver.id;
      expiresAt = new Date(parseTime(requireString(body, "expiresAt"), "expiresAt")).toISOString();
      if (Date.parse(expiresAt) <= store.now()) throw badRequest("紧急替代路线的失效时间必须晚于当前时间");
    } else {
      for (const zoneId of [fromZoneId, ...waypoints, toZoneId]) {
        if (isSealed(store.state, params.id, zoneId)) {
          throw conflict("zone_sealed", `路线经过已封锁区域 ${zoneId}，请改用紧急替代路线并报批`);
        }
      }
    }
    const id = store.nextId("route");
    const route = store.append("route.created", {
      id,
      incidentId: params.id,
      fromZoneId,
      toZoneId,
      waypoints,
      emergency,
      approvedBy,
      expiresAt,
      createdBy: body.by,
      createdAt: new Date(store.now()).toISOString(),
    }).data;
    return { status: 201, payload: route };
  });

  router.get("/incidents/:id/routes", ({ params }) => {
    getIncident(store.state, params.id);
    const routes = Object.values(store.state.routes).filter((item) => item.incidentId === params.id);
    return { payload: { routes } };
  });

  // ---------- 受潮文物优先级 ----------
  router.get("/incidents/:id/zones/:zoneId/transfer-priority", ({ params }) => {
    getIncident(store.state, params.id);
    getZone(store.state, params.zoneId);
    const status = zoneStatusOf(store.state, params.id, params.zoneId);
    const artifacts = store.state.reference.artifacts
      .filter((artifact) => store.state.artifactZones[artifact.id] === params.zoneId)
      .map((artifact) => ({
        ...artifact,
        zoneStatus: status,
        priorityScore: priorityScore(store.state.reference, artifact, status),
      }))
      .sort((a, b) => (b.priorityScore - a.priorityScore) || a.id.localeCompare(b.id));
    return { payload: { zoneId: params.zoneId, zoneStatus: status, artifacts } };
  });

  // ---------- 转移批次：完整轨迹 ----------
  router.post("/incidents/:id/transfers", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    requireStaff(store.state, body.by);
    const route = getRoute(store.state, params.id, requireString(body, "routeId"));
    assertRouteUsable(store.state, route, store.now());

    let artifactIds;
    if (Array.isArray(body.artifactIds) && body.artifactIds.length > 0) {
      artifactIds = body.artifactIds;
    } else if (body.autoSelect && Number.isInteger(body.autoSelect.count) && body.autoSelect.count > 0) {
      const status = zoneStatusOf(store.state, params.id, route.fromZoneId);
      artifactIds = store.state.reference.artifacts
        .filter((artifact) => store.state.artifactZones[artifact.id] === route.fromZoneId)
        .map((artifact) => ({ id: artifact.id, score: priorityScore(store.state.reference, artifact, status) }))
        .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
        .slice(0, body.autoSelect.count)
        .map((item) => item.id);
      if (artifactIds.length === 0) throw badRequest(`区域 ${route.fromZoneId} 内没有可转移的文物`);
    } else {
      throw badRequest("必须提供 artifactIds 或 autoSelect.count");
    }

    for (const artifactId of artifactIds) {
      const artifact = store.state.reference.artifacts.find((item) => item.id === artifactId);
      if (!artifact) throw badRequest(`文物不存在: ${artifactId}`);
      if (store.state.artifactZones[artifactId] !== route.fromZoneId) {
        throw conflict("artifact_not_in_zone", `文物 ${artifactId} 当前不在 ${route.fromZoneId}`);
      }
      const inTransit = Object.values(store.state.transfers).find(
        (transfer) =>
          transfer.incidentId === params.id &&
          TRANSFER_OPEN_STATUSES.includes(transfer.status) &&
          transfer.artifactIds.includes(artifactId),
      );
      if (inTransit) throw conflict("artifact_in_transit", `文物 ${artifactId} 已在批次 ${inTransit.id} 中`);
    }

    const id = store.nextId("transfer");
    const transfer = store.append("transfer.created", {
      id,
      incidentId: params.id,
      routeId: route.id,
      fromZoneId: route.fromZoneId,
      toZoneId: route.toZoneId,
      waypoints: route.waypoints ?? [],
      emergency: route.emergency,
      artifactIds: sortedByPriority(store.state, params.id, route.fromZoneId, artifactIds),
      note: optionalString(body, "note"),
      createdBy: body.by,
      createdAt: new Date(store.now()).toISOString(),
    }).data;
    return { status: 201, payload: store.state.transfers[transfer.id] };
  });

  router.post("/incidents/:id/transfers/:transferId/depart", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    requireStaff(store.state, body.by);
    const transfer = getTransfer(store.state, params.id, params.transferId);
    if (transfer.status !== "prepared") throw conflict("invalid_state", `批次状态为 ${transfer.status}，不能出发`);
    assertRouteUsable(store.state, getRoute(store.state, params.id, transfer.routeId), store.now());
    const at = new Date(store.now()).toISOString();
    store.append("transfer.departed", { transferId: transfer.id, by: body.by, at, note: optionalString(body, "note") });
    // 出发后自动生成签收时限提醒，重启后仍会触发
    createReminder(ctx, {
      incidentId: params.id,
      kind: "signoff-deadline",
      message: `转移批次 ${transfer.id} 已出发超过签收时限，请确认签收`,
      fireAt: new Date(store.now() + ctx.config.signoffDeadlineMinutes * 60 * 1000).toISOString(),
      related: { incidentId: params.id, transferId: transfer.id },
    });
    return { payload: store.state.transfers[transfer.id] };
  });

  router.post("/incidents/:id/transfers/:transferId/arrive", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    requireStaff(store.state, body.by);
    const transfer = getTransfer(store.state, params.id, params.transferId);
    if (transfer.status !== "departed") throw conflict("invalid_state", `批次状态为 ${transfer.status}，不能到达`);
    store.append("transfer.arrived", {
      transferId: transfer.id,
      by: body.by,
      at: new Date(store.now()).toISOString(),
      note: optionalString(body, "note"),
    });
    return { payload: store.state.transfers[transfer.id] };
  });

  router.post("/incidents/:id/transfers/:transferId/signoff", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    requireStaff(store.state, body.by);
    const transfer = getTransfer(store.state, params.id, params.transferId);
    if (transfer.status !== "arrived") throw conflict("invalid_state", `批次状态为 ${transfer.status}，不能签收`);
    store.append("transfer.signed", {
      transferId: transfer.id,
      by: body.by,
      at: new Date(store.now()).toISOString(),
      condition: optionalString(body, "condition"),
    });
    cancelPendingReminders(
      ctx,
      (reminder) => reminder.kind === "signoff-deadline" && reminder.related?.transferId === transfer.id,
    );
    return { payload: store.state.transfers[transfer.id] };
  });

  router.post("/incidents/:id/transfers/:transferId/cancel", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    requireStaff(store.state, body.by);
    const transfer = getTransfer(store.state, params.id, params.transferId);
    if (transfer.status !== "prepared") throw conflict("invalid_state", `批次状态为 ${transfer.status}，不能取消`);
    store.append("transfer.cancelled", {
      transferId: transfer.id,
      by: body.by,
      at: new Date(store.now()).toISOString(),
      note: optionalString(body, "reason"),
    });
    return { payload: store.state.transfers[transfer.id] };
  });

  router.get("/incidents/:id/transfers", ({ params }) => {
    getIncident(store.state, params.id);
    const transfers = Object.values(store.state.transfers).filter((item) => item.incidentId === params.id);
    return { payload: { transfers } };
  });

  router.get("/incidents/:id/transfers/:transferId", ({ params }) => {
    getIncident(store.state, params.id);
    return { payload: getTransfer(store.state, params.id, params.transferId) };
  });

  // 待签收任务：重启后依然完整可查
  router.get("/incidents/:id/pending-signoffs", ({ params }) => {
    getIncident(store.state, params.id);
    const pending = Object.values(store.state.transfers).filter(
      (item) => item.incidentId === params.id && TRANSFER_OPEN_STATUSES.includes(item.status),
    );
    return { payload: { pending } };
  });

  // ---------- 提醒与通知 ----------
  router.post("/incidents/:id/reminders", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    requireStaff(store.state, body.by);
    const message = requireString(body, "message");
    const fireAtMs = parseTime(requireString(body, "fireAt"), "fireAt");
    const reminder = createReminder(ctx, {
      incidentId: params.id,
      kind: "manual",
      message,
      fireAt: new Date(fireAtMs).toISOString(),
      related: { incidentId: params.id, createdBy: body.by },
    });
    return { status: 201, payload: reminder };
  });

  router.get("/incidents/:id/reminders", ({ params, query }) => {
    getIncident(store.state, params.id);
    let reminders = Object.values(store.state.reminders).filter((item) => item.incidentId === params.id);
    if (query.status) reminders = reminders.filter((item) => item.status === query.status);
    return { payload: { reminders } };
  });

  router.get("/incidents/:id/notifications", ({ params }) => {
    getIncident(store.state, params.id);
    const notifications = store.state.notifications.filter((item) => item.incidentId === params.id);
    return { payload: { notifications } };
  });
}
