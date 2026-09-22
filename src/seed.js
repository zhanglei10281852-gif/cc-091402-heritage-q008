import fs from "node:fs";
import path from "node:path";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** 首次启动（日志为空）时把既有基础资料作为 seed.loaded 事件写入日志，之后随重放恢复。 */
export function seedIfEmpty(store, seedDir) {
  if (store.state.seeded) return false;
  const zones = readJson(path.join(seedDir, "building-zones.json"));
  const artifacts = readJson(path.join(seedDir, "artifacts.json"));
  const equipment = readJson(path.join(seedDir, "equipment.json"));
  const staff = readJson(path.join(seedDir, "staff.json"));
  const drills = readJson(path.join(seedDir, "drill-cases.json"));
  store.append("seed.loaded", {
    reference: {
      zones: zones.zones,
      artifacts: artifacts.artifacts,
      fragilityWeights: artifacts.fragilityWeights,
      equipment: equipment.equipment,
      staff: staff.staff,
      commanderRoles: staff.commanderRoles,
      drills: drills.drillCases,
    },
  });
  return true;
}
