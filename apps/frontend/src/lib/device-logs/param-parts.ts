/**
 * The text before and after a message's one data param, so the param can render
 * in its own <bdi>: direction belongs to the markup, never to the copy, and an
 * isolated "2026.11.3-beta" cannot reorder inside right-to-left text.
 */
const MARK = "\u0000";

/** One piece of a message: its copy, or a data param that renders in a <bdi>. */
export interface ParamPiece {
	readonly text: string;
	readonly param: boolean;
}

export function paramParts(
	format: (value: string) => string,
): readonly [string, string] {
	const text = format(MARK);
	const at = text.indexOf(MARK);
	return [text.slice(0, at), text.slice(at + MARK.length)];
}

/** Marks a data param so paramPieces finds it wherever the translation puts it. */
export function markParam(value: string): string {
	return `${MARK}${value.replaceAll(MARK, "\uFFFD")}${MARK}`;
}

/** A message with params marked by markParam, as copy and params in the translation's order. */
export function paramPieces(text: string): ParamPiece[] {
	return text
		.split(MARK)
		.flatMap((piece, index): ParamPiece[] =>
			index % 2 === 1
				? [{ text: piece, param: true }]
				: piece === ""
					? []
					: [{ text: piece, param: false }],
		);
}
