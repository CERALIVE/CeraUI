/**
 * The `pipelines` broadcast has two shapes on the wire: the current
 * `{hardware, pipelines}` message, and a bare pipeline record from a backend
 * predating the wrapper. The legacy branch used to rebuild the wrapper and
 * assert the result was a `PipelinesMessage`, so an entry of any shape at all
 * reached consumers typed as a `Pipeline`. This pins the parsed replacement:
 * identical output for a well-formed payload, and a dropped entry — never a
 * throw, never a lie — for a malformed one.
 */
import { describe, expect, it } from "vitest";

import { parseLegacyPipelines } from "$lib/rpc/subscriptions.svelte";

const HDMI = {
	name: "HDMI",
	description: "HDMI capture",
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
};

describe("parseLegacyPipelines", () => {
	it("keeps a well-formed legacy record byte-for-byte", () => {
		expect(parseLegacyPipelines({ hdmi: HDMI })).toEqual({
			hardware: "generic",
			pipelines: { hdmi: HDMI },
		});
	});

	it("honours a hardware field the legacy payload carries", () => {
		expect(
			parseLegacyPipelines({ hardware: "rk3588", hdmi: HDMI }).hardware,
		).toBe("rk3588");
	});

	it("falls back to generic for an unknown hardware value", () => {
		expect(
			parseLegacyPipelines({ hardware: "commodore-64", hdmi: HDMI }).hardware,
		).toBe("generic");
	});

	it("drops a malformed entry instead of typing it as a pipeline", () => {
		const parsed = parseLegacyPipelines({
			hdmi: HDMI,
			broken: { name: "no description or capability flags" },
		});

		expect(Object.keys(parsed.pipelines)).toEqual(["hdmi"]);
	});

	it("never throws on a payload that is not an object", () => {
		expect(parseLegacyPipelines(null)).toEqual({
			hardware: "generic",
			pipelines: {},
		});
		expect(parseLegacyPipelines("pipelines")).toEqual({
			hardware: "generic",
			pipelines: {},
		});
	});
});
