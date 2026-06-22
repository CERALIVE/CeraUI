import { afterAll, describe, test } from "bun:test";
import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { handleMmcliCommand } from "../mocks/providers/modems.ts";

const ORIGINAL_MOCK_MODE = process.env.MOCK_MODE;

// This evidence-capture test enables global mock mode (MOCK_MODE + an
// initialised mock service). Without teardown it leaks shouldUseMocks()===true
// into every later file in the same `bun test` process — harmless until a
// consumer gates on shouldUseMocks() (e.g. the kiosk RPC handlers, T6). Restore.
afterAll(() => {
	stopMockService();
	if (ORIGINAL_MOCK_MODE === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = ORIGINAL_MOCK_MODE;
});

describe("Mock Modems Output — Task 8 Evidence", () => {
	test("capture modem info for all 3 modems in multi-modem-wifi scenario", () => {
		process.env.MOCK_MODE = "true";
		initMockService("multi-modem-wifi");

		const output: Record<string, string | null> = {};

		// Capture modem list
		const listOutput = handleMmcliCommand(["-K", "-L"]);
		output["modem-list"] = listOutput;

		// Capture each modem's info
		for (let i = 0; i < 3; i++) {
			const modemOutput = handleMmcliCommand(["-K", "-m", String(i)]);
			output[`modem-${i}`] = modemOutput;
		}

		// Write to evidence file
		const evidencePath = "test-results/task-8-mock-modems.json";
		Bun.write(evidencePath, JSON.stringify(output, null, 2));

		// intentional: test output for evidence capture
		console.log(`✅ Evidence written to ${evidencePath}`);
		console.log("\n=== MODEM LIST ===");
		console.log(output["modem-list"]);
		console.log("\n=== MODEM 0 (RM520N-GL) ===");
		console.log(output["modem-0"]);
		console.log("\n=== MODEM 1 (EM7455) ===");
		console.log(output["modem-1"]);
		console.log("\n=== MODEM 2 (RM500Q-GL) ===");
		console.log(output["modem-2"]);
	});
});
