import { loadConfig } from "../config.js";
import { PotterError } from "../errors.js";
import {
  CanonicalCompanySchema,
  CanonicalEmployeeSchema,
  CanonicalPostSchema,
  CanonicalProfileSchema,
  type CanonicalCompany,
  type CanonicalEducation,
  type CanonicalEmployee,
  type CanonicalExperience,
  type CanonicalLocation,
  type CanonicalPost,
  type CanonicalPostMedia,
  type CanonicalProfile,
  type DataQuality,
} from "../types.js";
import {
  canonicalizeLinkedInCompanyUrl,
  canonicalizeLinkedInProfileUrl,
  slugFromLinkedInProfileUrl,
} from "../urls.js";
import { getApify, type Result } from "./apify.js";

export type LinkedInActorCategory = "profile" | "company" | "posts" | "employees";

export const DEFAULT_ACTORS: Record<LinkedInActorCategory, string> = {
  profile: "harvestapi/linkedin-profile-scraper",
  company: "harvestapi/linkedin-company",
  posts: "apimaestro/linkedin-profile-posts",
  employees: "apimaestro/linkedin-company-employees-scraper-no-cookies",
};

const resolveActor = (category: LinkedInActorCategory): string => {
  const cfg = loadConfig();
  switch (category) {
    case "profile":
      return cfg.apifyLinkedinProfileActor ?? DEFAULT_ACTORS.profile;
    case "company":
      return cfg.apifyLinkedinCompanyActor ?? DEFAULT_ACTORS.company;
    case "posts":
      return cfg.apifyLinkedinPostsActor ?? DEFAULT_ACTORS.posts;
    case "employees":
      return cfg.apifyLinkedinEmployeesActorInternal ?? DEFAULT_ACTORS.employees;
  }
};

