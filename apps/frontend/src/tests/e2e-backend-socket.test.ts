import { afterEach, describe, expect, it, vi } from "vitest";

import { isBackendSocket } from "../../tests/e2e/helpers/backend-socket";

afterEach(() => vi.unstubAllEnvs());

describe("E2E backend socket routing", () => {
	it.each([3002, 3100, 3149, 3199, 6173, 8090, 8091])(
		"matches the existing backend or default preview port %i",
		(port) => {
			vi.stubEnv("E2E_PORT", undefined);
			expect(isBackendSocket(new URL(`ws://localhost:${port}/ws`))).toBe(true);
		},
	);

	it.each([
		[6273, true],
		[6173, false],
		[6274, false],
		[16273, false],
		[3099, false],
		[3200, false],
		[3100, true],
		[3199, true],
	])("routes port %i according to the selected E2E_PORT", (port, matches) => {
		vi.stubEnv("E2E_PORT", "6273");
		expect(
			isBackendSocket(new URL(`ws://localhost:${port}/ws?session=e2e`)),
		).toBe(matches);
	});

	it("also routes the preview media leg on E2E_PORT", () => {
		vi.stubEnv("E2E_PORT", "6273");
		expect(isBackendSocket(new URL("ws://localhost:6273/preview"))).toBe(true);
	});
});
