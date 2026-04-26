// Tokenizer is intentionally ASCII-only: non-ASCII characters are stripped before tokenization,
// so themes for posts written primarily in non-Latin scripts (Japanese, Cyrillic, Arabic, etc.)
// will be empty or low-signal. v1 ships English-first; multilingual tokenization is a v1.x item.

const STOPWORDS = new Set<string>([
  "the", "a", "an", "is", "are", "was", "were", "been", "be", "being", "am",
  "and", "or", "but", "nor", "so", "yet", "for", "at", "by", "in", "on", "to", "of",
  "from", "with", "as", "it", "its", "that", "this", "these", "those", "there",
  "here", "i", "you", "he", "she", "we", "they", "them", "their", "my", "our",
  "your", "his", "her", "if", "then", "than", "when", "where", "why", "how",
  "what", "who", "whom", "which", "do", "does", "did", "doing", "done",
  "have", "has", "had", "having", "will", "would", "could", "should", "may", "might",
  "must", "shall", "can", "need", "want", "like", "just", "about", "into", "over",
  "under", "above", "below", "between", "through", "after", "before", "during",
  "while", "because", "since", "until", "upon", "via", "per", "not", "no", "very",
  "more", "most", "much", "many", "any", "all", "some", "each", "every", "few",
  "other", "another", "same", "such", "own", "only", "also", "too", "now", "still",
  "ever", "never", "always", "often", "sometimes", "usually", "really", "quite",
  "s", "t", "re", "ve", "ll", "m", "d",
]);

const tokenizeRaw = (text: string): string[] => {
  const normalized = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized === "") return [];
  return normalized.split(" ").filter((t) => t.length >= 2 && !/^\d+$/.test(t));
};

const filterTokensForUnigrams = (tokens: string[]): string[] =>
  tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t));

const buildBigrams = (rawTokens: string[]): string[] => {
  const bigrams: string[] = [];
  for (let i = 0; i < rawTokens.length - 1; i += 1) {
    const a = rawTokens[i]!;
    const b = rawTokens[i + 1]!;
    if (STOPWORDS.has(a) || STOPWORDS.has(b)) continue;
    if (a.length < 3 || b.length < 3) continue;
    bigrams.push(`${a} ${b}`);
  }
  return bigrams;
};

export interface ExtractedTheme {
  term: string;
  score: number;
  mentions: number;
  example_post_urls: string[];
}

export interface ThemeExtractionInput {
  posts: Array<{ text: string | null; url: string }>;
  top_n?: number;
  include_bigrams?: boolean;
}

export const extractThemes = (input: ThemeExtractionInput): ExtractedTheme[] => {
  const topN = input.top_n ?? 5;
  const includeBigrams = input.include_bigrams ?? true;
  const validPosts = input.posts.filter((p) => p.text !== null);
  if (validPosts.length === 0) return [];

  const docRawTokens = validPosts.map((p) => tokenizeRaw(p.text ?? ""));
  const docUnigrams = docRawTokens.map(filterTokensForUnigrams);
  const termFreqPerDoc = docRawTokens.map((rawTokens, i) => {
    const tf = new Map<string, number>();
    for (const t of docUnigrams[i]!) tf.set(t, (tf.get(t) ?? 0) + 1);
    if (includeBigrams) {
      for (const bg of buildBigrams(rawTokens)) tf.set(bg, (tf.get(bg) ?? 0) + 1);
    }
    return tf;
  });

  const documentFreq = new Map<string, number>();
  for (const tf of termFreqPerDoc) {
    for (const term of tf.keys()) {
      documentFreq.set(term, (documentFreq.get(term) ?? 0) + 1);
    }
  }

  const N = validPosts.length;
  const scores = new Map<string, { score: number; mentions: number; docs: Set<number> }>();
  for (let i = 0; i < termFreqPerDoc.length; i += 1) {
    const tf = termFreqPerDoc[i]!;
    for (const [term, count] of tf) {
      const df = documentFreq.get(term) ?? 1;
      const idf = Math.log((N + 1) / (df + 1)) + 1;
      const weight = count * idf;
      const acc = scores.get(term) ?? { score: 0, mentions: 0, docs: new Set<number>() };
      acc.score += weight;
      acc.mentions += count;
      acc.docs.add(i);
      scores.set(term, acc);
    }
  }

  const ranked: ExtractedTheme[] = [];
  for (const [term, { score, mentions, docs }] of scores) {
    if (mentions < 2 && term.includes(" ") === false) continue;
    const example_post_urls = [...docs].slice(0, 3).map((idx) => validPosts[idx]!.url);
    ranked.push({ term, score, mentions, example_post_urls });
  }
  ranked.sort((a, b) => b.score - a.score);

  const termTokens = (t: string): Set<string> => new Set(t.split(" "));
  const deduped: ExtractedTheme[] = [];
  for (const theme of ranked) {
    const themeToks = termTokens(theme.term);
    const redundant = deduped.some((d) => {
      const dToks = termTokens(d.term);
      if (dToks.size === themeToks.size) return false;
      let common = 0;
      const smaller = dToks.size < themeToks.size ? dToks : themeToks;
      const larger = smaller === dToks ? themeToks : dToks;
      for (const t of smaller) if (larger.has(t)) common += 1;
      return common === smaller.size;
    });
    if (redundant) continue;
    deduped.push(theme);
    if (deduped.length >= topN) break;
  }
  return deduped;
};

export interface NotableQuote {
  post_url: string;
  text: string;
  engagement_score: number;
  kind: "engagement_ranked" | "length_sample";
}

export const extractNotableQuotes = (
  posts: Array<{
    text: string | null;
    url: string;
    reactions_count: number | null;
    comments_count: number | null;
  }>,
  top_n = 3,
): NotableQuote[] => {
  const candidates = posts
    .filter((p) => p.text !== null && (p.text?.length ?? 0) >= 40)
    .map((p) => ({
      post_url: p.url,
      text: (p.text ?? "").slice(0, 280),
      engagement_score: (p.reactions_count ?? 0) + 3 * (p.comments_count ?? 0),
    }));
  if (candidates.length === 0) return [];
  const anyEngagement = candidates.some((c) => c.engagement_score > 0);
  const kind: NotableQuote["kind"] = anyEngagement ? "engagement_ranked" : "length_sample";
  const ranked = anyEngagement
    ? candidates.sort((a, b) => b.engagement_score - a.engagement_score)
    : candidates.sort((a, b) => b.text.length - a.text.length);
  return ranked.slice(0, top_n).map((c) => ({ ...c, kind }));
};
