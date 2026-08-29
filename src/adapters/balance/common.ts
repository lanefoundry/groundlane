import { GroundlaneError } from "../../core/errors.js";

export type BalanceFetchLike = (input: string, init: RequestInit) => Promise<Response>;

const MAX_BALANCE_RESPONSE_BYTES = 64_000;

async function readBalanceBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BALANCE_RESPONSE_BYTES) {
    throw new GroundlaneError(
      "OUTPUT_LIMIT",
      "provider_balance",
      "Provider balance response exceeded the byte limit",
      true,
    );
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BALANCE_RESPONSE_BYTES) {
    throw new GroundlaneError(
      "OUTPUT_LIMIT",
      "provider_balance",
      "Provider balance response exceeded the byte limit",
      true,
    );
  }
  return text;
}

export async function balanceProviderJson(
  fetcher: BalanceFetchLike,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal });
  } catch (error) {
    if (signal.aborted) {
      throw new GroundlaneError("CANCELLED", "provider_balance", "Balance check was cancelled");
    }
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "provider_balance",
      "Provider balance request failed",
      true,
      { cause: error },
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "provider_balance",
      "Provider rejected the configured credential",
    );
  }
  if (response.status === 429) {
    throw new GroundlaneError(
      "RATE_LIMITED",
      "provider_balance",
      "Provider balance rate limit reached",
      true,
    );
  }
  if (response.status >= 500) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "provider_balance",
      "Provider balance endpoint is unavailable",
      true,
    );
  }
  if (!response.ok) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "provider_balance",
      "Provider rejected the balance request",
    );
  }
  try {
    return JSON.parse(await readBalanceBody(response)) as unknown;
  } catch (error) {
    if (error instanceof GroundlaneError) throw error;
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "provider_balance",
      "Provider balance endpoint returned malformed JSON",
      true,
    );
  }
}
