import { z } from "zod";

export const DataQualitySchema = z.enum(["full", "sparse", "not_found", "protected"]);
export type DataQuality = z.infer<typeof DataQualitySchema>;

export const CanonicalExperienceSchema = z.object({
  title: z.string().nullable(),
  company: z.string().nullable(),
  company_url: z.string().nullable(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  duration_months: z.number().int().nullable(),
  description: z.string().nullable(),
  location: z.string().nullable(),
});
export type CanonicalExperience = z.infer<typeof CanonicalExperienceSchema>;

export const CanonicalEducationSchema = z.object({
  school: z.string().nullable(),
  degree: z.string().nullable(),
  field: z.string().nullable(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
});
export type CanonicalEducation = z.infer<typeof CanonicalEducationSchema>;

export const CanonicalLocationSchema = z.object({
  country: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  raw: z.string().nullable(),
});
export type CanonicalLocation = z.infer<typeof CanonicalLocationSchema>;

export const CanonicalProfileSchema = z.object({
  url: z.string(),
  data_quality: DataQualitySchema,
  full_name: z.string().nullable(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  headline: z.string().nullable(),
  about: z.string().nullable(),
  current_title: z.string().nullable(),
  current_company: z.string().nullable(),
  current_company_url: z.string().nullable(),
  location: CanonicalLocationSchema.nullable(),
  experience: z.array(CanonicalExperienceSchema),
  education: z.array(CanonicalEducationSchema),
  skills: z.array(z.string()),
  languages: z.array(z.string()),
  connections_count: z.number().int().nullable(),
  followers_count: z.number().int().nullable(),
  profile_image_url: z.string().nullable(),
  email: z.string().nullable(),
});
export type CanonicalProfile = z.infer<typeof CanonicalProfileSchema>;

export const CanonicalCompanySizeSchema = z.object({
  min: z.number().int().nullable(),
  max: z.number().int().nullable(),
  display: z.string().nullable(),
});
export type CanonicalCompanySize = z.infer<typeof CanonicalCompanySizeSchema>;

export const CanonicalCompanySchema = z.object({
  url: z.string(),
  data_quality: DataQualitySchema,
  name: z.string().nullable(),
  tagline: z.string().nullable(),
  description: z.string().nullable(),
  website: z.string().nullable(),
  industry: z.string().nullable(),
  company_size: CanonicalCompanySizeSchema.nullable(),
  headquarters: CanonicalLocationSchema.nullable(),
  founded_year: z.number().int().nullable(),
  specialties: z.array(z.string()),
  follower_count: z.number().int().nullable(),
  employee_count: z.number().int().nullable(),
  logo_url: z.string().nullable(),
});
export type CanonicalCompany = z.infer<typeof CanonicalCompanySchema>;

export const CanonicalPostMediaSchema = z.object({
  type: z.enum(["image", "video", "article", "document", "other"]),
  url: z.string(),
});
export type CanonicalPostMedia = z.infer<typeof CanonicalPostMediaSchema>;

export const CanonicalPostSchema = z.object({
  url: z.string(),
  data_quality: DataQualitySchema,
  author_url: z.string().nullable(),
  author_name: z.string().nullable(),
  text: z.string().nullable(),
  posted_at: z.string().nullable(),
  reactions_count: z.number().int().nullable(),
  comments_count: z.number().int().nullable(),
  reposts_count: z.number().int().nullable(),
  media: z.array(CanonicalPostMediaSchema),
  is_repost: z.boolean(),
  reposted_from_url: z.string().nullable(),
});
export type CanonicalPost = z.infer<typeof CanonicalPostSchema>;

export const CanonicalEmployeeSchema = z.object({
  url: z.string(),
  data_quality: DataQualitySchema,
  full_name: z.string().nullable(),
  headline: z.string().nullable(),
  current_title: z.string().nullable(),
  location: CanonicalLocationSchema.nullable(),
  profile_image_url: z.string().nullable(),
});
export type CanonicalEmployee = z.infer<typeof CanonicalEmployeeSchema>;

export const ProviderStatusEntrySchema = z.object({
  provider: z.string(),
  ok: z.boolean(),
  status_code: z.number().int().nullable().optional(),
  error: z.string().nullable().optional(),
});
export type ProviderStatusEntry = z.infer<typeof ProviderStatusEntrySchema>;

export const ProviderResponseEnvelopeSchema = z.object({
  source_urls: z.array(z.string()),
  provider_status: z.array(ProviderStatusEntrySchema),
  warnings: z.array(z.string()),
});
export type ProviderResponseEnvelope = z.infer<typeof ProviderResponseEnvelopeSchema>;

export const DataQualityBlockSchema = z.object({
  confidence: z.enum(["high", "medium", "low"]),
  missing_fields: z.array(z.string()),
  limitations: z.array(z.string()),
});
export type DataQualityBlock = z.infer<typeof DataQualityBlockSchema>;

export const CompositeResponseEnvelopeSchema = ProviderResponseEnvelopeSchema.extend({
  data_quality: DataQualityBlockSchema,
});
export type CompositeResponseEnvelope = z.infer<typeof CompositeResponseEnvelopeSchema>;

export const PartialFailurePointSchema = z.enum([
  "apify_profile",
  "apify_company",
  "apify_posts",
  "apify_employees",
  "firecrawl_search",
  "firecrawl_scrape",
  "firecrawl_extract",
  "firecrawl_crawl",
  "schema_validation",
  "stagehand",
  "url_normalization",
  "truncation",
]);
export type PartialFailurePoint = z.infer<typeof PartialFailurePointSchema>;

export const PartialFailureEnvelopeSchema = ProviderResponseEnvelopeSchema.extend({
  partial_data: z.record(z.string(), z.unknown()),
  failure_point: PartialFailurePointSchema,
});
export type PartialFailureEnvelope = z.infer<typeof PartialFailureEnvelopeSchema>;
