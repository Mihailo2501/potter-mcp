import { isIP } from "node:net";
import { lookup } from "node:dns/promises";


const PRIVATE_IPV4_RANGES: Array<[number[], number[]]> = [
  [[10, 0, 0, 0], [10, 255, 255, 255]],
  [[172, 16, 0, 0], [172, 31, 255, 255]],
  [[192, 168, 0, 0], [192, 168, 255, 255]],
  [[127, 0, 0, 0], [127, 255, 255, 255]],
  [[169, 254, 0, 0], [169, 254, 255, 255]],
  [[0, 0, 0, 0], [0, 255, 255, 255]],
];

const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
]);

const LINKEDIN_TRACKING_PARAMS = new Set([
  "trk",
  "trkInfo",
  "lipi",
  "lici",
  "originalSubdomain",
  "original_referer",
  "midToken",
  "midSig",
  "rp",
  "miniProfileUrn",
  "profileUrn",
]);

const isPrivateIPv4 = (ip: string): boolean => {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4) return false;
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  return PRIVATE_IPV4_RANGES.some(([lo, hi]) =>
    parts.every((p, i) => {
      const loVal = lo[i];
      const hiVal = hi[i];
      return loVal !== undefined && hiVal !== undefined && p >= loVal && p <= hiVal;
    }),
  );
};

const isPrivateIPv6 = (ip: string): boolean => {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  return false;
};

const unwrapIPv4FromIPv6 = (ipv6: string): string | null => {
  const lower = ipv6.toLowerCase();
  const dotMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotMatch && dotMatch[1]) return dotMatch[1];
  const hexMatch = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMatch && hexMatch[1] && hexMatch[2]) {
    const high = parseInt(hexMatch[1], 16);
    const low = parseInt(hexMatch[2], 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }
  return null;
};

// Note: this guard validates the user-provided URL only. It does not follow HTTP redirects;
// downstream fetchers (Firecrawl, Stagehand/Browserbase, Chromium) handle their own redirect
// chains. For redirect-revalidation guarantees, Potter relies on those providers' SSRF protections.
export const ensureUrlAllowed = async (input: string, allowPrivate: boolean): Promise<URL> => {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol ${parsed.protocol} in ${input}`);
  }
  const rawHost = parsed.hostname.toLowerCase();
  if (rawHost === "") throw new Error(`URL has empty hostname: ${input}`);

  if (allowPrivate) return parsed;

  const hostname = rawHost.replace(/\.$/, "");

  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".localhost")
  ) {
    throw new Error(`Blocked private hostname: ${hostname}`);
  }

  if (METADATA_HOSTS.has(hostname)) {
    throw new Error(`Blocked cloud metadata host: ${hostname}`);
  }

  const stripped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const family = isIP(stripped);
  if (family === 4 && isPrivateIPv4(stripped)) {
    throw new Error(`Blocked private IPv4: ${hostname}`);
  }
  if (family === 6) {
    const mapped = unwrapIPv4FromIPv6(stripped);
    if (mapped && isIP(mapped) === 4 && isPrivateIPv4(mapped)) {
      throw new Error(`Blocked IPv4-mapped IPv6 loopback/private: ${hostname}`);
    }
    if (isPrivateIPv6(stripped)) {
      throw new Error(`Blocked private IPv6: ${hostname}`);
    }
  }

  // Catch DNS-rebinding-style bypasses (e.g. 127.0.0.1.sslip.io, attacker.example.com → 10.x.x.x)
  // by resolving the hostname and checking ALL returned IP addresses against private ranges.
  // Only runs for non-literal hosts.
  if (family === 0) {
    let resolvedAddresses: Array<{ address: string; family: number }>;
    try {
      resolvedAddresses = await lookup(stripped, { all: true });
    } catch (err) {
      // Fail closed on ANY DNS error. ENOTFOUND/ENODATA mean the resolver returned no
      // records, but in a sandboxed/restricted-DNS environment this could mask a real
      // resolution that would happen at fetch time (TOCTOU). Treating "I don't know"
      // as "block" is the only way to keep the guard load-bearing.
      throw new Error(`Blocked: DNS resolution failed for ${hostname} (${(err as Error).message})`);
    }
    for (const { address: addr, family: af } of resolvedAddresses) {
      if (af === 4 && isPrivateIPv4(addr)) {
        throw new Error(`Blocked: ${hostname} resolves to private IPv4 ${addr}`);
      }
      if (af === 6) {
        const mapped6 = unwrapIPv4FromIPv6(addr);
        if (mapped6 && isIP(mapped6) === 4 && isPrivateIPv4(mapped6)) {
          throw new Error(`Blocked: ${hostname} resolves to IPv4-mapped IPv6 ${addr}`);
        }
        if (isPrivateIPv6(addr)) {
          throw new Error(`Blocked: ${hostname} resolves to private IPv6 ${addr}`);
        }
      }
      if (METADATA_HOSTS.has(addr)) {
        throw new Error(`Blocked: ${hostname} resolves to metadata host ${addr}`);
      }
    }
  }

  return parsed;
};

const LINKEDIN_ACCEPTED_HOSTS = new Set([
  "linkedin.com",
  "www.linkedin.com",
  "m.linkedin.com",
  "touch.linkedin.com",
]);

// LinkedIn serves regional content under <country-code>.linkedin.com. Accept any 2-letter
// ASCII subdomain prefix (covers all ISO 3166-1 alpha-2 codes LinkedIn actively serves).
// Three-or-more-letter prefixes like foo.linkedin.com stay rejected because they're not
// ISO country codes and don't correspond to LinkedIn-served properties.
const REGIONAL_LINKEDIN_HOST_RE = /^[a-z]{2}\.linkedin\.com$/;

const isAcceptedLinkedInHost = (host: string): boolean => {
  if (LINKEDIN_ACCEPTED_HOSTS.has(host)) return true;
  return REGIONAL_LINKEDIN_HOST_RE.test(host);
};

export const isLinkedInUrl = (input: string): boolean => {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return isAcceptedLinkedInHost(host);
  } catch {
    return false;
  }
};

export const isLinkedInDomain = (input: string): boolean => {
  try {
    const domain = canonicalizeDomain(input);
    return isAcceptedLinkedInHost(domain) || domain === "lnkd.in";
  } catch {
    return false;
  }
};

const normalizeLinkedInHost = (input: string): string => {
  const url = new URL(input);
  const rawHost = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!isAcceptedLinkedInHost(rawHost)) {
    throw new Error(`Not a LinkedIn URL: ${input}`);
  }
  return "www.linkedin.com";
};

const KNOWN_LOCALES = new Set([
  "en",
  "de",
  "es",
  "fr",
  "it",
  "pt",
  "nl",
  "ja",
  "ko",
  "zh",
  "ar",
  "ru",
  "pl",
  "sv",
  "cs",
  "tr",
]);

const stripKnownLocale = (path: string): string => {
  const m = path.match(/^\/([a-z]{2})\//i);
  if (m && m[1] && KNOWN_LOCALES.has(m[1].toLowerCase())) {
    return path.slice(3);
  }
  return path;
};

export const canonicalizeLinkedInProfileUrl = (input: string): string => {
  const url = new URL(input);
  const host = normalizeLinkedInHost(input);
  const path = stripKnownLocale(url.pathname);
  const match = path.match(/^\/in\/([^/?#]+)/i);
  const slug = match?.[1];
  if (!slug) throw new Error(`Not a LinkedIn profile URL: ${input}`);
  return `https://${host}/in/${slug.toLowerCase()}/`;
};

