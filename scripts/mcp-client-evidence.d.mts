export const scenarios: string[];
export function localEndpoint(value: string): string;
export function sanitize(text: string, secrets?: (string | undefined)[]): string;
export interface Execution {
  code: number | null;
  signal: string | null;
  stopReason: string | undefined;
  stdout: string;
  stderr: string;
}
export function boundedProcess(executable: string, args: string[], options: {
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  maxBytes: number;
  input?: string;
}): Promise<Execution>;
export function summarizeCapture(execution: Execution, transcript: string): {
  captureStatus: string;
  status: string;
  reason: string;
  transcriptSha256: string;
  scenarios: { name: string; status: string }[];
};
