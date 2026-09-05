import {
  type DurableDocumentEffectIdentity,
  type DurableDocumentJobCaller,
  DurableDocumentJobRepository,
} from "./durable-document-jobs.js";
import { GroundlaneError } from "./errors.js";

export interface DurableDocumentExecutionPorts {
  readonly createProviderTask: (signal: AbortSignal) => Promise<string>;
  readonly performPaidCall: (signal: AbortSignal) => Promise<string>;
  readonly writeResultArtifact: (signal: AbortSignal) => Promise<string>;
}

export interface DurableDocumentExecutionInput {
  readonly jobId: string;
  /** Invocation metadata only; retries cannot choose new side-effect identities. */
  readonly operationKey: string;
  readonly nowMs: number;
}

function executionError(message: string): GroundlaneError {
  return new GroundlaneError("UPSTREAM_ERROR", "durable-document-execution", message, false);
}

function assertDispatchActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new GroundlaneError("CANCELLED", "durable-document-execution", "Document dispatch was cancelled");
  }
}

/**
 * Runs the three externally observable async-document effects behind durable
 * claim/inflight/succeeded receipts. A blocked or uncertain effect is never
 * executed again automatically, so a crash cannot duplicate provider work,
 * billing, or an immutable artifact write.
 */
export class DurableDocumentExecutor {
  constructor(
    private readonly repository: DurableDocumentJobRepository,
    private readonly ports: DurableDocumentExecutionPorts,
    private readonly clock: () => number = Date.now,
  ) {}

  async execute(
    input: DurableDocumentExecutionInput,
    caller: DurableDocumentJobCaller,
    signal: AbortSignal,
  ): Promise<string> {
    assertDispatchActive(signal);
    let lastNowMs = input.nowMs;
    const now = (): number => {
      lastNowMs = Math.max(lastNowMs, this.clock());
      return lastNowMs;
    };
    let current = await this.repository.get(input.jobId, caller, now());
    if (current.job.status === "completed" && current.job.resultArtifactRef !== null) {
      return current.job.resultArtifactRef;
    }
    if (["failed", "cancelled", "expired"].includes(current.job.status)) {
      throw executionError("Durable document job is terminal");
    }
    if (current.job.status !== "running") {
      const running = await this.repository.transition(
        input.jobId,
        caller,
        current.revision,
        "running",
        now(),
      );
      if (running.status !== "updated") throw executionError("Durable document job transition conflicted");
      current = running.value;
    }

    await this.runEffect(
      { jobId: input.jobId, effectKind: "provider_task_create", operationKey: "document-execution-v1:provider" },
      caller,
      now,
      signal,
      this.ports.createProviderTask,
    );
    await this.runEffect(
      { jobId: input.jobId, effectKind: "paid_upstream_call", operationKey: "document-execution-v1:paid" },
      caller,
      now,
      signal,
      this.ports.performPaidCall,
    );
    const artifactRef = await this.runEffect(
      { jobId: input.jobId, effectKind: "artifact_write", operationKey: "document-execution-v1:artifact" },
      caller,
      now,
      signal,
      this.ports.writeResultArtifact,
    );
    assertDispatchActive(signal);
    const latest = await this.repository.get(input.jobId, caller, now());
    if (latest.job.status === "completed" && latest.job.resultArtifactRef === artifactRef) return artifactRef;
    const completed = await this.repository.transition(
      input.jobId,
      caller,
      latest.revision,
      "completed",
      now(),
      { resultArtifactRef: artifactRef },
    );
    if (completed.status !== "updated") throw executionError("Durable document completion conflicted");
    return artifactRef;
  }

  private async runEffect(
    identity: DurableDocumentEffectIdentity,
    caller: DurableDocumentJobCaller,
    now: () => number,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<string>,
  ): Promise<string> {
    assertDispatchActive(signal);
    const begun = await this.repository.beginEffect(identity, caller, now());
    if (begun.status === "replay") return begun.receipt;
    if (begun.status === "blocked") {
      throw executionError(`Durable ${identity.effectKind} outcome is ${begun.reason}`);
    }
    assertDispatchActive(signal);
    const inflight = await this.repository.markEffectInflight(
      identity,
      caller,
      begun.revision,
      now(),
    );
    let receipt: string;
    try {
      assertDispatchActive(signal);
      receipt = await operation(signal);
      await this.repository.markEffectSucceeded(
        identity,
        caller,
        inflight.revision,
        now(),
        receipt,
      );
    } catch {
      try {
        await this.repository.markEffectUncertain(
          identity,
          caller,
          inflight.revision,
          now(),
        );
      } catch {
        // The durable inflight record is already fail-closed if this CAS races.
      }
      throw executionError(`Durable ${identity.effectKind} outcome is uncertain`);
    }
    return receipt;
  }
}
