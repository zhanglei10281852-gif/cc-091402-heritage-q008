import fs from "node:fs";
import path from "node:path";
import { recomputeAssessment } from "./domain.js";

const JOURNAL_FILE = "journal.jsonl";
const SNAPSHOT_FILE = "snapshot.json";

export function initialState() {
  return {
    seq: 0,
    seeded: false,
    reference: {
      zones: [],
      artifacts: [],
      fragilityWeights: {},
      equipment: [],
      staff: [],
      commanderRoles: [],
      drills: [],
    },
    incidents: {},
    assessments: {},
    seals: {},
    owners: {},
    actions: {},
    checkins: {},
    allocations: {},
    routes: {},
    transfers: {},
    reminders: {},
    notifications: [],
    artifactZones: {},
  };
}

/** 纯函数式事件归约：所有状态变化都由事件驱动，重放日志即可重建指挥记录。 */
export function applyEvent(state, event, config) {
  const { type, data } = event;
  switch (type) {
    case "seed.loaded": {
      state.reference = data.reference;
      state.seeded = true;
      for (const artifact of data.reference.artifacts) {
        state.artifactZones[artifact.id] = artifact.zoneId;
      }
      break;
    }
    case "incident.created": {
      state.incidents[data.id] = { ...data, status: "open", closedAt: null, closedBy: null };
      break;
    }
    case "incident.closed": {
      const incident = state.incidents[data.incidentId];
      if (incident) {
        incident.status = "closed";
        incident.closedAt = data.at;
        incident.closedBy = data.by;
      }
      break;
    }
    case "report.received": {
      const key = `${data.incidentId}/${data.zoneId}`;
      const assessment =
        state.assessments[key] ??
        (state.assessments[key] = {
          incidentId: data.incidentId,
          zoneId: data.zoneId,
          reports: [],
          currentStatus: "未知",
          currentReportId: null,
          conflicting: false,
          updatedAt: null,
        });
      assessment.reports.push(data);
      recomputeAssessment(assessment, config.conflictWindowMinutes);
      break;
    }
    case "zone.sealed": {
      state.seals[`${data.incidentId}/${data.zoneId}`] = {
        incidentId: data.incidentId,
        zoneId: data.zoneId,
        sealedBy: data.by,
        sealedAt: data.at,
        reason: data.reason,
      };
      break;
    }
    case "zone.unsealed": {
      delete state.seals[`${data.incidentId}/${data.zoneId}`];
      break;
    }
    case "owner.assigned": {
      state.owners[`${data.incidentId}/${data.zoneId}`] = {
        incidentId: data.incidentId,
        zoneId: data.zoneId,
        personId: data.personId,
        assignedBy: data.by,
        assignedAt: data.at,
      };
      break;
    }
    case "action.created": {
      state.actions[data.id] = { ...data, status: "open", completedAt: null, completedBy: null };
      break;
    }
    case "action.completed": {
      const action = state.actions[data.actionId];
      if (action) {
        action.status = "done";
        action.completedAt = data.at;
        action.completedBy = data.by;
        action.completionNote = data.note ?? null;
      }
      break;
    }
    case "checkin.created": {
      state.checkins[data.id] = { ...data, endedAt: null };
      break;
    }
    case "checkin.ended": {
      const checkin = state.checkins[data.checkinId];
      if (checkin) checkin.endedAt = data.at;
      break;
    }
    case "allocation.created": {
      state.allocations[data.id] = { ...data, status: "active", releasedAt: null, releasedBy: null };
      break;
    }
    case "allocation.released": {
      const allocation = state.allocations[data.allocationId];
      if (allocation) {
        allocation.status = "released";
        allocation.releasedAt = data.at;
        allocation.releasedBy = data.by;
      }
      break;
    }
    case "route.created": {
      state.routes[data.id] = data;
      break;
    }
    case "transfer.created": {
      state.transfers[data.id] = {
        ...data,
        status: "prepared",
        trajectory: [{ event: "created", at: data.createdAt, by: data.createdBy, note: data.note ?? null }],
      };
      break;
    }
    case "transfer.departed":
    case "transfer.arrived":
    case "transfer.signed":
    case "transfer.cancelled": {
      const transfer = state.transfers[data.transferId];
      if (transfer) {
        const statusByEvent = {
          "transfer.departed": "departed",
          "transfer.arrived": "arrived",
          "transfer.signed": "signed",
          "transfer.cancelled": "cancelled",
        };
        transfer.status = statusByEvent[type];
        transfer.trajectory.push({ event: statusByEvent[type], at: data.at, by: data.by, note: data.note ?? null });
        if (type === "transfer.signed") {
          transfer.signedCondition = data.condition ?? null;
          for (const artifactId of transfer.artifactIds) {
            state.artifactZones[artifactId] = transfer.toZoneId;
          }
        }
      }
      break;
    }
    case "reminder.created": {
      state.reminders[data.id] = { ...data, status: "pending", firedAt: null };
      break;
    }
    case "reminder.fired": {
      const reminder = state.reminders[data.reminderId];
      if (reminder) {
        reminder.status = "fired";
        reminder.firedAt = data.at;
        state.notifications.push({
          id: `notification-${event.seq}`,
          reminderId: reminder.id,
          incidentId: reminder.incidentId,
          kind: reminder.kind,
          message: reminder.message,
          related: reminder.related ?? null,
          firedAt: data.at,
        });
      }
      break;
    }
    case "reminder.cancelled": {
      const reminder = state.reminders[data.reminderId];
      if (reminder && reminder.status === "pending") reminder.status = "cancelled";
      break;
    }
    default:
      break;
  }
  state.seq = Math.max(state.seq, event.seq);
  return state;
}

