import { describe, expect, it } from "vitest";
import {
  canonicalizeDomain,
  canonicalizeLinkedInCompanyUrl,
  canonicalizeLinkedInProfileUrl,
  canonicalizeWebUrl,
  ensureUrlAllowed,
} from "../src/urls.js";

describe("canonicalizeLinkedInProfileUrl", () => {
  it("preserves the canonical form", () => {
    expect(canonicalizeLinkedInProfileUrl("https://www.linkedin.com/in/eliasstravik/")).toBe(
      "https://www.linkedin.com/in/eliasstravik/",
    );
  });
  it("strips tracking params", () => {
    expect(
      canonicalizeLinkedInProfileUrl("https://www.linkedin.com/in/eliasstravik/?miniProfileUrn=xxx&trk=abc"),
    ).toBe("https://www.linkedin.com/in/eliasstravik/");
  });
  it("rewrites mobile subdomain to www", () => {
    expect(canonicalizeLinkedInProfileUrl("https://m.linkedin.com/in/EliasStravik")).toBe(
      "https://www.linkedin.com/in/eliasstravik/",
    );
  });
  it("rewrites touch subdomain to www", () => {
    expect(canonicalizeLinkedInProfileUrl("https://touch.linkedin.com/in/patrickcollison")).toBe(
      "https://www.linkedin.com/in/patrickcollison/",
    );
  });
  it("adds www to bare linkedin.com host", () => {
    expect(canonicalizeLinkedInProfileUrl("https://linkedin.com/in/elias.stravik")).toBe(
      "https://www.linkedin.com/in/elias.stravik/",
    );
  });
  it("lowercases the slug", () => {
    expect(canonicalizeLinkedInProfileUrl("https://www.linkedin.com/in/SatyaNadella")).toBe(
      "https://www.linkedin.com/in/satyanadella/",
    );
  });
  it("strips locale prefix", () => {
    expect(canonicalizeLinkedInProfileUrl("https://www.linkedin.com/de/in/darioamodei/")).toBe(
      "https://www.linkedin.com/in/darioamodei/",
    );
  });
  it("tolerates hyphens and numbers in slug", () => {
    expect(
      canonicalizeLinkedInProfileUrl("https://www.linkedin.com/in/elias-stravik-123"),
    ).toBe("https://www.linkedin.com/in/elias-stravik-123/");
  });
  it("throws on non-LinkedIn URL", () => {
    expect(() => canonicalizeLinkedInProfileUrl("https://example.com/in/foo")).toThrow(/linkedin/i);
  });
  it("throws on non-profile LinkedIn path", () => {
    expect(() =>
      canonicalizeLinkedInProfileUrl("https://www.linkedin.com/company/stripe/"),
    ).toThrow(/profile/i);
  });
  it("rejects lookalike domain", () => {
    expect(() =>
      canonicalizeLinkedInProfileUrl("https://evil-linkedin.com/in/foo"),
    ).toThrow(/linkedin/i);
  });
  it("rejects arbitrary subdomain impersonating LinkedIn", () => {
    expect(() =>
      canonicalizeLinkedInProfileUrl("https://attacker.linkedin.com.evil.com/in/foo"),
    ).toThrow(/linkedin/i);
  });
  it("rejects foo.linkedin.com subdomain", () => {
    expect(() =>
      canonicalizeLinkedInProfileUrl("https://foo.linkedin.com/in/bar"),
    ).toThrow(/linkedin/i);
  });
  it("does not strip non-locale /in/ as locale", () => {
    expect(canonicalizeLinkedInProfileUrl("https://www.linkedin.com/in/in-samuel")).toBe(
      "https://www.linkedin.com/in/in-samuel/",
    );
  });
});

describe("canonicalizeLinkedInCompanyUrl", () => {
  it("preserves canonical form", () => {
    expect(canonicalizeLinkedInCompanyUrl("https://www.linkedin.com/company/stripe/")).toBe(
      "https://www.linkedin.com/company/stripe/",
    );
  });
  it("strips about suffix", () => {
    expect(
      canonicalizeLinkedInCompanyUrl("https://www.linkedin.com/company/trustvanta/about/"),
    ).toBe("https://www.linkedin.com/company/trustvanta/");
  });
  it("preserves school and showcase path types instead of rewriting to /company/", () => {
    expect(canonicalizeLinkedInCompanyUrl("https://www.linkedin.com/school/harvard-university/"))
      .toBe("https://www.linkedin.com/school/harvard-university/");
    expect(canonicalizeLinkedInCompanyUrl("https://www.linkedin.com/showcase/aws-cloud/"))
      .toBe("https://www.linkedin.com/showcase/aws-cloud/");
  });
});

describe("canonicalizeDomain", () => {
  it("strips scheme and www", () => {
    expect(canonicalizeDomain("https://www.anthropic.com/pricing")).toBe("anthropic.com");
  });
  it("handles bare domain", () => {
    expect(canonicalizeDomain("anthropic.com")).toBe("anthropic.com");
  });
  it("handles uppercase", () => {
    expect(canonicalizeDomain("HTTPS://WWW.VERCEL.COM")).toBe("vercel.com");
  });
});

describe("ensureUrlAllowed", () => {
  it("allows public URLs", async () => {
    await expect(ensureUrlAllowed("https://anthropic.com", false)).resolves.toBeInstanceOf(URL);
  });
  it.each([
    "http://localhost:8080",
    "http://127.0.0.1",
    "http://10.0.0.5",
    "http://172.16.5.5",
    "http://192.168.1.1",
    "http://169.254.169.254/",
    "http://metadata.google.internal/",
    "http://myserver.local/",
  ])("blocks private target %s", async (url) => {
    await expect(ensureUrlAllowed(url, false)).rejects.toThrow();
  });
  it("blocks link-local IPv6", async () => {
    await expect(ensureUrlAllowed("http://[fe80::1]/", false)).rejects.toThrow();
  });
  it("blocks IPv4-mapped IPv6 loopback", async () => {
    await expect(ensureUrlAllowed("http://[::ffff:127.0.0.1]/", false)).rejects.toThrow();
  });
  it("blocks trailing-dot localhost", async () => {
    await expect(ensureUrlAllowed("http://localhost./", false)).rejects.toThrow();
  });
  it("allows private URLs when flag set", async () => {
    await expect(ensureUrlAllowed("http://localhost:8080", true)).resolves.toBeInstanceOf(URL);
  });
  it("rejects unsupported protocol", async () => {
    await expect(ensureUrlAllowed("file:///etc/passwd", false)).rejects.toThrow(/protocol/i);
  });
  it("blocks DNS-rebinding-style hosts that resolve to loopback (sslip.io)", async () => {
    await expect(ensureUrlAllowed("https://127.0.0.1.sslip.io/", false)).rejects.toThrow(
      /resolves to private/,
    );
  });
});

describe("canonicalizeWebUrl", () => {
  it("strips utm params", async () => {
    await expect(
      canonicalizeWebUrl(
        "https://anthropic.com/pricing?utm_source=x&utm_medium=y&foo=keep",
        false,
      ),
    ).resolves.toBe("https://anthropic.com/pricing?foo=keep");
  });
  it("strips fbclid", async () => {
    await expect(canonicalizeWebUrl("https://anthropic.com?fbclid=abc123", false)).resolves.toBe(
      "https://anthropic.com/",
    );
  });
  it("lowercases the host", async () => {
    await expect(canonicalizeWebUrl("HTTPS://ANTHROPIC.COM/Path", false)).resolves.toBe(
      "https://anthropic.com/Path",
    );
  });
});
