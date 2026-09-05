import { AwsV4Signer } from "aws4fetch";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const STAGING_KEY_PATTERN = /^staging\/[a-f0-9]{64}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MIME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/u;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface R2PresignedPutConfig {
  readonly accountId: string;
  readonly bucketName: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface R2PresignedPutInput {
  readonly stagingKey: string;
  readonly contentType: string;
  readonly contentLength: number;
  readonly expiresInSeconds: number;
  readonly metadata: {
    readonly intentId: string;
    readonly ownerId: string;
    readonly credentialHash: string;
    readonly expiresAt: number;
    readonly expectedDigest?: string;
  };
  readonly signingDate?: Date;
}

export interface R2PutHandoff {
  readonly method: "PUT";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

function assertConfig(config: R2PresignedPutConfig): void {
  if (!ACCOUNT_ID_PATTERN.test(config.accountId)) throw new Error("R2 account ID is invalid");
  if (!BUCKET_PATTERN.test(config.bucketName)) throw new Error("R2 bucket name is invalid");
  if (config.accessKeyId.length < 8 || config.accessKeyId.length > 256) throw new Error("R2 access key ID is invalid");
  if (config.secretAccessKey.length < 16 || config.secretAccessKey.length > 512) throw new Error("R2 secret access key is invalid");
}

function assertInput(input: R2PresignedPutInput): void {
  if (!STAGING_KEY_PATTERN.test(input.stagingKey)) throw new Error("R2 staging key is invalid");
  if (!MIME_PATTERN.test(input.contentType)) throw new Error("R2 upload content type is invalid");
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1 || input.contentLength > MAX_UPLOAD_BYTES) {
    throw new Error("R2 upload content length is invalid");
  }
  if (!Number.isSafeInteger(input.expiresInSeconds) || input.expiresInSeconds < 60 || input.expiresInSeconds > 3_600) {
    throw new Error("R2 presigned PUT expiry is invalid");
  }
  if (!/^upl_[A-Za-z0-9_-]{1,176}$/u.test(input.metadata.intentId)) throw new Error("R2 upload intent ID is invalid");
  if (input.metadata.ownerId.length < 1 || input.metadata.ownerId.length > 160 || input.metadata.ownerId.trim() !== input.metadata.ownerId) {
    throw new Error("R2 upload owner ID is invalid");
  }
  if (!HASH_PATTERN.test(input.metadata.credentialHash)) throw new Error("R2 upload credential hash is invalid");
  if (input.metadata.expectedDigest !== undefined && !/^sha256-[a-f0-9]{64}$/u.test(input.metadata.expectedDigest)) {
    throw new Error("R2 upload expected digest is invalid");
  }
  if (!Number.isSafeInteger(input.metadata.expiresAt) || input.metadata.expiresAt < 1) throw new Error("R2 upload expiry timestamp is invalid");
  if (input.signingDate !== undefined && !Number.isFinite(input.signingDate.getTime())) throw new Error("R2 signing date is invalid");
}

function awsDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
}

/**
 * Creates a direct-to-R2 S3 presigned PUT. The URL is an expiring transfer
 * capability and must never be persisted as an ArtifactRef or logged.
 */
export class R2PresignedPutHandoff {
  constructor(private readonly config: R2PresignedPutConfig) {
    assertConfig(config);
  }

  async create(input: R2PresignedPutInput): Promise<R2PutHandoff> {
    assertInput(input);
    const headers: Record<string, string> = {
      "content-length": String(input.contentLength),
      "content-type": input.contentType,
      "if-none-match": "*",
      "x-amz-meta-schema-version": "1",
      "x-amz-meta-kind": "staging",
      "x-amz-meta-intent-id": input.metadata.intentId,
      "x-amz-meta-owner-id": input.metadata.ownerId,
      "x-amz-meta-credential-binding-hash": `sha256-${input.metadata.credentialHash}`,
      "x-amz-meta-declared-mime": input.contentType,
      "x-amz-meta-declared-size": String(input.contentLength),
      "x-amz-meta-expires-at": String(input.metadata.expiresAt),
      ...(input.metadata.expectedDigest === undefined
        ? {}
        : { "x-amz-meta-digest": input.metadata.expectedDigest }),
    };
    const url = new URL(
      `https://${this.config.accountId}.r2.cloudflarestorage.com/${this.config.bucketName}/${input.stagingKey}`,
    );
    url.searchParams.set("X-Amz-Expires", String(input.expiresInSeconds));
    const signer = new AwsV4Signer({
      method: "PUT",
      url: url.toString(),
      headers,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      service: "s3",
      region: "auto",
      signQuery: true,
      allHeaders: true,
      ...(input.signingDate === undefined ? {} : { datetime: awsDate(input.signingDate) }),
    });
    const signed = await signer.sign();
    return { method: "PUT", url: signed.url.toString(), headers };
  }
}
