// 时间、编号与区间工具。时间对外一律使用带时区的 ISO 8601 字符串。

let counter = 0;

export function newId(prefix) {
  counter = (counter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(3, "0")}${rand}`;
}

export function toTime(value, fallback = Date.now()) {
  if (value === undefined || value === null) return new Date(fallback()).toISOString();
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw badRequest("invalid_time", `无法解析时间: ${value}`);
  return new Date(t).toISOString();
}

export function ms(iso) {
  return Date.parse(iso);
}

// 半开区间 [start, end) 是否重叠
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return ms(aStart) < ms(bEnd) && ms(bStart) < ms(aEnd);
}

const WEEKDAY_NAMES = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function localParts(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instantMs));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  return {
    weekday: WEEKDAY_NAMES[get("weekday")],
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    minutes: hour * 60 + Number(get("minute")),
    second: Number(get("second")),
  };
}

function hhmm(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes <= 24 * 60 ? minutes : null;
}

// 判断 [startIso, endIso) 是否完全落在设备可用时段内（按窗口本地时区逐日校验）。
export function coveredByWindows(startIso, endIso, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return false;
  let cursor = ms(startIso);
  const end = ms(endIso);
  if (!(end > cursor)) return false;
  const tz = windows.some((w) => w.kind === "weekly")
    ? (windows.find((w) => w.kind === "weekly").timezone || "Asia/Shanghai")
    : "Asia/Shanghai";
  while (cursor < end) {
    const p = localParts(cursor, tz);
    // 当前本地日零点对应的 UTC 毫秒：把墙钟当作 UTC 读出，再减去本地偏移。
    const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const offsetMs = wallAsUtc - cursor;
    const midnight = Date.UTC(p.year, p.month - 1, p.day) - offsetMs;
    const nextMidnight = midnight + 24 * 60 * 60 * 1000;
    const sliceEnd = Math.min(end, nextMidnight);
    if (!windows.some((w) => windowCoversSlice(w, cursor, sliceEnd, tz))) return false;
    cursor = sliceEnd;
  }
  return true;
}

function windowCoversSlice(window, startMs, endMs, tz) {
  if (window.kind === "always") return true;
  if (window.kind !== "weekly") return false;
  const startMin = hhmm(window.start);
  if (startMin === null) return false;
  const endMin = window.end === "24:00" ? 24 * 60 : hhmm(window.end);
  if (endMin === null || endMin <= startMin) return false;
  const a = localParts(startMs, window.timezone || tz);
  const b = localParts(endMs - 1, window.timezone || tz); // 右端点前一毫秒所在日
  if (a.weekday !== b.weekday) return false; // 切片已按本地零点对齐
  if (!window.weekdays.includes(a.weekday)) return false;
  return startMin <= a.minutes && b.minutes < endMin;
}

export function badRequest(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

export function requireFields(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null) {
      throw badRequest("missing_field", `缺少必填字段: ${field}`);
    }
  }
}
