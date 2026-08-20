import { GroundlaneError } from "./errors.js";

export class Deadline {
  readonly expiresAt: number;

  constructor(timeoutMs: number, now = performance.now()) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new GroundlaneError("INVALID_INPUT", "deadline", "Timeout must be a positive number");
    }
    this.expiresAt = now + timeoutMs;
  }

  remainingMs(stage = "request", now = performance.now()): number {
    const remaining = Math.ceil(this.expiresAt - now);
    if (remaining <= 0) {
      throw new GroundlaneError("DEADLINE_EXCEEDED", stage, "The request deadline was exceeded", true);
    }
    return remaining;
  }

  signal(parent?: AbortSignal, stage = "request"): AbortSignal {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort(parent?.reason);
    if (parent?.aborted) abort();
    else parent?.addEventListener("abort", abort, { once: true });
    try {
      timeout = setTimeout(
        () => controller.abort(new GroundlaneError("DEADLINE_EXCEEDED", stage, "The request deadline was exceeded", true)),
        this.remainingMs(stage),
      );
    } catch (error) {
      parent?.removeEventListener("abort", abort);
      throw error;
    }
    controller.signal.addEventListener("abort", () => {
      if (timeout) clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    }, { once: true });
    timeout.unref?.();
    return controller.signal;
  }
}

export async function withinDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadline: Deadline,
  parent: AbortSignal | undefined,
  stage: string,
): Promise<T> {
  deadline.remainingMs(stage);
  if (parent?.aborted) throw new GroundlaneError("CANCELLED", stage, "The request was cancelled");
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new GroundlaneError("DEADLINE_EXCEEDED", stage, "The request deadline was exceeded", true)), deadline.remainingMs(stage));
  const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new GroundlaneError("CANCELLED", stage, "The request was cancelled")), { once: true }));
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } catch (error) {
    if (controller.signal.aborted) {
      if (controller.signal.reason instanceof GroundlaneError) throw controller.signal.reason;
      throw new GroundlaneError("CANCELLED", stage, "The request was cancelled");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abortFromParent);
  }
}

interface QueueEntry {
  resolve: (release: () => void) => void;
  reject: (reason: GroundlaneError) => void;
  signal: AbortSignal | undefined;
  abort: (() => void) | undefined;
  timer: ReturnType<typeof setTimeout>;
}

export class ConcurrencyLimiter {
  private activeCount = 0;
  private readonly queue: QueueEntry[] = [];

  constructor(readonly limit: number, readonly maxQueue: number) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(maxQueue) || maxQueue < 0) {
      throw new GroundlaneError("INVALID_INPUT", "concurrency", "Concurrency limits must be non-negative integers");
    }
  }

  get active(): number { return this.activeCount; }
  get queued(): number { return this.queue.length; }

  acquire(deadline: Deadline, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new GroundlaneError("CANCELLED", "queue", "The request was cancelled"));
    if (this.activeCount < this.limit) {
      this.activeCount += 1;
      return Promise.resolve(this.releaseFactory());
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new GroundlaneError("CONCURRENCY_LIMIT", "queue", "The request queue is full", true));
    }
    return new Promise((resolve, reject) => {
      const entry: QueueEntry = {
        resolve,
        reject,
        signal,
        abort: undefined,
        timer: setTimeout(() => this.remove(entry, new GroundlaneError("DEADLINE_EXCEEDED", "queue", "The request deadline was exceeded while queued", true)), deadline.remainingMs("queue")),
      };
      entry.abort = () => this.remove(entry, new GroundlaneError("CANCELLED", "queue", "The request was cancelled while queued"));
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
    });
  }

  private remove(entry: QueueEntry, error: GroundlaneError): void {
    const index = this.queue.indexOf(entry);
    if (index === -1) return;
    this.queue.splice(index, 1);
    clearTimeout(entry.timer);
    if (entry.abort) entry.signal?.removeEventListener("abort", entry.abort);
    entry.reject(error);
  }

  private releaseFactory(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (!next) {
        this.activeCount -= 1;
        return;
      }
      clearTimeout(next.timer);
      if (next.abort) next.signal?.removeEventListener("abort", next.abort);
      next.resolve(this.releaseFactory());
    };
  }
}

export function truncateUnicode(value: string, maxChars: number): { value: string; truncated: boolean; originalLength: number; returnedLength: number } {
  if (!Number.isInteger(maxChars) || maxChars < 0) throw new GroundlaneError("INVALID_INPUT", "output", "Character limit must be a non-negative integer");
  const characters = Array.from(value);
  const result = characters.slice(0, maxChars).join("");
  return { value: result, truncated: characters.length > maxChars, originalLength: characters.length, returnedLength: Math.min(characters.length, maxChars) };
}
