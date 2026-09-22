import { badRequest } from "./errors.js";

export const ZONE_STATUSES = ["未知", "正常", "进水", "危险"];

const SEVERITY_WEIGHTS = { 危险: 3, 进水: 2, 正常: 1, 未知: 1 };

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** 解析带时区的 ISO 8601 时间，返回毫秒时间戳；非法输入抛 400。 */
export function parseTime(value, field) {
  if (typeof value !== "string" || !ISO_WITH_ZONE.test(value.trim())) {
    throw badRequest(`字段 ${field} 必须是带时区的 ISO 8601 时间字符串`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw badRequest(`字段 ${field} 不是可解析的时间: ${value}`);
  }
  return ms;
}

export function iso(ms) {
  return new Date(ms).toISOString();
}

export function overlaps(aFrom, aTo, bFrom, bTo) {
  return aFrom < bTo && bFrom < aTo;
}

/** 合并评估重算：当前状态取 occurredAt 最新（并列取 receivedAt 最新）的上报；冲突窗口内状态不一致则标记冲突。 */
export function recomputeAssessment(assessment, conflictWindowMinutes) {
  const reports = assessment.reports;
  const byOccurrence = [...reports].sort((a, b) => {
    const ao = Date.parse(a.occurredAt);
    const bo = Date.parse(b.occurredAt);
    if (ao !== bo) return ao - bo;
    return Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
  });
  const latest = byOccurrence[byOccurrence.length - 1];
  assessment.currentStatus = latest.status;
  assessment.currentReportId = latest.id;
  assessment.updatedAt = latest.receivedAt;
  const windowMs = conflictWindowMinutes * 60 * 1000;
  assessment.conflicting = reports.some((a, i) =>
    reports.some(
      (b, j) =>
        j > i &&
        a.status !== b.status &&
        Math.abs(Date.parse(a.occurredAt) - Date.parse(b.occurredAt)) <= windowMs,
    ),
  );
  return assessment;
}

/**
 * 实时可用量：把 [fromMs,toMs] 与所有占用（已生效分配 + 停用窗口）的边界切成段，
 * 每段可用量 = 总量 - 段内占用，返回各段最小值。分配不得超过该值。
 */
export function availableQuantity(equipment, activeAllocations, fromMs, toMs) {
  const points = new Set([fromMs, toMs]);
  const relevant = [];
  for (const allocation of activeAllocations) {
    if (allocation.equipmentType !== equipment.type) continue;
    const aFrom = Date.parse(allocation.from);
    const aTo = Date.parse(allocation.to);
    if (overlaps(aFrom, aTo, fromMs, toMs)) {
      relevant.push({ from: aFrom, to: aTo, quantity: allocation.quantity });
      points.add(Math.max(aFrom, fromMs));
      points.add(Math.min(aTo, toMs));
    }
  }
  for (const window of equipment.unavailable ?? []) {
    const uFrom = Date.parse(window.from);
    const uTo = Date.parse(window.to);
    if (overlaps(uFrom, uTo, fromMs, toMs)) {
      relevant.push({ from: uFrom, to: uTo, quantity: window.quantity });
      points.add(Math.max(uFrom, fromMs));
      points.add(Math.min(uTo, toMs));
    }
  }
  const sorted = [...points].sort((a, b) => a - b);
  let minimum = equipment.totalQuantity;
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const segFrom = sorted[i];
    const segTo = sorted[i + 1];
    if (segFrom >= segTo) continue;
    let used = 0;
    for (const item of relevant) {
      if (overlaps(item.from, item.to, segFrom, segTo)) used += item.quantity;
    }
    minimum = Math.min(minimum, equipment.totalQuantity - used);
  }
  return minimum;
}

export function severityWeight(status) {
  return SEVERITY_WEIGHTS[status] ?? 1;
}

export function fragilityWeight(reference, fragility) {
  return reference.fragilityWeights?.[fragility] ?? 1;
}

/** 受潮文物优先级 = 脆弱等级权重 × 区域严重度权重。 */
export function priorityScore(reference, artifact, zoneStatus) {
  return fragilityWeight(reference, artifact.fragility) * severityWeight(zoneStatus);
}

export function routePath(route) {
  return [route.fromZoneId, ...(route.waypoints ?? []), route.toZoneId];
}

export function isSealed(state, incidentId, zoneId) {
  return Boolean(state.seals[`${incidentId}/${zoneId}`]);
}

export function findStaff(state, personId) {
  return state.reference.staff.find((person) => person.id === personId);
}

export function isCommander(state, personId) {
  const person = findStaff(state, personId);
  return Boolean(person) && state.reference.commanderRoles.includes(person.role);
}