const slugFromProfileUrl = (url: string): string => {
  try {
    return slugFromLinkedInProfileUrl(url);
  } catch {
    const m = url.match(/\/in\/([^/?#]+)/i);
    return m?.[1]?.toLowerCase() ?? url;
  }
};

const stringOrNull = (v: unknown): string | null => {
  if (typeof v === "string" && v.trim().length > 0) return v;
  return null;
};

const numberOrNull = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
};

const formatMonthYear = (obj: unknown): string | null => {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as { text?: unknown; year?: unknown; month?: unknown };
  if (typeof o.text === "string" && o.text.trim().length > 0) return o.text;
  if (typeof o.year === "number") return String(o.year);
  return null;
};

const buildInputForActor = (
  actorId: string,
  category: LinkedInActorCategory,
  url: string,
  options: ActorCallOptions,
): Record<string, unknown> => {
  switch (actorId) {
    case "harvestapi/linkedin-profile-scraper":
      return {
        queries: [url],
        profileScraperMode: "Profile details no email ($4 per 1k)",
      };
    case "harvestapi/linkedin-company":
      return { companies: [url] };
    case "apimaestro/linkedin-profile-posts":
      return { username: slugFromProfileUrl(url), limit: options.limit ?? 10 };
    case "harvestapi/linkedin-company-employees":
      return { companies: [url], maxItems: options.limit ?? 25 };
    case "apimaestro/linkedin-company-employees-scraper-no-cookies":
      return { identifier: url, max_employees: options.limit ?? 25 };
    default:
      throw new PotterError({
        tool: `potter_linkedin_${category}`,
        provider: "apify",
        reason: `Unknown Apify actor override: ${actorId}`,
        retryable: false,
        recommended_action: `Either set POTTER_APIFY_LINKEDIN_${category.toUpperCase()}_ACTOR back to "${DEFAULT_ACTORS[category]}" or implement a normalizer in src/providers/apify-actors.ts for this actor.`,
      });
  }
};

export interface ActorCallOptions {
  limit?: number;
  timeoutSeconds?: number;
}

const normalizeLocation = (raw: unknown): CanonicalLocation | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as {
    linkedinText?: unknown;
    parsed?: {
      country?: unknown;
      countryFull?: unknown;
      state?: unknown;
      city?: unknown;
      text?: unknown;
    };
    country?: unknown;
    city?: unknown;
    full?: unknown;
  };
  const parsed = r.parsed ?? {};
  return {
    country: stringOrNull((parsed.countryFull ?? parsed.country) ?? r.country),
    region: stringOrNull(parsed.state),
    city: stringOrNull(parsed.city ?? r.city),
    raw: stringOrNull(r.linkedinText ?? parsed.text ?? r.full),
  };
};

const normalizeExperience = (raw: unknown): CanonicalExperience => {
  const r = (raw ?? {}) as {
    position?: unknown;
    companyName?: unknown;
    companyLinkedinUrl?: unknown;
    startDate?: unknown;
    endDate?: unknown;
    duration?: unknown;
    description?: unknown;
    location?: unknown;
  };
  return {
    title: stringOrNull(r.position),
    company: stringOrNull(r.companyName),
    company_url: stringOrNull(r.companyLinkedinUrl),
    start_date: formatMonthYear(r.startDate),
    end_date: formatMonthYear(r.endDate),
    duration_months: null,
    description: stringOrNull(r.description),
    location: stringOrNull(r.location),
  };
};

const normalizeEducation = (raw: unknown): CanonicalEducation => {
  const r = (raw ?? {}) as {
    schoolName?: unknown;
    degree?: unknown;
    fieldOfStudy?: unknown;
    startDate?: unknown;
    endDate?: unknown;
  };
  return {
    school: stringOrNull(r.schoolName),
    degree: stringOrNull(r.degree),
    field: stringOrNull(r.fieldOfStudy),
    start_date: formatMonthYear(r.startDate),
    end_date: formatMonthYear(r.endDate),
  };
};

const normalizeHarvestProfile = (raw: Record<string, unknown>, url: string): CanonicalProfile => {
  if (raw.error !== undefined) {
    return emptyProfile(url, "not_found");
  }
  const firstName = stringOrNull(raw.firstName);
  const lastName = stringOrNull(raw.lastName);
  const fullName =
    firstName && lastName
      ? `${firstName} ${lastName}`
      : firstName ?? lastName ?? null;
  const currentArr = Array.isArray(raw.currentPosition)
    ? (raw.currentPosition as unknown[])
    : null;
  const current = currentArr?.[0] as
    | { position?: unknown; companyName?: unknown; companyLinkedinUrl?: unknown }
    | undefined;
  const experience = Array.isArray(raw.experience)
    ? (raw.experience as unknown[]).map(normalizeExperience)
    : [];
  const education = Array.isArray(raw.education)
    ? (raw.education as unknown[]).map(normalizeEducation)
    : [];
  const topSkills = Array.isArray(raw.topSkills) ? (raw.topSkills as unknown[]) : [];
  const rawSkills = Array.isArray(raw.skills) ? (raw.skills as unknown[]) : [];
  const skills = [...topSkills, ...rawSkills]
    .map((s) =>
      typeof s === "string"
        ? s
        : typeof s === "object" && s !== null && typeof (s as { name?: unknown }).name === "string"
          ? (s as { name: string }).name
          : null,
    )
    .filter((s): s is string => s !== null);
  const picture = raw.profilePicture as { url?: unknown } | undefined;
  const emails = Array.isArray(raw.emails) ? (raw.emails as unknown[]) : [];
  const firstEmail = emails.find((e) => typeof e === "string") as string | undefined;
  const headlineStr = stringOrNull(raw.headline);
  const hasCore = fullName !== null && (experience.length > 0 || headlineStr !== null);
  const quality: DataQuality = hasCore ? "full" : fullName ? "sparse" : "not_found";

  return {
    url,
    data_quality: quality,
    full_name: fullName,
    first_name: firstName,
    last_name: lastName,
    headline: stringOrNull(raw.headline),
    about: stringOrNull(raw.about),
    current_title: stringOrNull(current?.position),
    current_company: stringOrNull(current?.companyName),
    current_company_url: stringOrNull(current?.companyLinkedinUrl),
    location: normalizeLocation(raw.location),
    experience,
    education,
    skills: [...new Set(skills)],
    languages: [],
    connections_count: numberOrNull(raw.connectionsCount),
    followers_count: numberOrNull(raw.followerCount),
    profile_image_url: stringOrNull(picture?.url),
    email: firstEmail ?? null,
  };
};

const emptyProfile = (url: string, quality: DataQuality): CanonicalProfile => ({
  url,
  data_quality: quality,
  full_name: null,
  first_name: null,
  last_name: null,
  headline: null,
  about: null,
  current_title: null,
  current_company: null,
  current_company_url: null,
  location: null,
  experience: [],
  education: [],
  skills: [],
  languages: [],
  connections_count: null,
  followers_count: null,
  profile_image_url: null,
  email: null,
});

const normalizeHarvestCompany = (raw: Record<string, unknown>, url: string): CanonicalCompany => {
  if (raw.error !== undefined) return emptyCompany(url, "not_found");
  const industries = Array.isArray(raw.industries) ? (raw.industries as unknown[]) : [];
  const firstIndustry = industries[0] as { name?: unknown; title?: unknown } | undefined;
  const range = raw.employeeCountRange as { start?: unknown; end?: unknown } | undefined;
  const locations = Array.isArray(raw.locations) ? (raw.locations as unknown[]) : [];
  const hq = (locations.find((l) => (l as { headquarter?: unknown })?.headquarter === true) ??
    locations[0]) as
    | { parsed?: unknown; country?: unknown; city?: unknown; description?: unknown }
    | undefined;
  const specialties = Array.isArray(raw.specialities) ? (raw.specialities as unknown[]) : [];
  const founded = raw.foundedOn as { year?: unknown } | undefined;
  const name = stringOrNull(raw.name);
  const description = stringOrNull(raw.description);
  const quality: DataQuality = name !== null && description !== null ? "full" : name ? "sparse" : "not_found";
  return {
    url,
    data_quality: quality,
    name,
    tagline: stringOrNull(raw.tagline),
    description,
    website: stringOrNull(raw.website),
    industry: stringOrNull(firstIndustry?.name ?? firstIndustry?.title),
    company_size: range
      ? {
          min: numberOrNull(range.start),
          max: numberOrNull(range.end),
          display:
            range.start && range.end
              ? `${range.start}-${range.end}`
              : null,
        }
      : null,
    headquarters: hq ? normalizeLocation(hq) : null,
    founded_year: numberOrNull(founded?.year),
    specialties: specialties.filter((s): s is string => typeof s === "string"),
    follower_count: numberOrNull(raw.followerCount),
    employee_count: numberOrNull(raw.employeeCount),
    logo_url: stringOrNull(raw.logo),
  };
};

const emptyCompany = (url: string, quality: DataQuality): CanonicalCompany => ({
  url,
  data_quality: quality,
  name: null,
  tagline: null,
  description: null,
  website: null,
  industry: null,
  company_size: null,
  headquarters: null,
  founded_year: null,
  specialties: [],
  follower_count: null,
  employee_count: null,
  logo_url: null,
});

const normalizeApimaestroPost = (raw: Record<string, unknown>): CanonicalPost => {
  const author = raw.author as
    | { first_name?: unknown; last_name?: unknown; profile_url?: unknown; username?: unknown }
    | undefined;
  const authorName =
    author && typeof author.first_name === "string" && typeof author.last_name === "string"
      ? `${author.first_name} ${author.last_name}`
      : null;
  const stats = (raw.stats ?? {}) as {
    total_reactions?: unknown;
    comments?: unknown;
    reposts?: unknown;
  };
  const postedAt = raw.posted_at as { timestamp?: unknown; date?: unknown } | undefined;
  const postedIso =
    typeof postedAt?.timestamp === "number"
      ? new Date(postedAt.timestamp).toISOString()
      : typeof postedAt?.date === "string"
        ? postedAt.date
        : null;
  const media = raw.media as { type?: unknown; url?: unknown } | undefined;
  const mediaArr: CanonicalPostMedia[] = [];
  if (media && typeof media.url === "string") {
    const t = typeof media.type === "string" ? media.type : "other";
    mediaArr.push({
      type:
        t === "image" || t === "video" || t === "article" || t === "document"
          ? t
          : "other",
      url: media.url,
    });
  }
  const url = typeof raw.url === "string" ? raw.url : "";
  const text = stringOrNull(raw.text);
  return {
    url,
    data_quality: text !== null && url !== "" ? "full" : "sparse",
    author_url:
      typeof author?.profile_url === "string"
        ? author.profile_url.split("?")[0] ?? null
        : null,
    author_name: authorName,
    text,
    posted_at: postedIso,
    reactions_count: numberOrNull(stats.total_reactions),
    comments_count: numberOrNull(stats.comments),
    reposts_count: numberOrNull(stats.reposts),
    media: mediaArr,
    is_repost: raw.post_type === "repost",
    reposted_from_url: null,
  };
};

const normalizeHarvestEmployee = (raw: Record<string, unknown>): CanonicalEmployee => {
  const firstName = stringOrNull(raw.firstName);
  const lastName = stringOrNull(raw.lastName);
  const fullName =
    firstName && lastName ? `${firstName} ${lastName}` : firstName ?? lastName ?? null;
  const current = (raw.currentPosition as unknown[] | undefined)?.[0] as
    | { position?: unknown }
    | undefined;
  const picture = raw.profilePicture as { url?: unknown } | undefined;
  const url = typeof raw.linkedinUrl === "string"
    ? raw.linkedinUrl
    : typeof raw.publicIdentifier === "string"
      ? `https://www.linkedin.com/in/${raw.publicIdentifier}/`
      : "";
  return {
    url,
    data_quality: fullName !== null ? "full" : "sparse",
    full_name: fullName,
    headline: stringOrNull(raw.headline),
    current_title: stringOrNull(current?.position),
    location: normalizeLocation(raw.location),
    profile_image_url: stringOrNull(picture?.url),
  };
};

const normalizeApimaestroEmployee = (raw: Record<string, unknown>): CanonicalEmployee => {
  const fullName = stringOrNull(raw.fullname);
  const headline = stringOrNull(raw.headline);
  const publicId = stringOrNull(raw.public_identifier);
  const profileUrl = stringOrNull(raw.profile_url);
  const url = publicId
    ? `https://www.linkedin.com/in/${publicId}/`
    : profileUrl ?? "";
  const loc = (raw.location && typeof raw.location === "object"
    ? (raw.location as Record<string, unknown>)
    : {}) as { country?: unknown; city?: unknown; full?: unknown };
  return {
    url,
    data_quality: fullName !== null ? "full" : "sparse",
    full_name: fullName,
    headline,
    current_title: headline,
    location: {
      country: stringOrNull(loc.country),
      region: null,
      city: stringOrNull(loc.city),
      raw: stringOrNull(loc.full),
    },
    profile_image_url: stringOrNull(raw.profile_picture_url),
  };
};

const isValidApimaestroEmployeeItem = (raw: Record<string, unknown>): boolean => {
  return typeof raw.fullname === "string" || typeof raw.public_identifier === "string";
};

const toResultError = <T>(tool: string, err: unknown): Result<T> => {
  if (err instanceof PotterError) return { ok: false, error: err };
  return {
    ok: false,
    error: new PotterError({
      tool,
      provider: "apify",
      reason: err instanceof Error ? err.message : String(err),
      retryable: false,
      recommended_action: "Check the input URL and POTTER_APIFY_* override env vars.",
    }),
  };
};

import type { z } from "zod";

const validateOrError = <T>(
  tool: string,
  schema: z.ZodType<T>,
  value: T,
): Result<T> => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: new PotterError({
      tool,
      provider: "apify",
      reason: `Normalizer output failed schema validation: ${parsed.error.message.slice(0, 300)}`,
      retryable: false,
      recommended_action:
        "Apify actor output shape changed. File an issue with the run id and fixture URL.",
    }),
  };
};

