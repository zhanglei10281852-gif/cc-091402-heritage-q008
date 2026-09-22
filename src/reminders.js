/**
 * 提醒调度器：所有提醒都持久化在事件日志里。
 * 启动时扫描待触发提醒重新武装定时器；已过期的立即补发，重启不丢提醒。
 */
export function createScheduler({ store, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  const timers = new Map();

  function fire(reminderId) {
    timers.delete(reminderId);
    const reminder = store.state.reminders[reminderId];
    if (!reminder || reminder.status !== "pending") return;
    store.append("reminder.fired", { reminderId, at: new Date(store.now()).toISOString() });
  }

  function arm(reminder) {
    if (timers.has(reminder.id)) return;
    const delay = Math.max(0, Date.parse(reminder.fireAt) - store.now());
    const timer = setTimeoutFn(() => fire(reminder.id), delay);
    // 提醒定时器不应阻止进程退出（进程存活时自然触发）
    if (typeof timer.unref === "function") timer.unref();
    timers.set(reminder.id, timer);
  }

  return {
    /** 启动时调用：为全部待触发提醒重新定时，过期的立即触发。 */
    armAll() {
      for (const reminder of Object.values(store.state.reminders)) {
        if (reminder.status === "pending") arm(reminder);
      }
    },
    arm,
    disarm(reminderId) {
      const timer = timers.get(reminderId);
      if (timer) {
        clearTimeoutFn(timer);
        timers.delete(reminderId);
      }
    },
    stop() {
      for (const timer of timers.values()) clearTimeoutFn(timer);
      timers.clear();
    },
    get pendingTimerCount() {
      return timers.size;
    },
  };
}
