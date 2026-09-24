// Domain allowlist normalization shared by the loop boundary checks and the
// agent-browser containment flag. Both layers must agree on one meaning: an
// entry authorizes its own host and any subdomain, with or without a `*.` prefix.
export function normalizeAllowedDomain(entry: string): string | undefined {
  const normalized = entry.trim().toLowerCase().replace(/^\.+/, "");
  if (!normalized) return undefined;
  const bare = normalized.startsWith("*.") ? normalized.slice(2) : normalized;
  return bare || undefined;
}

export function matchesAllowedDomain(hostname: string, domains: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return domains.some((entry) => {
    const domain = normalizeAllowedDomain(entry);
    return domain !== undefined && (host === domain || host.endsWith(`.${domain}`));
  });
}

export function allowedDomainPatterns(domains: string[]): string[] {
  const patterns = new Set<string>();
  for (const entry of domains) {
    const domain = normalizeAllowedDomain(entry);
    if (domain === undefined) continue;
    patterns.add(domain);
    patterns.add(`*.${domain}`);
  }
  return [...patterns];
}