export async function getLinkedInProfile(
  url: string,
  options: ActorCallOptions = {},
): Promise<Result<CanonicalProfile>> {
  const tool = "potter_linkedin_profile";
  let canonical: string;
  let actorId: string;
  let input: Record<string, unknown>;
  try {
    canonical = canonicalizeLinkedInProfileUrl(url);
    actorId = resolveActor("profile");
    input = buildInputForActor(actorId, "profile", canonical, options);
  } catch (err) {
    return toResultError<CanonicalProfile>(tool, err);
  }
  const run = await getApify().runActor<Record<string, unknown>>({
    tool,
    actorId,
    input,
    ...(options.timeoutSeconds !== undefined ? { timeoutSeconds: options.timeoutSeconds } : {}),
    resultLimit: 1,
  });
  if (!run.ok) return run;
  const first = run.value.items[0];
  if (!first) return { ok: true, value: emptyProfile(canonical, "not_found") };
  if (actorId === "harvestapi/linkedin-profile-scraper") {
    return validateOrError(tool, CanonicalProfileSchema, normalizeHarvestProfile(first, canonical));
  }
  return unsupportedActorError<CanonicalProfile>(tool, actorId, "profile");
}

export async function getLinkedInCompany(
  url: string,
  options: ActorCallOptions = {},
): Promise<Result<CanonicalCompany>> {
  const tool = "potter_linkedin_company";
  let canonical: string;
  let actorId: string;
  let input: Record<string, unknown>;
  try {
    canonical = canonicalizeLinkedInCompanyUrl(url);
    actorId = resolveActor("company");
    input = buildInputForActor(actorId, "company", canonical, options);
  } catch (err) {
    return toResultError<CanonicalCompany>(tool, err);
  }
  const run = await getApify().runActor<Record<string, unknown>>({
    tool,
    actorId,
    input,
    ...(options.timeoutSeconds !== undefined ? { timeoutSeconds: options.timeoutSeconds } : {}),
    resultLimit: 1,
  });
  if (!run.ok) return run;
  const first = run.value.items[0];
  if (!first) return { ok: true, value: emptyCompany(canonical, "not_found") };
  if (actorId === "harvestapi/linkedin-company") {
    return validateOrError(tool, CanonicalCompanySchema, normalizeHarvestCompany(first, canonical));
  }
  return unsupportedActorError<CanonicalCompany>(tool, actorId, "company");
}

