// 只追加事件日志（JSONL）。所有命令产生的事件先落盘并 fsync，再投影到内存状态；
// 进程重启时重放日志恢复全部指挥记录。filePath 为 null 时退化为纯内存模式（测试用）。
import { mkdirSync, openSync, closeSync, writeSync, fsyncSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export class EventStore {
  constructor(filePath, clock = () => new Date().toISOString()) {
    this.filePath = filePath;
    this.clock = clock;
    this.fd = null;
    this.seq = 0;
  }

  start(handler) {
    this.handler = handler;
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    if (existsSync(this.filePath)) {
      const lines = readFileSync(this.filePath, "utf8").split("\n").filter((l) => l.trim());
      for (const line of lines) {
        const event = JSON.parse(line);
        this.seq = Math.max(this.seq, event.seq);
        this.handler(event);
      }
    }
  }

  // 同步追加：Node 单线程内，命令从校验到 fsync 一气呵成，无需额外加锁。
  // 文件句柄懒打开——没有任何写入时不在磁盘上留下文件。
  append(type, data, { incidentId = null, occurredAt = null, actor = null } = {}) {
    const event = {
      seq: ++this.seq,
      type,
      incidentId,
      actor,
      occurredAt: occurredAt || this.clock(),
      recordedAt: this.clock(),
      data,
    };
    if (this.filePath) {
      if (this.fd === null) this.fd = openSync(this.filePath, "a");
      writeSync(this.fd, JSON.stringify(event) + "\n");
      fsyncSync(this.fd);
    }
    this.handler(event);
    return event;
  }

  close() {
    if (this.fd !== null) {
      fsyncSync(this.fd);
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
