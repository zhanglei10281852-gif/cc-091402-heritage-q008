import assert from "node:assert/strict";
import test from "node:test";
import { coveredByWindows, overlaps } from "../src/util.js";

const weekdays = {
  kind: "weekly",
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  start: "08:00",
  end: "22:00",
  timezone: "Asia/Shanghai",
};
const weekdays24 = { ...weekdays, start: "06:00", end: "24:00" };
const workdays = { ...weekdays, weekdays: [1, 2, 3, 4, 5] };
const always = { kind: "always" };

test("可用时段：窗口内、窗口外、边界", () => {
  assert.equal(coveredByWindows("2026-07-10T08:00:00+08:00", "2026-07-10T22:00:00+08:00", [weekdays]), true);
  assert.equal(coveredByWindows("2026-07-10T10:00:00+08:00", "2026-07-10T11:30:00+08:00", [weekdays]), true);
  assert.equal(coveredByWindows("2026-07-10T07:59:00+08:00", "2026-07-10T09:00:00+08:00", [weekdays]), false);
  assert.equal(coveredByWindows("2026-07-10T21:30:00+08:00", "2026-07-10T22:00:01+08:00", [weekdays]), false);
  assert.equal(coveredByWindows("2026-07-10T23:00:00+08:00", "2026-07-11T00:30:00+08:00", [weekdays24]), false);
  assert.equal(coveredByWindows("2026-07-10T06:00:00+08:00", "2026-07-11T00:00:00+08:00", [weekdays24]), true);
});

test("可用时段：跨本地午夜按日切分，周末不可用", () => {
  // 2026-07-10 周五，2026-07-11 周六
  assert.equal(coveredByWindows("2026-07-10T20:00:00+08:00", "2026-07-11T10:00:00+08:00", [weekdays]), false);
  assert.equal(coveredByWindows("2026-07-10T20:00:00+08:00", "2026-07-11T10:00:00+08:00", [workdays]), false);
  assert.equal(coveredByWindows("2026-07-11T10:00:00+08:00", "2026-07-11T12:00:00+08:00", [workdays]), false); // 周六
  assert.equal(coveredByWindows("2026-07-13T10:00:00+08:00", "2026-07-13T12:00:00+08:00", [workdays]), true); // 周一
});

test("可用时段：任一窗口覆盖即可，always 全时段", () => {
  assert.equal(coveredByWindows("2026-07-11T03:00:00+08:00", "2026-07-11T04:00:00+08:00", [weekdays, always]), true);
  assert.equal(coveredByWindows("2026-07-10T03:00:00+08:00", "2026-07-10T04:00:00+08:00", [always]), true);
  assert.equal(coveredByWindows("2026-07-10T03:00:00+08:00", "2026-07-10T04:00:00+08:00", []), false);
  assert.equal(coveredByWindows("2026-07-10T03:00:00+08:00", "2026-07-10T03:00:00+08:00", [always]), false); // 零长度
});

test("区间重叠判定为半开区间", () => {
  assert.equal(overlaps("2026-07-10T10:00:00+08:00", "2026-07-10T11:00:00+08:00", "2026-07-10T11:00:00+08:00", "2026-07-10T12:00:00+08:00"), false);
  assert.equal(overlaps("2026-07-10T10:00:00+08:00", "2026-07-10T11:00:00+08:00", "2026-07-10T10:30:00+08:00", "2026-07-10T12:00:00+08:00"), true);
});
