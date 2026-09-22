import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { findStaff, isCommander } from "../domain.js";

export function getIncident(state, incidentId) {
  const incident = state.incidents[incidentId];
  if (!incident) throw notFound(`事件不存在: ${incidentId}`);
  return incident;
}

export function getOpenIncident(state, incidentId) {
  const incident = getIncident(state, incidentId);
  if (incident.status !== "open") throw conflict("incident_closed", `事件已关闭: ${incidentId}`);
  return incident;
}

export function getZone(state, zoneId) {
  const zone = state.reference.zones.find((item) => item.id === zoneId);
  if (!zone) throw notFound(`区域不存在: ${zoneId}`);
  return zone;
}

export function requireStaff(state, personId, field = "by") {
  if (!personId || typeof personId !== "string") throw badRequest(`缺少经办人字段 ${field}`);
  const person = findStaff(state, personId);
  if (!person) throw badRequest(`经办人不在值班名单中: ${personId}`);
  return person;
}

export function requireCommander(state, personId, field = "by") {
  const person = requireStaff(state, personId, field);
  if (!isCommander(state, personId)) {
    throw forbidden(`需要值班长权限，${person.name} 的角色是 ${person.role}`);
  }
  return person;
}

export function requireString(body, field) {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw badRequest(`缺少必填字段 ${field}`);
  return value.trim();
}

export function optionalString(body, field) {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest(`字段 ${field} 必须是字符串`);
  return value.trim() || null;
}

export function requirePositiveInt(body, field) {
  const value = body[field];
  if (!Number.isInteger(value) || value <= 0) throw badRequest(`字段 ${field} 必须是正整数`);
  return value;
}

/** 创建持久化提醒并立即武装定时器。 */
export function createReminder(ctx, { incidentId, kind, message, fireAt, related }) {
  const id = ctx.store.nextId("reminder");
  const event = ctx.store.append("reminder.created", {
    id,
    incidentId,
    kind,
    message,
    fireAt,
    related: related ?? null,
    createdAt: new Date(ctx.store.now()).toISOString(),
  });
  ctx.scheduler.arm(ctx.store.state.reminders[id]);
  return event.data;
}

/** 取消符合条件的待触发提醒（例如区域复查被新上报取代、批次已签收）。 */
export function cancelPendingReminders(ctx, predicate) {
  for (const reminder of Object.values(ctx.store.state.reminders)) {
    if (reminder.status === "pending" && predicate(reminder)) {
      ctx.store.append("reminder.cancelled", { reminderId: reminder.id });
      ctx.scheduler.disarm(reminder.id);
    }
  }
}

/** 区域状态变为进水/危险后，刷新复查提醒：旧提醒取消，按发生时间+复查周期重设。 */
export function refreshZoneRecheckReminder(ctx, incidentId, zoneId, occurredAtMs) {
  cancelPendingReminders(
    ctx,
    (reminder) =>
      reminder.kind === "zone-recheck" &&
      reminder.related?.incidentId === incidentId &&
      reminder.related?.zoneId === zoneId,
  );
  const fireAtMs = Math.max(ctx.store.now(), occurredAtMs + ctx.config.zoneRecheckMinutes * 60 * 1000);
  return createReminder(ctx, {
    incidentId,
    kind: "zone-recheck",
    message: `区域 ${zoneId} 处于进水/危险状态，请复查水位与文物状况`,
    fireAt: new Date(fireAtMs).toISOString(),
    related: { incidentId, zoneId },
  });
}