const isValidPostItem = (raw: Record<string, unknown>): boolean => {
  if (raw.error !== undefined) return false;
  if (typeof raw.message === "string" && typeof raw.url !== "string") return false;
  if (typeof raw.url !== "string" || raw.url === "") return false;
  return true;
};

export async function getLinkedInPosts(
  url: string,
  options: ActorCallOptions = {},
): Promise<Result<CanonicalPost[]>> {
  const tool = "potter_linkedin_posts";
  let canonical: string;
  let actorId: string;
  let input: Record<string, unknown>;
  try {
    canonical = canonicalizeLinkedInProfileUrl(url);
    actorId = resolveActor("posts");
    input = buildInputForActor(actorId, "posts", canonical, options);
  } catch (err) {
    return toResultError<CanonicalPost[]>(tool, err);
  }
  const run = await getApify().runActor<Record<string, unknown>>({
    tool,
    actorId,
    input,
    ...(options.timeoutSeconds !== undefined ? { timeoutSeconds: options.timeoutSeconds } : {}),
    resultLimit: options.limit ?? 10,
  });
  if (!run.ok) return run;
  if (actorId === "apimaestro/linkedin-profile-posts") {
    const valid = run.value.items.filter(isValidPostItem);
    const normalized = valid.map(normalizeApimaestroPost);
    for (const post of normalized) {
      const parsed = CanonicalPostSchema.safeParse(post);
      if (!parsed.success) {
        const err = validateOrError(tool, CanonicalPostSchema, post);
        if (!err.ok) return { ok: false, error: err.error };
      }
    }
    return { ok: true, value: normalized };
  }
  return unsupportedActorError<CanonicalPost[]>(tool, actorId, "posts");
}

