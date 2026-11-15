import { createHash } from "node:crypto";
import type { logQueryInputSchema } from "@ceraui/rpc/schemas";
import { z } from "zod";

const positionSchema = z.strictObject({
	c: z
		.string()
		.min(1)
		.max(1024)
		.regex(/^[A-Za-z0-9=;:_.-]+$/),
	h: z.string().regex(/^[0-9a-f]{16}$/),
	b: z
		.string()
		.regex(/^[0-9a-f]{32}$/)
		.nullable(),
	e: z.number().int().nonnegative(),
	d: z.enum(["older", "newer"]),
});
export type ParsedQuery = z.output<typeof logQueryInputSchema>;
type Binding = Omit<z.infer<typeof positionSchema>, "c">;

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

export function encodePosition(cursor: string, binding: Binding): string {
	return Buffer.from(JSON.stringify({ c: cursor, ...binding })).toString(
		"base64url",
	);
}

export function decodePosition(
	token: string,
	binding: Binding,
):
	| { readonly cursor: string }
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
	return { cursor: position.c };
}
