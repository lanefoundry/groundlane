const encoder = new TextEncoder();

export interface TimingSafeSubtleCrypto {
  digest(
    algorithm: AlgorithmIdentifier,
    data: BufferSource,
  ): Promise<ArrayBuffer>;
  timingSafeEqual(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ): boolean;
}

export function parseBearerToken(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(value);
  return match?.[1];
}

export async function timingSafeTokenEqual(
  candidate: string,
  expected: string,
  subtle: TimingSafeSubtleCrypto,
): Promise<boolean> {
  const [candidateDigest, expectedDigest] = await Promise.all([
    subtle.digest("SHA-256", encoder.encode(candidate)),
    subtle.digest("SHA-256", encoder.encode(expected)),
  ]);

  return subtle.timingSafeEqual(candidateDigest, expectedDigest);
}

export async function hasValidBearerToken(
  authorization: string | null,
  expectedToken: string,
  subtle: TimingSafeSubtleCrypto,
): Promise<boolean> {
  const candidate = parseBearerToken(authorization) ?? "";
  return timingSafeTokenEqual(candidate, expectedToken, subtle);
}
