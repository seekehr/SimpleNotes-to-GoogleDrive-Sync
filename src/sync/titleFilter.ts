/**
 * Builds a predicate for `sync.title_keywords`: a title matches when it contains
 * any keyword, ignoring case. No keywords means every title matches.
 */
export function titleMatcher(keywords: readonly string[]): (title: string) => boolean {
  const needles = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  if (needles.length === 0) return () => true;
  return (title) => {
    const haystack = title.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  };
}
