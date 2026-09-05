import { z } from "zod";

import { documentParseInputSchema } from "../tools/document-parse.js";

export const INTERNAL_ARTIFACT_PARSE_PATH = "/internal/document-parse-artifact";
export const INTERNAL_ARTIFACT_METADATA_HEADER = "x-groundlane-artifact-metadata";
export const INTERNAL_ARTIFACT_PURPOSE = "document-parse-artifact";
const MAX_METADATA_BYTES = 16 * 1024;

const bridgeSchema = z.object({
  id: z.union([z.string().max(128), z.number().int(), z.null()]),
  deadlineAt: z.number().int().positive(),
  input: documentParseInputSchema.omit({ source: true }),
  source: z.object({
    refId: z.string().min(1).max(180),
    contentHash: z.string().regex(/^sha256-[a-f0-9]{64}$/u),
    mimeType: z.string().min(1).max(128),
    filename: z.string().min(1).max(512),
    expiresAt: z.number().int().positive(),
  }).strict(),
}).strict();

export type ArtifactParseBridgeMetadata = z.infer<typeof bridgeSchema>;

function bytesToBase64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const value = (first << 16) | (second << 8) | third;
    result += alphabet[(value >>> 18) & 63];
    result += alphabet[(value >>> 12) & 63];
    if (index + 1 < bytes.length) result += alphabet[(value >>> 6) & 63];
    if (index + 2 < bytes.length) result += alphabet[value & 63];
  }
  return result;
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const indexes = new Map([...alphabet].map((character, index) => [character, index]));
  const output: number[] = [];
  for (let offset = 0; offset < value.length; offset += 4) {
    const a = indexes.get(value[offset] ?? "");
    const b = indexes.get(value[offset + 1] ?? "");
    const c = indexes.get(value[offset + 2] ?? "");
    const d = indexes.get(value[offset + 3] ?? "");
    if (a === undefined || b === undefined) return null;
    const combined = (a << 18) | (b << 12) | ((c ?? 0) << 6) | (d ?? 0);
    output.push((combined >>> 16) & 255);
    if (c !== undefined) output.push((combined >>> 8) & 255);
    if (d !== undefined) output.push(combined & 255);
  }
  return new Uint8Array(output);
}

export function encodeArtifactParseBridgeMetadata(input: ArtifactParseBridgeMetadata): string {
  const value = bridgeSchema.parse(input);
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > MAX_METADATA_BYTES) throw new Error("artifact parse bridge metadata exceeds limit");
  return bytesToBase64Url(bytes);
}

export function decodeArtifactParseBridgeMetadata(value: string | null): ArtifactParseBridgeMetadata {
  if (value === null || value.length > Math.ceil(MAX_METADATA_BYTES * 4 / 3)) {
    throw new Error("artifact parse bridge metadata is invalid");
  }
  const bytes = base64UrlToBytes(value);
  if (bytes === null || bytes.byteLength > MAX_METADATA_BYTES) throw new Error("artifact parse bridge metadata is invalid");
  try {
    return bridgeSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
  } catch {
    throw new Error("artifact parse bridge metadata is invalid");
  }
}
