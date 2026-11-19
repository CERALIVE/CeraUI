import { createHash } from "node:crypto";
import type { logQueryInputSchema } from "@ceraui/rpc/schemas";
import { z } from "zod";

const cursorSchema = z
	.string()
	.min(1)
	.max(1024)
	.regex(/^[A-Za-z0-9=;:_.-]+$/);
const positionSchema = z.strictObject({
	c: cursorSchema,
	h: z.string().regex(/^[0-9a-f]{16}$/),
	b: z
		.string()
		.regex(/^[0-9a-f]{32}$/)
		.nullable(),
	e: z.number().int().nonnegative(),
	d: z.enum(["older", "newer"]),
	g: z
		.strictObject({
			through: cursorSchema,
			start: z.literal(true).optional(),
		})
		.optional(),
});
export type ParsedQuery = z.output<typeof logQueryInputSchema>;
type Position = z.infer<typeof positionSchema>;
type Binding = Omit<Position, "c" | "g">;

export function bindQuery(
	query: ParsedQuery,
	bootId: string | null,
	epoch: number,
): Binding {
	const normalized = {
		sources: [...new Set(query.sources)].sort(),
		levels: [...new Set(query.levels)].sort(),
		text: query.text,
		since: query.since,
		until: query.until,
	};
	return {
		h: createHash("sha256")
			.update(JSON.stringify(normalized))
			.digest("hex")
			.slice(0, 16),
		b: bootId,
		e: epoch,
		d: query.direction,
	};
}

export function encodePosition(
	cursor: string,
	binding: Binding,
	gap?: Position["g"],
): string {
	return Buffer.from(
		JSON.stringify({ c: cursor, ...binding, g: gap }),
	).toString("base64url");
}

export function decodePosition(
	token: string,
	binding: Binding,
):
	| { readonly cursor: string; readonly gap?: Position["g"] }
	| { readonly error: "CURSOR_UNAVAILABLE" | "FILTER_CHANGED" } {
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		return { error: "CURSOR_UNAVAILABLE" };
	}
	const parsed = positionSchema.safeParse(value);
	if (!parsed.success) return { error: "CURSOR_UNAVAILABLE" };
	const position = parsed.data;
	if (
		position.h !== binding.h ||
		position.b !== binding.b ||
		position.d !== binding.d
	)
		return { error: "FILTER_CHANGED" };
	if (position.e !== binding.e) return { error: "CURSOR_UNAVAILABLE" };
	if (position.g !== undefined && (binding.d !== "newer" || binding.b === null))
		return { error: "CURSOR_UNAVAILABLE" };
	return position.g === undefined
		? { cursor: position.c }
		: { cursor: position.c, gap: position.g };
}
