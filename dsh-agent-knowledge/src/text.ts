// Use the same deterministic tokenizer for indexing and retrieval. No model calls.
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
export function tokens(value: string, max = 8192): string[] {
  const result = new Set<string>();
  for (const part of segmenter.segment(value.normalize("NFKC").toLowerCase())) {
    if (!part.isWordLike) continue;
    for (const word of part.segment.matchAll(/[\p{L}\p{N}]+/gu)) {
      const term = word[0];
      if (term.length > 80) continue;
      result.add(term);
      if (result.size >= max) return [...result];
    }
  }
  return [...result];
}
export const normalizedName = (value: string) => value.normalize("NFKC").toLowerCase().trim();
export const indexText = (value: string) => tokens(value).join(" ");
export const searchQuery = (value: string) => tokens(value, 64).map(term => `"${term}"`).join(" OR ");
