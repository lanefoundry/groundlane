export interface CredentialScanResult {
  readonly found: boolean;
  readonly types: readonly string[];
  readonly count: number;
  readonly warning: string;
}

interface CredentialPattern {
  readonly type: string;
  readonly pattern: RegExp;
}

const PATTERNS: readonly CredentialPattern[] = [
  { type: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { type: "github-token-ghp", pattern: /\bghp_[A-Za-z0-9]{36,255}\b/g },
  { type: "github-token-gho", pattern: /\bgho_[A-Za-z0-9]{36,255}\b/g },
  { type: "github-token-ghs", pattern: /\bghs_[A-Za-z0-9]{36,255}\b/g },
  { type: "private-key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { type: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
  { type: "slack-token", pattern: /\bxox[bpras]-[A-Za-z0-9-]{10,255}\b/g },
  { type: "stripe-key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,255}\b/g },
  { type: "generic-api-key-param", pattern: /\b(?:api_key|apikey|api-key|secret_key|access_token)\s*[=:]\s*["']?[A-Za-z0-9_\-/.]{16,255}["']?/gi },
  { type: "bearer-token", pattern: /\bAuthorization:\s*Bearer\s+[A-Za-z0-9_\-/.]{20,255}\b/gi },
];

const MAX_SCAN_LENGTH = 500_000;

export function scanForCredentials(text: string): CredentialScanResult {
  if (text.length === 0) {
    return { found: false, types: [], count: 0, warning: "" };
  }

  const scanText = text.length > MAX_SCAN_LENGTH ? text.slice(0, MAX_SCAN_LENGTH) : text;
  const foundTypes = new Set<string>();
  let totalCount = 0;

  for (const { type, pattern } of PATTERNS) {
    const cloned = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null = cloned.exec(scanText);
    while (match !== null) {
      foundTypes.add(type);
      totalCount += 1;
      match = cloned.exec(scanText);
    }
  }

  if (totalCount === 0) {
    return { found: false, types: [], count: 0, warning: "" };
  }

  const types = [...foundTypes].sort();
  const warning = `Potential credential leak detected: ${String(totalCount)} match${totalCount === 1 ? "" : "es"} of type${types.length === 1 ? "" : "s"} ${types.join(", ")}. Review the content before forwarding.`;

  return { found: true, types, count: totalCount, warning };
}
