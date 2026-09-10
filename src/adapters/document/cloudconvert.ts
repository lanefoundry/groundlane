import { GroundlaneError } from "../../core/errors.js";

const ORIGIN = "https://api.cloudconvert.com/v2";
const MAX_INPUT_BYTES = 10 * 1024 * 1024;

export interface CloudConvertOptions {
  readonly apiKey: string;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export interface ConversionResult {
  readonly bytes: Uint8Array;
  readonly outputMimeType: string;
  readonly outputFilename: string;
  readonly engine: string;
}

const CONVERSION_MAP: Record<string, { outputFormat: string; outputMime: string }> = {
  "application/msword": { outputFormat: "docx", outputMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  "application/vnd.ms-excel": { outputFormat: "xlsx", outputMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  "application/vnd.ms-powerpoint": { outputFormat: "pptx", outputMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};

const EXTENSION_MAP: Record<string, { outputFormat: string; outputMime: string }> = {
  doc: { outputFormat: "docx", outputMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xls: { outputFormat: "xlsx", outputMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  ppt: { outputFormat: "pptx", outputMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};

function failure(
  code: "UPSTREAM_ERROR" | "INVALID_INPUT" | "RATE_LIMITED" | "OUTPUT_LIMIT",
  message: string,
): GroundlaneError {
  return new GroundlaneError(code, "document-convert", message, code === "RATE_LIMITED");
}

export function resolveConversion(
  mimeType: string,
  filename: string,
): { outputFormat: string; outputMime: string } | undefined {
  const baseMime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (baseMime in CONVERSION_MAP) return CONVERSION_MAP[baseMime];
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext in EXTENSION_MAP) return EXTENSION_MAP[ext];
  return undefined;
}

export class CloudConvertProvider {
  readonly providerId = "cloudconvert";
  private readonly apiKey: string;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(options: CloudConvertOptions) {
    if (!options.apiKey.trim() || /[\r\n]/u.test(options.apiKey)) {
      throw failure("INVALID_INPUT", "CloudConvert requires a valid API key");
    }
    this.apiKey = options.apiKey;
    this.maxBytes = options.maxBytes ?? MAX_INPUT_BYTES;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async convert(
    source: Uint8Array,
    mimeType: string,
    filename: string,
    signal: AbortSignal,
  ): Promise<ConversionResult> {
    if (source.byteLength < 1) throw failure("INVALID_INPUT", "Empty source");
    if (source.byteLength > this.maxBytes) {
      throw failure("INVALID_INPUT", `Source exceeds the ${this.maxBytes} byte limit`);
    }

    const conversion = resolveConversion(mimeType, filename);
    if (conversion === undefined) {
      throw failure("INVALID_INPUT", "Unsupported format for conversion. Supported: .doc, .xls, .ppt");
    }

    const inputFormat = filename.toLowerCase().split(".").pop() ?? "doc";
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);

    // Step 1: Create job with upload + convert + export tasks
    const jobBody = {
      tasks: {
        upload: { operation: "import/upload" },
        convert: {
          operation: "convert",
          input: ["upload"],
          input_format: inputFormat,
          output_format: conversion.outputFormat,
        },
        export: {
          operation: "export/url",
          input: ["convert"],
        },
      },
    };

    let job: Record<string, unknown>;
    try {
      const jobRes = await fetch(`${ORIGIN}/jobs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(jobBody),
        signal: combined,
      });
      if (jobRes.status === 429) throw failure("RATE_LIMITED", "CloudConvert rate limit exceeded");
      if (!jobRes.ok) throw failure("UPSTREAM_ERROR", `CloudConvert job creation returned HTTP ${jobRes.status}`);
      const parsed = await jobRes.json() as Record<string, unknown>;
      job = (parsed as Record<string, unknown>).data as Record<string, unknown>;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof GroundlaneError) throw error;
      throw failure("UPSTREAM_ERROR", "CloudConvert job creation failed");
    }

    // Step 2: Upload file to the upload task
    const tasks = job.tasks as Array<Record<string, unknown>>;
    const uploadTask = tasks.find((t) => t.name === "upload");
    if (!uploadTask?.result) throw failure("UPSTREAM_ERROR", "CloudConvert did not return an upload URL");
    const uploadResult = uploadTask.result as Record<string, unknown>;
    const uploadForm = uploadResult.form as Record<string, unknown>;
    const uploadUrl = uploadForm.url as string;
    const uploadParams = uploadForm.parameters as Record<string, string>;

    const form = new FormData();
    for (const [key, value] of Object.entries(uploadParams)) {
      form.set(key, value);
    }
    form.set("file", new Blob([source.buffer as ArrayBuffer], { type: mimeType }), filename);

    try {
      const uploadRes = await fetch(uploadUrl, {
        method: "POST",
        body: form,
        signal: combined,
      });
      if (!uploadRes.ok) throw failure("UPSTREAM_ERROR", `CloudConvert upload returned HTTP ${uploadRes.status}`);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof GroundlaneError) throw error;
      throw failure("UPSTREAM_ERROR", "CloudConvert upload failed");
    }

    // Step 3: Poll for completion
    const jobId = job.id as string;
    const deadline = Date.now() + this.timeoutMs;
    let exportUrl: string | undefined;

    while (Date.now() < deadline) {
      signal.throwIfAborted();
      await new Promise((resolve) => { setTimeout(resolve, 2_000); });

      let status: Record<string, unknown>;
      try {
        const statusRes = await fetch(`${ORIGIN}/jobs/${jobId}`, {
          headers: { authorization: `Bearer ${this.apiKey}` },
          signal: combined,
        });
        if (!statusRes.ok) throw failure("UPSTREAM_ERROR", "CloudConvert status check failed");
        const parsed = await statusRes.json() as Record<string, unknown>;
        status = parsed.data as Record<string, unknown>;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof GroundlaneError) throw error;
        throw failure("UPSTREAM_ERROR", "CloudConvert status check failed");
      }

      if (status.status === "error") throw failure("UPSTREAM_ERROR", "CloudConvert conversion failed");
      if (status.status === "finished") {
        const statusTasks = status.tasks as Array<Record<string, unknown>>;
        const exportTask = statusTasks.find((t) => t.name === "export");
        if (exportTask?.result) {
          const files = (exportTask.result as Record<string, unknown>).files as Array<Record<string, unknown>>;
          if (files?.[0]?.url) exportUrl = files[0].url as string;
        }
        break;
      }
    }

    if (exportUrl === undefined) throw failure("UPSTREAM_ERROR", "CloudConvert conversion timed out or produced no output");

    // Step 4: Download result
    let resultBytes: Uint8Array;
    try {
      const downloadRes = await fetch(exportUrl, { signal: combined });
      if (!downloadRes.ok) throw failure("UPSTREAM_ERROR", "CloudConvert download failed");
      resultBytes = new Uint8Array(await downloadRes.arrayBuffer());
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof GroundlaneError) throw error;
      throw failure("UPSTREAM_ERROR", "CloudConvert download failed");
    }

    if (resultBytes.byteLength > this.maxBytes) {
      throw failure("OUTPUT_LIMIT", "Converted file exceeds the byte limit");
    }

    const baseName = filename.replace(/\.[^.]+$/u, "");
    return {
      bytes: resultBytes,
      outputMimeType: conversion.outputMime,
      outputFilename: `${baseName}.${conversion.outputFormat}`,
      engine: "cloudconvert",
    };
  }
}