const isValidEmployeeItem = (raw: Record<string, unknown>): boolean => {
  if (raw.error !== undefined) return false;
  return typeof raw.firstName === "string" || typeof raw.publicIdentifier === "string";
};

export async function getLinkedInEmployees(
  url: string,
  options: ActorCallOptions = {},
): Promise<Result<CanonicalEmployee[]>> {
  const tool = "potter_find_decision_maker";
  let canonical: string;
  let actorId: string;
  let input: Record<string, unknown>;
  try {
    canonical = canonicalizeLinkedInCompanyUrl(url);
    actorId = resolveActor("employees");
    input = buildInputForActor(actorId, "employees", canonical, options);
  } catch (err) {
    return toResultError<CanonicalEmployee[]>(tool, err);
  }
  const run = await getApify().runActor<Record<string, unknown>>({
    tool,
    actorId,
    input,
    ...(options.timeoutSeconds !== undefined ? { timeoutSeconds: options.timeoutSeconds } : {}),
    resultLimit: options.limit ?? 25,
  });
  if (!run.ok) return run;
  if (actorId === "harvestapi/linkedin-company-employees") {
    const valid = run.value.items.filter(isValidEmployeeItem);
    const normalized = valid.map(normalizeHarvestEmployee);
    for (const emp of normalized) {
      const parsed = CanonicalEmployeeSchema.safeParse(emp);
      if (!parsed.success) {
        const err = validateOrError(tool, CanonicalEmployeeSchema, emp);
        if (!err.ok) return { ok: false, error: err.error };
      }
    }
    return { ok: true, value: normalized };
  }
  if (actorId === "apimaestro/linkedin-company-employees-scraper-no-cookies") {
    const valid = run.value.items.filter(isValidApimaestroEmployeeItem);
    const normalized = valid.map(normalizeApimaestroEmployee);
    for (const emp of normalized) {
      const parsed = CanonicalEmployeeSchema.safeParse(emp);
      if (!parsed.success) {
        const err = validateOrError(tool, CanonicalEmployeeSchema, emp);
        if (!err.ok) return { ok: false, error: err.error };
      }
    }
    return { ok: true, value: normalized };
  }
  return unsupportedActorError<CanonicalEmployee[]>(tool, actorId, "employees");
}

const unsupportedActorError = <T>(
  tool: string,
  actorId: string,
  category: LinkedInActorCategory,
): Result<T> => ({
  ok: false,
  error: new PotterError({
    tool,
    provider: "apify",
    reason: `No normalizer registered for ${category} actor ${actorId}`,
    retryable: false,
    recommended_action: `Add a normalizer in src/providers/apify-actors.ts or revert the override env var to the default ${DEFAULT_ACTORS[category]}.`,
  }),
});
