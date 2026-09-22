// HTTP 适配层：把 JSON 请求路由到 DisasterService，统一错误响应。
import { createServer } from "node:http";

export function createApp(service) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { status: "ok", service: "museum-disaster-response" });
      }
      const body = await readBody(request);
      const route = match(request.method, url.pathname);
      if (!route) return json(response, 404, { error: "not_found" });
      const ctx = { service, params: route.params, query: url.searchParams, body };
      const result = await route.handler(ctx);
      return json(response, result.status ?? 200, result.data ?? { ok: true });
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) console.error(err);
      return json(response, status, { error: err.code ?? "internal_error", message: err.message });
    }
  });
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw Object.assign(new Error("请求体必须是 JSON 对象"), { status: 400, code: "invalid_body" });
    }
    return parsed;
  } catch (err) {
    if (err.status) throw err;
    throw Object.assign(new Error("请求体不是合法 JSON"), { status: 400, code: "invalid_json" });
  }
}

// ---------- 路由表 ----------
const routes = [];
function route(method, pattern, handler) {
  const names = [];
  const regex = new RegExp(
    "^" +
      pattern.replace(/:[^/]+/g, (m) => {
        names.push(m.slice(1));
        return "([^/]+)";
      }) +
      "$"
  );
  routes.push({ method, regex, names, handler });
}
function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    r.names.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
    return { handler: r.handler, params };
  }
  return null;
}

const ok = (data) => ({ status: 200, data });
const created = (data) => ({ status: 201, data });

route("GET", "/v1/directory", ({ service }) => ok(service.directory()));
route("GET", "/v1/roster", ({ service }) => ok({ people: service.roster() }));
route("GET", "/v1/reminders", ({ service }) => ok({ reminders: service.pendingReminders() }));

route("POST", "/v1/incidents", ({ service, body }) => created(service.openIncident(body)));
route("GET", "/v1/incidents/:id", ({ service, params }) => ok(service.incidentDetail(params.id)));
route("POST", "/v1/incidents/:id/close", ({ service, params, body }) => ok(service.closeIncident(params.id, body)));
route("GET", "/v1/incidents/:id/timeline", ({ service, params }) => ok({ events: service.timeline(params.id) }));

route("POST", "/v1/incidents/:id/reports", ({ service, params, body }) =>
  created(service.reportRoom(params.id, body))
);
route("GET", "/v1/incidents/:id/rooms/:roomId/assessment", ({ service, params }) =>
  ok(service.getAssessment(params.id, params.roomId))
);
route("GET", "/v1/incidents/:id/zones/:zoneId", ({ service, params }) =>
  ok(service.zoneView(params.zoneId, params.id))
);

route("POST", "/v1/incidents/:id/locks", ({ service, params, body }) => created(service.lockScope(params.id, body)));
route("POST", "/v1/incidents/:id/locks/release", ({ service, params, body }) =>
  ok(service.unlockScope(params.id, body))
);

route("POST", "/v1/incidents/:id/allocations", ({ service, params, body }) =>
  created(service.allocateResource(params.id, body))
);
route("POST", "/v1/incidents/:id/allocations/:allocId/cancel", ({ service, params, body }) =>
  ok(service.cancelAllocation(params.id, params.allocId, body))
);
route("GET", "/v1/resources/:resourceId/availability", ({ service, params, query }) =>
  ok(
    service.resourceAvailability(
      params.resourceId,
      query.get("at") ?? new Date().toISOString(),
      query.get("until") ?? undefined
    )
  )
);

route("POST", "/v1/people/:personId/check-in", ({ service, params, body }) =>
  ok(service.checkIn(params.personId, body))
);
route("POST", "/v1/people/:personId/check-out", ({ service, params, body }) =>
  ok(service.checkOut(params.personId, body))
);
route("POST", "/v1/incidents/:id/assignments", ({ service, params, body }) =>
  created(service.assignPerson(params.id, body))
);
route("POST", "/v1/incidents/:id/assignments/:asgId/cancel", ({ service, params, body }) =>
  ok(service.cancelAssignment(params.id, params.asgId, body))
);

route("POST", "/v1/incidents/:id/routes", ({ service, params, body }) =>
  created(service.activateRoute(params.id, body))
);
route("POST", "/v1/incidents/:id/routes/:routeId/close", ({ service, params, body }) =>
  ok(service.closeRoute(params.id, params.routeId, body))
);

route("POST", "/v1/incidents/:id/actions", ({ service, params, body }) =>
  created(service.createAction(params.id, body))
);
route("POST", "/v1/incidents/:id/playbook", ({ service, params, body }) =>
  created(service.instantiatePlaybook(params.id, body))
);
route("POST", "/v1/actions/:actionId/ack", ({ service, params, body }) =>
  ok(service.acknowledgeAction(params.actionId, body))
);
route("POST", "/v1/actions/:actionId/complete", ({ service, params, body }) =>
  ok(service.completeAction(params.actionId, body))
);
route("POST", "/v1/actions/:actionId/cancel", ({ service, params, body }) =>
  ok(service.cancelAction(params.actionId, body))
);

route("POST", "/v1/incidents/:id/transfers", ({ service, params, body }) =>
  created(service.createTransfer(params.id, body))
);
route("POST", "/v1/transfers/:batchId/events", ({ service, params, body }) =>
  ok(service.recordTransferEvent(params.batchId, body))
);
route("GET", "/v1/transfers/:batchId/trajectory", ({ service, params }) =>
  ok(service.transferTrajectory(params.batchId))
);
