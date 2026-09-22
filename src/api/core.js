import {
  cancelPendingReminders,
  getIncident,
  getOpenIncident,
  optionalString,
  requireCommander,
  requireStaff,
  requireString,
} from "./helpers.js";
import { conflict } from "../errors.js";

function incidentSummary(state, incident) {
  const zones = state.reference.zones.map((zone) => {
    const key = `${incident.id}/${zone.id}`;
    const assessment = state.assessments[key];
    const openActions = Object.values(state.actions).filter(
      (action) => action.incidentId === incident.id && action.zoneId === zone.id && action.status === "open",
    ).length;
    return {
      zoneId: zone.id,
      name: zone.name,
      level: zone.level,
      status: assessment?.currentStatus ?? "未知",
      conflicting: assessment?.conflicting ?? false,
      sealed: Boolean(state.seals[key]),
      owner: state.owners[key]?.personId ?? null,
      openActions,
    };
  });
  const pendingTransfers = Object.values(state.transfers).filter(
    (transfer) => transfer.incidentId === incident.id && !["signed", "cancelled"].includes(transfer.status),
  ).length;
  return { ...incident, zones, pendingTransfers };
}

export function registerCoreRoutes(router, ctx) {
  const { store } = ctx;

  router.get("/reference/zones", () => ({ payload: { zones: store.state.reference.zones } }));

  router.get("/reference/artifacts", ({ query }) => {
    let artifacts = store.state.reference.artifacts;
    if (query.zoneId) artifacts = artifacts.filter((item) => item.zoneId === query.zoneId);
    return {
      payload: {
        fragilityWeights: store.state.reference.fragilityWeights,
        artifacts: artifacts.map((item) => ({ ...item, currentZoneId: store.state.artifactZones[item.id] })),
      },
    };
  });

  router.get("/reference/equipment", () => ({ payload: { equipment: store.state.reference.equipment } }));
  router.get("/reference/staff", () => ({ payload: { staff: store.state.reference.staff } }));
  router.get("/reference/drills", () => ({ payload: { drills: store.state.reference.drills } }));

  router.post("/incidents", ({ body }) => {
    const title = requireString(body, "title");
    const type = requireString(body, "type");
    const commander = requireStaff(store.state, body.commanderId, "commanderId");
    const drillCaseId = optionalString(body, "drillCaseId");
    if (drillCaseId && !store.state.reference.drills.some((drill) => drill.id === drillCaseId)) {
      throw conflict("unknown_drill_case", `演练案例不存在: ${drillCaseId}`);
    }
    const id = store.nextId("incident");
    store.append("incident.created", {
      id,
      title,
      type,
      commanderId: commander.id,
      drillCaseId,
      createdAt: new Date(store.now()).toISOString(),
    });
    return { status: 201, payload: incidentSummary(store.state, store.state.incidents[id]) };
  });

  router.get("/incidents", () => ({
    payload: { incidents: Object.values(store.state.incidents).map((item) => incidentSummary(store.state, item)) },
  }));

  router.get("/incidents/:id", ({ params }) => {
    const incident = getIncident(store.state, params.id);
    return { payload: incidentSummary(store.state, incident) };
  });

  router.post("/incidents/:id/close", ({ params, body }) => {
    const incident = getOpenIncident(store.state, params.id);
    requireCommander(store.state, body.by);
    const unsigned = Object.values(store.state.transfers).filter(
      (transfer) => transfer.incidentId === incident.id && !["signed", "cancelled"].includes(transfer.status),
    );
    if (unsigned.length > 0 && body.force !== true) {
      throw conflict("pending_transfers", "仍有未签收的转移批次，使用 force=true 强制关闭", {
        pendingTransferIds: unsigned.map((item) => item.id),
      });
    }
    store.append("incident.closed", {
      incidentId: incident.id,
      by: body.by,
      at: new Date(store.now()).toISOString(),
    });
    cancelPendingReminders(ctx, (reminder) => reminder.incidentId === incident.id);
    return { payload: incidentSummary(store.state, store.state.incidents[incident.id]) };
  });

  // 指挥记录：该事件的全部日志条目，按序号排列，可导出复盘
  router.get("/incidents/:id/timeline", ({ params }) => {
    getIncident(store.state, params.id);
    const s = store.state;
    const belongsTo = (data) => {
      if (data.incidentId === params.id || data.id === params.id) return true;
      if (data.transferId && s.transfers[data.transferId]?.incidentId === params.id) return true;
      if (data.actionId && s.actions[data.actionId]?.incidentId === params.id) return true;
      if (data.allocationId && s.allocations[data.allocationId]?.incidentId === params.id) return true;
      if (data.checkinId && s.checkins[data.checkinId]?.incidentId === params.id) return true;
      if (data.reminderId && s.reminders[data.reminderId]?.incidentId === params.id) return true;
      return false;
    };
    const entries = [];
    for (const event of store.events()) {
      if (belongsTo(event.data ?? {})) {
        entries.push({ seq: event.seq, at: event.at, type: event.type, data: event.data });
      }
    }
    return { payload: { incidentId: params.id, entries } };
  });
}
