/**
 * The text before and after a message's one data param, so the param can render
 * in its own <bdi>: direction belongs to the markup, never to the copy, and an
 * isolated "2026.11.3-beta" cannot reorder inside right-to-left text.
 */
const MARK = "\u0000";

export function paramParts(
	format: (value: string) => string,
): readonly [string, string] {
	const text = format(MARK);
	const at = text.indexOf(MARK);
	return [text.slice(0, at), text.slice(at + MARK.length)];
}