/**
 * 追加式日志 + 快照的持久化存储。
 * 每次变更先落盘（fsync）再应用到内存，重启后按快照 + 日志重放恢复。
 */
export function createStore({ dataDir, now = () => Date.now(), snapshotEvery = 200, conflictWindowMinutes = 30 }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const journalPath = path.join(dataDir, JOURNAL_FILE);
  const snapshotPath = path.join(dataDir, SNAPSHOT_FILE);
  const config = { conflictWindowMinutes };

  let state = initialState();
  const events = [];
  if (fs.existsSync(snapshotPath)) {
    state = JSON.parse(fs.readFileSync(snapshotPath, "utf8")).state;
  }
  if (fs.existsSync(journalPath)) {
    const raw = fs.readFileSync(journalPath, "utf8");
    const lines = raw.split("\n");
    const validLines = [];
    let repaired = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        events.push(event);
        if (event.seq > state.seq) applyEvent(state, event, config);
        validLines.push(line);
      } catch {
        // 崩溃可能留下写了一半的末行：丢弃并在之后重写，避免追加时拼接到损坏行
        repaired = true;
      }
    }
    if (repaired) {
      fs.writeFileSync(journalPath, validLines.length ? validLines.join("\n") + "\n" : "");
    }
  }

  let fd = fs.openSync(journalPath, "a");
  let eventsSinceSnapshot = 0;

  function snapshot() {
    // 快照只是启动加速器：日志本身完整保留，指挥记录不丢历史
    const tmp = snapshotPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ seq: state.seq, state }));
    fs.renameSync(tmp, snapshotPath);
    eventsSinceSnapshot = 0;
  }

  return {
    get state() {
      return state;
    },
    config,
    now,
    nextId(prefix) {
      return `${prefix}-${state.seq + 1}`;
    },
    append(type, data) {
      const event = { seq: state.seq + 1, at: new Date(now()).toISOString(), type, data };
      fs.writeSync(fd, JSON.stringify(event) + "\n");
      fs.fsyncSync(fd);
      events.push(event);
      applyEvent(state, event, config);
      eventsSinceSnapshot += 1;
      if (eventsSinceSnapshot >= snapshotEvery) snapshot();
      return event;
    },
    events() {
      return events;
    },
    snapshot,
    close() {
      snapshot();
      fs.closeSync(fd);
    },
  };
}
