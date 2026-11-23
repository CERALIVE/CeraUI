import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import {
	clearRecentLogLines,
	LOG_RING_CAPACITY,
	logger,
} from "../helpers/logger.ts";
import * as mocks from "../mocks/mock-service.ts";
import * as identity from "../modules/device-logs/boot-id.ts";
import { listBoots } from "../modules/device-logs/boots.ts";

const START = 1_700_000_000_000;
const LATER = START + 60_000;

beforeEach(() => {
	jest.useFakeTimers();
	jest.setSystemTime(START);
	spyOn(mocks, "shouldUseMocks").mockReturnValue(true);
	clearRecentLogLines();
});

afterEach(() => {
	spyOn(identity, "currentBootId").mockRestore();
	spyOn(mocks, "shouldUseMocks").mockRestore();
	clearRecentLogLines();
	jest.useRealTimers();
});

function writeLog(message: string): Promise<void> {
	return new Promise((resolve, reject) => {
		logger.write({ level: "debug", message }, (error) =>
			error ? reject(error) : resolve(),
		);
	});
}

test("firstTs stays fixed after the mock ring evicts its oldest entry", async () => {
	const bootId = "10".repeat(16);
	spyOn(identity, "currentBootId").mockReturnValue(bootId);
	await writeLog("before eviction");
	expect((await listBoots())[0]).toMatchObject({ bootId, firstTs: START });

	jest.setSystemTime(LATER);
	for (let index = 0; index < LOG_RING_CAPACITY; index++)
		await writeLog("retained entry");

	const [boot] = await listBoots();
	expect(boot?.lastTs).toBe(LATER);
	expect(boot?.firstTs).toBe(START);
});

test("a new mock boot ID captures its own first-listing time", async () => {
	const firstId = "20".repeat(16);
	const secondId = "30".repeat(16);
	const bootId = spyOn(identity, "currentBootId").mockReturnValue(firstId);
	await writeLog("before the simulated boot change");
	expect((await listBoots())[0]).toMatchObject({
		bootId: firstId,
		firstTs: START,
	});

	jest.setSystemTime(LATER);
	bootId.mockReturnValue(secondId);
	expect((await listBoots())[0]).toMatchObject({
		bootId: secondId,
		firstTs: LATER,
	});

	bootId.mockReturnValue(firstId);
	expect((await listBoots())[0]).toMatchObject({
		bootId: firstId,
		firstTs: START,
	});
});
