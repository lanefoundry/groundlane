import { GroundlaneError } from "../../core/errors.js";

export async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  stage: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new GroundlaneError(
      "OUTPUT_LIMIT",
      stage,
      "Provider response exceeds the byte limit",
    );
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) {
        throw new GroundlaneError("CANCELLED", stage, "The request was cancelled");
      }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new GroundlaneError(
          "OUTPUT_LIMIT",
          stage,
          "Provider response exceeds the byte limit",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
