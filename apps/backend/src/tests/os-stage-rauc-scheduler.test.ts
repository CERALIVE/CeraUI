import { expect, spyOn, test } from "bun:test";
import { killAndRestartRaucForStream } from "../modules/system/update-orchestrator/stream-abort.ts";
import { okCommand } from "./helpers/rauc-escalation-fixture.ts";

test("the production scheduler preserves the delay and unreferences its real timer", async () => {
	// Given the real timer adapter, with timer creation observed but not replaced.
	const create = spyOn(globalThis, "setTimeout");
	try {
		// When successful TERM arms the production escalation.
		await killAndRestartRaucForStream(async () => okCommand);
		// Then the first look is delayed and cannot keep the process alive.
		expect(create.mock.calls.map(([, delay]) => delay)).toEqual([1000]);
		expect(create.mock.results).toHaveLength(1);
		for (const result of create.mock.results) {
			switch (result.type) {
				case "return":
					expect(result.value.hasRef()).toBe(false);
					break;
				case "throw":
					throw result.value;
				case "incomplete":
					throw new TypeError("timer creation did not complete");
				default: {
					const exhaustive: never = result;
					throw exhaustive;
				}
			}
		}
	} finally {
		create.mockRestore();
		await killAndRestartRaucForStream(async () => okCommand, {
			now: () => 0,
			schedule: () => () => undefined,
		});
	}
});
