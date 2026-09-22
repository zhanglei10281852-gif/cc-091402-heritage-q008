# 博物馆灾害响应指挥服务

面向暴雨、内涝等突发事件的 Node.js 指挥记录服务。把**事件、区域评估、资源库存、人员签到、转移批次**串成一份可恢复的指挥记录，支持多事件并行处置。

## 核心规则

- **追加式事件日志**：所有变更（上报、封锁、分配、批次轨迹等）先 `fsync` 落盘到 `journal.jsonl` 再进入内存，配合定期快照；重启后重放恢复全部状态。
- **重复上报合并、证据保留**：同一事件同一房间只维护一份评估，原始上报全部保留在 `reports[]` 中；当前状态取**发生时间 `occurredAt`** 最新的一条（而非到达时间），冲突时间窗内状态不一致时 `conflicting=true`。
- **网络恢复补报重排**：`/reports/batch` 逐条入账，响应与 `/feed` 默认按发生时间重排，迟到上报带 `lateArrival` 标记。
- **实时资源量**：设备按时间区间计算可用量（总量 − 已分配 − 停用窗口，按区间切段取最小值），跨事件共享库存，超额分配被 409 拒绝。
- **班次不冲突**：同一人员在任何事件中都不能有重叠签到班次。
- **封锁不可被普通调度覆盖**：封锁区内的动作、设备调度、途经路线全部 409；只有带**值班长批准人 + 失效时间**的紧急替代路线可以穿越，失效后立即不可用。
- **转移优先级**：分数 = 文物脆弱等级权重 × 区域严重度权重（危险 3 / 进水 2 / 正常 1）。
- **批次全轨迹**：`prepared → departed → arrived → signed`（可 `cancelled`），每一步记录经办人与时间；签收后文物位置更新；在途文物不能重复进入批次。
- **提醒不丢**：区域复查提醒、批次签收时限提醒、手动提醒全部持久化，重启后重新武装，过期的启动即补发为通知。

## 运行

需要 Node.js 22+。

```bash
npm ci
npm start              # 默认 :8000，数据目录 .runtime（DATA_DIR 可覆盖）
npm test               # 16 个集成测试
docker compose up --build
```

所有时间字段使用带时区的 ISO 8601（如 `2026-09-22T15:00:00+08:00`）；经办人字段 `by`/`personId` 使用值班名单中的人员 ID。

## 接口

### 基础资料

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/reference/zones` | 建筑分区图 |
| GET | `/reference/artifacts?zoneId=` | 文物脆弱等级与当前位置 |
| GET | `/reference/equipment` | 设备总量与停用时段 |
| GET | `/reference/staff` | 值班名单 |
| GET | `/reference/drills` | 演练案例 |

### 事件

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/incidents` | 创建事件（`title`,`type`,`commanderId`,可选 `drillCaseId`），返回分区摘要 |
| GET | `/incidents` / `/incidents/:id` | 事件列表/详情（含各区域状态、封锁、负责人、未完成动作数） |
| POST | `/incidents/:id/close` | 值班长关闭（有未签收批次时需 `force:true`），关闭后只读 |
| GET | `/incidents/:id/timeline` | 该事件完整指挥记录（按序号的全部日志条目） |

### 区域评估与调度

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/incidents/:id/reports` | 现场/电话上报（`zoneId`,`reporterId`,`status`,`occurredAt`,可选 `waterLevel`,`note`），同房间自动合并 |
| POST | `/incidents/:id/reports/batch` | 网络恢复批量补报，返回按发生时间重排的 feed |
| GET | `/incidents/:id/feed?order=occurredAt|receivedAt` | 上报流（默认按发生时间） |
| GET | `/incidents/:id/zones/:zoneId/assessment` | 合并后的评估与全部原始证据 |
| POST | `/incidents/:id/zones/:zoneId/seal` / `unseal` | 封锁/解封（值班长） |
| POST | `/incidents/:id/zones/:zoneId/owner` | 指定负责人（须在该事件当班签到） |
| POST | `/incidents/:id/zones/:zoneId/actions` | 派发动作（封锁区拒绝） |
| POST | `/incidents/:id/actions/:actionId/complete` | 完成动作 |
| GET | `/incidents/:id/zones/:zoneId/board` | **区域看板**：负责人、评估、封锁、未完成动作、相关批次轨迹 |
| GET | `/incidents/:id/zones/:zoneId/transfer-priority` | 区域内受潮文物转移优先级 |

### 人员、资源、路线、批次

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/incidents/:id/checkins` | 签到班次（跨事件重叠 → 409 `shift_conflict`） |
| POST | `/incidents/:id/checkins/:checkinId/end` | 提前结束班次 |
| GET | `/incidents/:id/checkins` | 签到列表 |
| POST | `/incidents/:id/allocations` | 设备分配（超实时可用量 → 409 `insufficient_availability`，带可用量明细） |
| POST | `/incidents/:id/allocations/:allocationId/release` | 提前释放 |
| GET | `/incidents/:id/resources?at=` | 实时库存：总量/已分/停用/可用 |
| POST | `/incidents/:id/routes` | 路线；紧急路线 `emergency:true` 必须带 `approvedBy`（值班长）与 `expiresAt` |
| GET | `/incidents/:id/routes` | 路线列表 |
| POST | `/incidents/:id/transfers` | 创建批次：`routeId` + `artifactIds[]` 或 `autoSelect.count`；自动按优先级排序 |
| POST | `/incidents/:id/transfers/:t/depart` `/arrive` `/signoff` `/cancel` | 批次状态机，签收可带 `condition` |
| GET | `/incidents/:id/transfers` / `…/:t` | 批次（含完整 `trajectory`） |
| GET | `/incidents/:id/pending-signoffs` | 待签收任务（重启不丢） |
| POST | `/incidents/:id/reminders` | 手动提醒（`message`,`fireAt`） |
| GET | `/incidents/:id/reminders?status=pending|fired|cancelled` | 提醒 |
| GET | `/incidents/:id/notifications` | 已触发的提醒通知 |

## 数据与恢复

运行时数据（可由 `DATA_DIR` 指定，默认 `.runtime/`）：

- `journal.jsonl` — 追加式事件日志，每条 `{seq,at,type,data}`，是唯一事实来源；
- `snapshot.json` — 定期快照，仅用于加快启动，日志始终完整保留；
- 启动时检测并修复崩溃留下的半截日志行。

种子资料位于 `data/`（分区图、文物、设备时段、值班名单、演练案例），仅在日志为空时作为 `seed.loaded` 事件写入。
