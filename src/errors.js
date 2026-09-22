export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message, details) {
  return new HttpError(400, "validation_error", message, details);
}

export function notFound(message,  details) {
  return new HttpError(404, "not_found", message, details);
}

export function forbidden(message, details) {
  return new HttpError(403, "forbidden", message, details);
}

export function conflict(code, message, details) {
  return new HttpError(409, code, message, details);
}
