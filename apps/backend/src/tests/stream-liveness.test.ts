import { afterEach, expect, test } from "bun:test";
import {
	bindStreamLiveness,
	streamLiveness,
} from "../modules/streaming/stream-liveness.ts";

afterEach(() => bindStreamLiveness(() => "unknown"));

test("the leaf accessor stays unknown before composition-root initialization", () => {
	// Given only the leaf module, with no orchestrator import.
	// When a disruptive consumer asks for liveness during boot.
	const observed = streamLiveness();
	// Then an uninitialized provider cannot grant idle.
	expect(observed).toBe("unknown");
});

test("the leaf accessor follows current evidence rather than caching its first reading", () => {
	// Given an independently changing engine-evidence provider.
	let evidence: "streaming" | "idle" | "unknown" = "unknown";
	bindStreamLiveness(() => evidence);
	// When the provider receives new positive evidence and then loses authority.
	for (const delivered of ["idle", "streaming", "unknown"] as const) {
		evidence = delivered;
		// Then each consumer call reads the provider's current value.
		expect(streamLiveness()).toBe(delivered);
	}
});