export const canonicalizeLinkedInCompanyUrl = (input: string): string => {
  const url = new URL(input);
  const host = normalizeLinkedInHost(input);
  const path = stripKnownLocale(url.pathname);
  const match = path.match(/^\/(company|school|showcase)\/([^/?#]+)/i);
  const pathType = match?.[1]?.toLowerCase();
  const slug = match?.[2];
  if (!pathType || !slug) throw new Error(`Not a LinkedIn company URL: ${input}`);
  return `https://${host}/${pathType}/${slug.toLowerCase()}/`;
};

export const canonicalizeDomain = (input: string): string => {
  const raw = input.trim();
  const prefixed = raw.includes("://") ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(prefixed);
  } catch {
    throw new Error(`Invalid domain: ${input}`);
  }
  return url.hostname.toLowerCase().replace(/^www\./, "");
};

export const stripTrackingParams = (url: URL): URL => {
  const copy = new URL(url.toString());
  const toDelete: string[] = [];
  for (const key of copy.searchParams.keys()) {
    if (LINKEDIN_TRACKING_PARAMS.has(key) || key.startsWith("utm_") || key === "fbclid") {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) copy.searchParams.delete(key);
  return copy;
};

export const slugFromLinkedInProfileUrl = (input: string): string => {
  const canonical = canonicalizeLinkedInProfileUrl(input);
  const m = canonical.match(/\/in\/([^/?#]+)/);
  return m?.[1] ?? "";
};

export const slugFromLinkedInCompanyUrl = (input: string): string => {
  const canonical = canonicalizeLinkedInCompanyUrl(input);
  const m = canonical.match(/\/company\/([^/?#]+)/);
  return m?.[1] ?? "";
};

export const canonicalizeWebUrl = async (input: string, allowPrivate: boolean): Promise<string> => {
  const parsed = await ensureUrlAllowed(input, allowPrivate);
  const stripped = stripTrackingParams(parsed);
  stripped.hostname = stripped.hostname.toLowerCase();
  return stripped.toString();
};
