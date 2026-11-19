import { describe, expect, it } from "vitest";

import { streamPillState } from "./stream-pill";

describe("streamPillState", () => {
	it("is idle when nothing streams and the connection is fresh", () => {
		expect(streamPillState(false, false)).toBe("idle");
	});

	it("is live while streaming on a fresh connection", () => {
		expect(streamPillState(true, false)).toBe("live");
	});

	it("is offline when the connection is stale, even while streaming", () => {
		expect(streamPillState(true, true)).toBe("offline");
		expect(streamPillState(false, true)).toBe("offline");
	});
});
