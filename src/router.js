import { HttpError } from "./errors.js";

const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "请求体超过 1MB 限制");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "请求体不是合法 JSON");
  }
}

export function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
  }

  async function handle(request, response) {
    const url = new URL(request.url, "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    const query = Object.fromEntries(url.searchParams.entries());

    for (const route of routes) {
      if (route.method !== request.method || route.parts.length !== segments.length) continue;
      const params = {};
      let matched = true;
      for (let i = 0; i < route.parts.length; i += 1) {
        const part = route.parts[i];
        if (part.startsWith(":")) {
          params[part.slice(1)] = decodeURIComponent(segments[i]);
        } else if (part !== segments[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      const body = ["POST", "PUT", "PATCH"].includes(request.method) ? await readBody(request) : {};
      const result = await route.handler({ params, query, body, request });
      if (result !== undefined) sendJson(response, result.status ?? 200, result.payload);
      return;
    }
    throw new HttpError(404, "not_found", "接口不存在");
  }

  return {
    get: (pattern, handler) => add("GET", pattern, handler),
    post: (pattern, handler) => add("POST", pattern, handler),
    handle,
  };
}
