/**
 * Fixed Chinese copy breaks between words, never before a one-character ending
 * or punctuation. Other locales and browsers without a segmenter keep the text.
 */
export function chineseWordChunks(text: string, locale: string): string[] {
	if (!locale.startsWith("zh")) return [text];
	// shortcut: ICU owns compound-word boundaries; upgrade when Chromium supports auto-phrase for Chinese.
	try {
		const chunks = [""];
		let wordBefore = false;
		for (const { segment, isWordLike = false } of new Intl.Segmenter(locale, {
			granularity: "word",
		}).segment(text)) {
			if (isWordLike && wordBefore && segment.length > 1) chunks.push("");
			chunks[chunks.length - 1] += segment;
			wordBefore = isWordLike;
		}
		return chunks.join("") === text ? chunks : [text];
	} catch {
		// The browser's own line breaking is the fallback when ICU is unavailable.
		return [text];
	}
}
