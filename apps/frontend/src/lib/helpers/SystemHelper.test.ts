// @vitest-environment jsdom
/**
 * SystemHelper.startStreaming — forwards relay_streamid_override + relay_protocol.
 *
 * A managed stream with a stream-id override only resolves when start() receives
 * the override (backend resolve-endpoint.ts honors it). This locks that the
 * ConfigMessage → StreamingConfigInput mapping carries both fields (Task 19).
 */
import type { ConfigMessage } from "@ceraui/rpc/schemas";
import { describe, expect, it, vi } from "vitest";

const start = vi.hoisted(() => vi.fn(async () => ({ success: true })));
vi.mock("$lib/rpc/client", () => ({
	rpc: { streaming: { start } },
}));

import { startStreaming } from "./SystemHelper";

describe("startStreaming — relay field forwarding (Task 19)", () => {
	it("carries relay_streamid_override and relay_protocol into the start input", async () => {
		start.mockClear();
		const config = {
			pipeline: "p",
			relay_server: "srv-eu",
			relay_streamid_override: "publish/abc",
			relay_protocol: "srtla",
		} as unknown as ConfigMessage;

		await startStreaming(config);

		expect(start).toHaveBeenCalledTimes(1);
		const input = start.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(input.relay_streamid_override).toBe("publish/abc");
		expect(input.relay_protocol).toBe("srtla");
		expect(input.relay_server).toBe("srv-eu");
	});
});
