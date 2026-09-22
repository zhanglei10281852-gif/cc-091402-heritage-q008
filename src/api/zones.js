import { badRequest, conflict } from "../errors.js";
import { ZONE_STATUSES, isSealed, parseTime } from "../domain.js";
import {
  getIncident,
  getOpenIncident,
  getZone,
  optionalString,
  refreshZoneRecheckReminder,
  requireCommander,
  requireStaff,
  requireString,
} from "./helpers.js";

const LATE_ARRIVAL_THRESHOLD_MS = 5 * 60 * 1000;

function validateReportPayload(state, body) {
  const zoneId = requireString(body, "zoneId");
  getZone(state, zoneId);
  const reporter = requireStaff(state, body.reporterId, "reporterId");
  const status = requireString(body, "status");
  if (!ZONE_STATUSES.includes(status)) {
    throw badRequest(`非法区域状态: ${status}，可选: ${ZONE_STATUSES.join("/")}`);
  }
  const occurredAtMs = parseTime(requireString(body, "occurredAt"), "occurredAt");
  return { zoneId, reporter, status, occurredAtMs };
}

function receiveReport(ctx, incidentId, body) {
  const { store } = ctx;
  const { zoneId, reporter, status, occurredAtMs } = validateReportPayload(store.state, body);
  const id = store.nextId("report");
  store.append("report.received", {
    id,
    incidentId,
    zoneId,
    reporterId: reporter.id,
    status,
    waterLevel: body.waterLevel ?? null,
    note: optionalString(body, "note"),
    occurredAt: new Date(occurredAtMs).toISOString(),
    receivedAt: new Date(store.now()).toISOString(),
  });
  const assessment = store.state.assessments[`${incidentId}/${zoneId}`];
  // 进水/危险 → 按当前生效上报的发生时间重设复查提醒；恢复正常 → 取消该区域的复查提醒
  if (["进水", "危险"].includes(assessment.currentStatus)) {
    const currentReport = assessment.reports.find((report) => report.id === assessment.currentReportId);
    refreshZoneRecheckReminder(ctx, incidentId, zoneId, Date.parse(currentReport.occurredAt));
  } else {
    cancelRecheckIfCleared(ctx, incidentId, zoneId);
  }
  return assessment;
}

function cancelRecheckIfCleared(ctx, incidentId, zoneId) {
  for (const reminder of Object.values(ctx.store.state.reminders)) {
    if (
      reminder.status === "pending" &&
      reminder.kind === "zone-recheck" &&
      reminder.related?.incidentId === incidentId &&
      reminder.related?.zoneId === zoneId
    ) {
      ctx.store.append("reminder.cancelled", { reminderId: reminder.id });
      ctx.scheduler.disarm(reminder.id);
    }
  }
}

function feedOf(state, incidentId) {
  const reports = [];
  for (const assessment of Object.values(state.assessments)) {
    if (assessment.incidentId !== incidentId) continue;
    reports.push(...assessment.reports);
  }
  const byOccurrence = [...reports].sort((a, b) => {
    const diff = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
    return diff !== 0 ? diff : Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
  });
  return byOccurrence.map((report) => ({
    ...report,
    lateArrival: Date.parse(report.receivedAt) - Date.parse(report.occurredAt) > LATE_ARRIVAL_THRESHOLD_MS,
  }));
}

