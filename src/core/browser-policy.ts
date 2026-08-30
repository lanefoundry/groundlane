import { GroundlaneError } from "./errors.js";
import { Deadline, withinDeadline } from "./limits.js";

export const DEFAULT_BROWSER_CHALLENGE_TIMEOUT_MS = 5_000;

export interface ChallengeWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export function detectChallenge(title: string, bodyStart: string): boolean {
  const content = `${title}\n${bodyStart}`.toLowerCase();
  return /just a moment|attention required|checking your browser|verify you are human|performing security verification/.test(content);
}

function unresolvedChallenge(): GroundlaneError {
  return new GroundlaneError(
    "UPSTREAM_ERROR",
    "browser-challenge",
    "The target access challenge could not be resolved",
    true,
  );
}

function waitForPoll(intervalMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new GroundlaneError("CANCELLED", "browser-challenge", "The request was cancelled"),
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, intervalMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function waitForChallengeToClear(
  check: () => Promise<boolean>,
  requestDeadline: Deadline,
  parent?: AbortSignal,
  options: ChallengeWaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BROWSER_CHALLENGE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new GroundlaneError("INVALID_INPUT", "browser-challenge", "Browser challenge timing must be positive");
  }
  const startedAt = performance.now();
  requestDeadline.remainingMs("browser-challenge", startedAt);
  const challengeDeadline = new Deadline(
    Math.min(timeoutMs, requestDeadline.expiresAt - startedAt),
    startedAt,
  );
  try {
    while (await withinDeadline(() => check(), challengeDeadline, parent, "browser-challenge")) {
      await withinDeadline(
        (signal) => waitForPoll(Math.min(pollIntervalMs, challengeDeadline.remainingMs("browser-challenge")), signal),
        challengeDeadline,
        parent,
        "browser-challenge",
      );
    }
  } catch (error) {
    if (error instanceof GroundlaneError && error.code === "DEADLINE_EXCEEDED") {
      try {
        requestDeadline.remainingMs("browser-challenge");
      } catch {
        throw error;
      }
      throw unresolvedChallenge();
    }
    throw error;
  }
}
