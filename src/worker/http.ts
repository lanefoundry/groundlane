export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
  requestId: string;
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  requestId: string,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("x-request-id", requestId);

  return new Response(
    JSON.stringify({ error: { code, message }, requestId } satisfies ErrorEnvelope),
    { status, headers: responseHeaders },
  );
}

export function logWorkerEvent(event: {
  level: "info" | "error";
  event: string;
  requestId: string;
  status: number;
}): void {
  const serialized = JSON.stringify(event);
  if (event.level === "error") {
    console.error(serialized);
    return;
  }
  console.log(serialized);
}
