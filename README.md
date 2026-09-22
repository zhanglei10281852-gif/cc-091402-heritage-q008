# 博物馆暴雨灾害响应指挥服务

面向博物馆地下库房进水等突发灾害的 Node.js 指挥记录服务：把**事件、区域评估、资源库存、人员签到/排班、转移批次**串成一条可恢复的事件链。零第三方依赖，仅用 Node.js 22 标准库。

## 核心不变量

| 需求 | 实现 |
| --- | --- |
| 可恢复指挥记录 | 所有命令落为只追加事件（`data/events.jsonl`，逐条 fsync），重启重放重建全部状态 |
| 冲突上报合并、保留原始证据 | 同房间每次上报都进 `evidence`；当前状态以**发生时间**最新者裁定，矛盾旧报标记 `contradictsCurrent`，电话来显/记录人随证据保存 |
| 网络恢复后按发生时间重排 | 上报区分 `occurredAt`（发生时间）与 `recordedAt`（接收时间）；时间线一律按发生时间排序，落盘序号保留真实接收顺序可审计 |
| 资源不超实时可用量 | 半开区间重叠检测，跨所有并行事件统一核算；取消分配即时释放 |
| 设备可用时段 | 按设备时区逐日校验周计划（`weekly`/`always`），跨午夜切片，支持 `24:00` 结束 |
| 封锁不可被普通调度覆盖 | 封锁中的分区/房间拒绝普通资源调度、排班与普通路线；进入封锁区的作业须值班长/管理员下达 |
| 紧急替代路线 | 必须 `kind=emergency`、记录 `approvedByPersonId`（值班长/管理员）和 `validUntil`，过期路线立即不可用于转移 |
| 多事件并行、无冲突班次 | 事件可并行；人员同一时刻只能有一个签到会话，排班区间跨事件做重叠检测并须被签到区间覆盖 |
| 区域视图 | 每区域返回当前负责人（`zone_lead`）、未完成动作、各房间当前评估与冲突标记 |
| 转移批次完整轨迹 | 创建→出发（负责人须在岗）→到达→**逐件签收**→完成；未全部签收不得完成；轨迹接口返回全部事件 |
| 提醒/待签收不丢 | 到期动作产生 `reminder.raised` 事件；重启即补扫，签收状态持久化 |

## 运行

```bash
npm ci
npm start                 # 默认 :8000，数据落 ./data/events.jsonl
DATA_FILE=memory npm start # 纯内存（不推荐生产）
npm test                  # 23 项测试
docker compose up --build # 数据卷 disaster-data 持久化
```

环境变量：`PORT`（8000）、`HOST`（0.0.0.0）、`DATA_FILE`、`SEED_PATH`。

基础数据（建筑分区图、文物脆弱等级、设备窗口、值班名单、演练案例）在 `reference/seed.json`，可按需替换。

## API 一览

所有写接口需 JSON body 且带操作人 `actorPersonId`；时间统一带时区 ISO 8601。错误响应：`{error, message}`，4xx 携带业务错误码（如 `capacity_exceeded`、`zone_locked`、`assignment_conflict`、`route_unavailable`）。

```
GET  /health
GET  /v1/directory                     # 分区图/文物/设备/人员/演练案例
GET  /v1/roster                        # 全员签到与当前在岗状态
GET  /v1/reminders                     # 已提醒未完成/未签收任务

POST /v1/incidents                     # 开事件（并行多个）
GET  /v1/incidents/:id                 # 总览：分区视图/动作/批次/排班/分配
POST /v1/incidents/:id/close
GET  /v1/incidents/:id/timeline        # 按发生时间重排的完整事件链

POST /v1/incidents/:id/reports         # 房间上报（支持 occurredAt 补报）
GET  /v1/incidents/:id/rooms/:rid/assessment  # 当前状态 + 全部原始证据 + 冲突
GET  /v1/incidents/:id/zones/:zid      # 区域视图：负责人/未完成动作/房间

POST /v1/incidents/:id/locks           # 封锁 {scope:zone|room, unlockAt?}
POST /v1/incidents/:id/locks/release   # 解封
POST /v1/incidents/:id/allocations     # 设备分配（容量+窗口+封锁校验）
POST /v1/incidents/:id/allocations/:a/cancel
GET  /v1/resources/:rid/availability?at=&until=

POST /v1/people/:pid/check-in|check-out
POST /v1/incidents/:id/assignments     # 排班（冲突班次/签到覆盖/封锁校验）
POST /v1/incidents/:id/assignments/:a/cancel

POST /v1/incidents/:id/routes          # 路线（emergency 须批准人+失效时间）
POST /v1/incidents/:id/routes/:r/close
POST /v1/incidents/:id/playbook        # 按演练案例一键生成处置动作

POST /v1/incidents/:id/actions
POST /v1/actions/:a/ack|complete|cancel

POST /v1/incidents/:id/transfers       # 创建批次（默认按最脆弱文物定优先级）
POST /v1/transfers/:b/events           # depart|arrive|confirm|complete|cancel
GET  /v1/transfers/:b/trajectory       # 批次完整轨迹
```

## 典型流程（暴雨地下进水）

1. 值班长开通事件，电话/现场上报各房间水情（相互矛盾的记录全部留痕，以最新发生时间为准）。
2. 配电区漏电 → 值班长封锁 `B1-C`；普通抽排调度进入该区一律 409。
3. 在可用时段内分配抽排泵/发电机（库存跨事件统一核算，超量拒绝）。
4. 人员签到后排班，指定各分区 `zone_lead`；重叠班次跨事件拒绝。
5. 主通道被淹 → 值班长批准紧急替代路线（含失效时间）。
6. 按文物脆弱等级创建转移批次，出发须负责人在岗，到达后逐件签收方可完成。
7. 动作到期自动产生提醒；网络中断期间的补报恢复后按发生时间归位；进程重启一切状态照旧。

## 工程结构

- `src/store.js` — 只追加 JSONL 事件日志（fsync、重放）
- `src/domain.js` — 命令校验与事件投影（全部业务不变量）
- `src/util.js` — 时间/区间/设备窗口（时区逐日）工具
- `src/app.js` — HTTP 路由
- `reference/seed.json` — 建筑分区图、文物、设备窗口、值班名单、演练案例
