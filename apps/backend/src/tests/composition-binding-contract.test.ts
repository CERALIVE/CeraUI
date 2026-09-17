import { expect, test } from "bun:test";
import {
	type ChangeConfigParams,
	changeConfigParamsSchema,
} from "@ceralive/cerastream";

test("the installed producer preserves an explicitly typed composition clear", () => {
	// Given the producer-owned type, not a consumer shadow or widened cast.
	const request: ChangeConfigParams = { composition: null };
	// When the installed registry schema parses the request.
	const parsed = changeConfigParamsSchema.parse(request);
	// Then the clear remains distinct from an omitted field.
	expect(parsed).toEqual({ composition: null });
});

test("the installed producer preserves omission on an unrelated change", () => {
	const request: ChangeConfigParams = { resolution: "1920x1080" };
	const parsed = changeConfigParamsSchema.parse(request);
	expect(parsed).toEqual({ resolution: "1920x1080" });
});

test("the installed producer preserves object-valued composition updates", () => {
	const request: ChangeConfigParams = {
		composition: { secondary_input_id: "camera-b", layout: "pip-top-right" },
	};
	const parsed = changeConfigParamsSchema.parse(request);
	expect(parsed).toEqual(request);
});
