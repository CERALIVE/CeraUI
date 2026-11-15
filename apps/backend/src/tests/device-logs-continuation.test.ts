import { expect, spyOn, test } from "bun:test";
import { logQueryInputSchema } from "@ceraui/rpc/schemas";
import {
	bindQuery,
	decodePosition,
	encodePosition,
} from "../modules/device-logs/continuation.ts";

const boot = "a".repeat(32);
const binding = bindQuery(logQueryInputSchema.parse({}), boot, 4);
test("continuations pin the documented JSON binding and canonical filter hash", () => {
	expect(binding).toEqual({ h: "96b47f2062bc4899", b: boot, e: 4, d: "older" });
	const token = encodePosition("s=one;i=2", binding);
	expect(JSON.parse(Buffer.from(token, "base64url").toString())).toEqual({
		c: "s=one;i=2",
		...binding,
	});
	expect(decodePosition(token, binding)).toEqual({ cursor: "s=one;i=2" });
});
test("reordering or repeating selections and changing page size preserves the binding", () => {
	const a = logQueryInputSchema.parse({
		sources: ["network", "app"],
		levels: ["warning", "error"],
		text: "USB",
		since: 1,
		until: 2,
	});
	const b = logQueryInputSchema.parse({
		...a,
		sources: ["app", "network", "app"],
		levels: ["error", "warning", "warning"],
		limit: 2,
	});
	expect(bindQuery(a, boot, 4)).toEqual(bindQuery(b, boot, 4));
});
test.each([
	"nonsense",
	Buffer.from("{}").toString("base64url"),
	...[
		{ c: "a b" },
		{ c: "" },
		{ c: "x".repeat(1025) },
		{ h: "wrong" },
		{ b: "bad" },
		{ e: -1 },
		{ e: 0.5 },
		{ d: "sideways" },
		{ extra: true },
	].map((patch) =>
		Buffer.from(JSON.stringify({ c: "s=1", ...binding, ...patch })).toString(
			"base64url",
		),
	),
])("invalid decoded token %s is expired", (token) => {
	expect(decodePosition(token, binding)).toEqual({
		error: "CURSOR_UNAVAILABLE",
	});
});
test.each([{ h: "b".repeat(16) }, { b: null }, { d: "newer" as const }])(
	"a changed binding %j refuses filter reuse",
	(patch) => {
		const token = encodePosition("s=1", { ...binding, ...patch });
		expect(decodePosition(token, binding)).toEqual({ error: "FILTER_CHANGED" });
	},
);
test("epoch changes expire a position even if its anchor remains", () => {
	expect(
		decodePosition(encodePosition("s=1", { ...binding, e: 5 }), binding),
	).toEqual({ error: "CURSOR_UNAVAILABLE" });
});
test.each(["x", "x".repeat(1024)])(
	"cursor boundary length %i remains usable",
	(cursor) => {
		expect(decodePosition(encodePosition(cursor, binding), binding)).toEqual({
			cursor,
		});
	},
);
test("unexpected decoding faults propagate instead of becoming cursor loss", () => {
	const parse = spyOn(JSON, "parse").mockImplementationOnce(() => {
		throw new TypeError("decoder fault");
	});
	try {
		expect(() => decodePosition("e30", binding)).toThrow("decoder fault");
	} finally {
		parse.mockRestore();
	}
});
test("both changes of traversal direction invalidate a position", () => {
	const newer = { ...binding, d: "newer" as const };
	expect(decodePosition(encodePosition("s=1", binding), newer)).toEqual({
		error: "FILTER_CHANGED",
	});
	expect(decodePosition(encodePosition("s=1", newer), binding)).toEqual({
		error: "FILTER_CHANGED",
	});
});
