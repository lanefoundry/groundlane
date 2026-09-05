export const UPLOAD_DEFAULT_TTL_SECONDS = 900;
export const UPLOAD_MIN_TTL_SECONDS = 60;
export const UPLOAD_HARD_MAX_TTL_SECONDS = 3_600;

export const ARTIFACT_DEFAULT_TTL_SECONDS = 86_400;
export const ARTIFACT_MIN_TTL_SECONDS = 60;
export const ARTIFACT_HARD_MAX_TTL_SECONDS = 2_592_000;

export interface ArtifactRetentionSection {
  readonly defaultTtlSeconds: number;
  readonly minTtlSeconds: number;
  readonly maxTtlSeconds: number;
}

export interface ArtifactRetentionPolicy {
  readonly upload: ArtifactRetentionSection;
  readonly artifact: ArtifactRetentionSection;
}

export interface ArtifactRetentionPolicyOverrides {
  readonly uploadMaxTtlSeconds?: number;
  readonly artifactMaxTtlSeconds?: number;
}

function operatorMaximum(
  value: number | undefined,
  defaultTtlSeconds: number,
  hardMaxTtlSeconds: number,
  label: string,
): number {
  const maximum = value ?? hardMaxTtlSeconds;
  if (!Number.isSafeInteger(maximum) || maximum < defaultTtlSeconds || maximum > hardMaxTtlSeconds) {
    throw new Error(
      `${label} must be an integer between ${String(defaultTtlSeconds)} and ${String(hardMaxTtlSeconds)} seconds`,
    );
  }
  return maximum;
}

/** Canonical upload/artifact defaults, minima, hard maxima, and operator caps. */
export function createArtifactRetentionPolicy(
  overrides: ArtifactRetentionPolicyOverrides = {},
): ArtifactRetentionPolicy {
  return {
    upload: {
      defaultTtlSeconds: UPLOAD_DEFAULT_TTL_SECONDS,
      minTtlSeconds: UPLOAD_MIN_TTL_SECONDS,
      maxTtlSeconds: operatorMaximum(
        overrides.uploadMaxTtlSeconds,
        UPLOAD_DEFAULT_TTL_SECONDS,
        UPLOAD_HARD_MAX_TTL_SECONDS,
        "uploadMaxTtlSeconds",
      ),
    },
    artifact: {
      defaultTtlSeconds: ARTIFACT_DEFAULT_TTL_SECONDS,
      minTtlSeconds: ARTIFACT_MIN_TTL_SECONDS,
      maxTtlSeconds: operatorMaximum(
        overrides.artifactMaxTtlSeconds,
        ARTIFACT_DEFAULT_TTL_SECONDS,
        ARTIFACT_HARD_MAX_TTL_SECONDS,
        "artifactMaxTtlSeconds",
      ),
    },
  };
}

export const DEFAULT_ARTIFACT_RETENTION_POLICY = createArtifactRetentionPolicy();