export function registerZoneRoutes(router, ctx) {
  const { store } = ctx;

  // 单条现场上报：同一房间自动合并，原始证据全部保留
  router.post("/incidents/:id/reports", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    const assessment = receiveReport(ctx, params.id, body);
    return { status: 201, payload: assessment };
  });

  // 网络恢复后的批量补报：逐条落日志，响应按发生时间重排
  router.post("/incidents/:id/reports/batch", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    if (!Array.isArray(body.reports) || body.reports.length === 0) {
      throw badRequest("reports 必须是非空数组");
    }
    for (const report of body.reports) validateReportPayload(store.state, report);
    const assessments = body.reports.map((report) => receiveReport(ctx, params.id, report));
    return {
      status: 201,
      payload: {
        assessments,
        reorderedFeed: feedOf(store.state, params.id),
      },
    };
  });

  router.get("/incidents/:id/zones/:zoneId/assessment", ({ params }) => {
    getIncident(store.state, params.id);
    getZone(store.state, params.zoneId);
    const assessment = store.state.assessments[`${params.id}/${params.zoneId}`];
    if (!assessment) return { payload: { incidentId: params.id, zoneId: params.zoneId, currentStatus: "未知", reports: [] } };
    return { payload: assessment };
  });

  // 现场上报流：默认按发生时间重排，迟到上报打标记
  router.get("/incidents/:id/feed", ({ params, query }) => {
    getIncident(store.state, params.id);
    const feed = feedOf(store.state, params.id);
    if (query.order === "receivedAt") {
      feed.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    }
    return { payload: { incidentId: params.id, feed } };
  });

  router.post("/incidents/:id/zones/:zoneId/seal", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    getZone(store.state, params.zoneId);
    requireCommander(store.state, body.by);
    const reason = requireString(body, "reason");
    if (isSealed(store.state, params.id, params.zoneId)) {
      throw conflict("already_sealed", `区域已封锁: ${params.zoneId}`);
    }
    store.append("zone.sealed", {
      incidentId: params.id,
      zoneId: params.zoneId,
      by: body.by,
      reason,
      at: new Date(store.now()).toISOString(),
    });
    return { status: 201, payload: store.state.seals[`${params.id}/${params.zoneId}`] };
  });

  router.post("/incidents/:id/zones/:zoneId/unseal", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    getZone(store.state, params.zoneId);
    requireCommander(store.state, body.by);
    if (!isSealed(store.state, params.id, params.zoneId)) {
      throw conflict("not_sealed", `区域未封锁: ${params.zoneId}`);
    }
    store.append("zone.unsealed", { incidentId: params.id, zoneId: params.zoneId, by: body.by, at: new Date(store.now()).toISOString() });
    return { payload: { incidentId: params.id, zoneId: params.zoneId, sealed: false } };
  });

  // 指定区域负责人：须在值班名单且已在该事件签到（班次覆盖当前时间）
  router.post("/incidents/:id/zones/:zoneId/owner", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    getZone(store.state, params.zoneId);
    const person = requireStaff(store.state, body.personId, "personId");
    requireStaff(store.state, body.by);
    const now = store.now();
    const checkedIn = Object.values(store.state.checkins).some(
      (checkin) =>
        checkin.incidentId === params.id &&
        checkin.personId === person.id &&
        Date.parse(checkin.shiftFrom) <= now &&
        now <= Date.parse(checkin.shiftTo) &&
        !checkin.endedAt,
    );
    if (!checkedIn) {
      throw conflict("not_checked_in", `${person.name} 当前未在事件 ${params.id} 签到值班`);
    }
    store.append("owner.assigned", {
      incidentId: params.id,
      zoneId: params.zoneId,
      personId: person.id,
      by: body.by,
      at: new Date(store.now()).toISOString(),
    });
    return { status: 201, payload: store.state.owners[`${params.id}/${params.zoneId}`] };
  });

  router.post("/incidents/:id/zones/:zoneId/actions", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    getZone(store.state, params.zoneId);
    requireStaff(store.state, body.by);
    if (isSealed(store.state, params.id, params.zoneId)) {
      throw conflict("zone_sealed", `区域 ${params.zoneId} 已封锁，普通调度不可覆盖`);
    }
    const type = requireString(body, "type");
    const description = requireString(body, "description");
    let dueAt = null;
    if (body.dueAt) dueAt = new Date(parseTime(body.dueAt, "dueAt")).toISOString();
    const id = store.nextId("action");
    store.append("action.created", {
      id,
      incidentId: params.id,
      zoneId: params.zoneId,
      type,
      description,
      dueAt,
      createdBy: body.by,
      createdAt: new Date(store.now()).toISOString(),
    });
    return { status: 201, payload: store.state.actions[id] };
  });

  router.post("/incidents/:id/actions/:actionId/complete", ({ params, body }) => {
    getOpenIncident(store.state, params.id);
    requireStaff(store.state, body.by);
    const action = store.state.actions[params.actionId];
    if (!action || action.incidentId !== params.id) throw badRequest(`动作不存在: ${params.actionId}`);
    if (action.status === "done") throw conflict("already_done", `动作已完成: ${params.actionId}`);
    store.append("action.completed", {
      actionId: action.id,
      by: body.by,
      note: optionalString(body, "note"),
      at: new Date(store.now()).toISOString(),
    });
    return { payload: store.state.actions[action.id] };
  });

  // 区域看板：当前负责人、未完成动作、相关转移批次完整轨迹
  router.get("/incidents/:id/zones/:zoneId/board", ({ params }) => {
    getIncident(store.state, params.id);
    const zone = getZone(store.state, params.zoneId);
    const key = `${params.id}/${params.zoneId}`;
    const owner = store.state.owners[key] ?? null;
    const ownerPerson = owner ? store.state.reference.staff.find((p) => p.id === owner.personId) : null;
    const openActions = Object.values(store.state.actions).filter(
      (action) => action.incidentId === params.id && action.zoneId === params.zoneId && action.status === "open",
    );
    const transfers = Object.values(store.state.transfers)
      .filter((transfer) => transfer.incidentId === params.id)
      .map((transfer) => {
        const path = [transfer.fromZoneId, ...(transfer.waypoints ?? []), transfer.toZoneId];
        if (!path.includes(params.zoneId)) return null;
        return {
          ...transfer,
          direction: transfer.fromZoneId === params.zoneId ? "out" : transfer.toZoneId === params.zoneId ? "in" : "via",
        };
      })
      .filter(Boolean);
    const assessment = store.state.assessments[key];
    return {
      payload: {
        zone,
        sealed: Boolean(store.state.seals[key]),
        seal: store.state.seals[key] ?? null,
        assessment: assessment ?? { currentStatus: "未知", reports: [] },
        owner: owner ? { ...owner, name: ownerPerson?.name ?? null, role: ownerPerson?.role ?? null } : null,
        openActions,
        transfers,
      },
    };
  });
}
