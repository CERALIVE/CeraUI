import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { once } from "node:events";
import {
	clearRecentLogLines,
	getRecentLogLines,
	logger,
} from "../helpers/logger.ts";
import {
	currentBootId,
	normalizeBootId,
} from "../modules/device-logs/boot-id.ts";
import {
	defaultVersionContextDeps,
	logBootRecord,
} from "../modules/system/version-context.ts";
import {
	BOOT_ID,
	deps,
	FULL_CONTEXT,
} from "./helpers/version-context-fixtures.ts";

const restores: Array<() => void> = [];

afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

describe("journal boot identity", () => {
	test.each([
		["66d8d180-8694-489b-8c3a-3fb4795cab24", BOOT_ID],
		["66D8D1808694489B8C3A3FB4795CAB24", BOOT_ID],
		["not-a-boot-id", undefined],
		["66d8d1808694489b8c3a3fb4795cab2", undefined],
		["66d8d1808694489b8c3a3fb4795cab240", undefined],
		["66d8d1808694489b8c3a3fb4795cab2g", undefined],
	])("normalizes only 32 hex characters: %s", (raw, expected) => {
		expect(normalizeBootId(raw)).toBe(expected);
	});

	test("currentBootId normalizes the kernel reader's hyphenated id", () => {
		expect(currentBootId(() => "66d8d180-8694-489b-8c3a-3fb4795cab24")).toBe(
			BOOT_ID,
		);
	});

	test("currentBootId preserves an unreadable kernel identity as absent", () => {
		expect(currentBootId(() => undefined)).toBeUndefined();
	});
});

describe("version context", () => {
	// Importing main would bind servers and start hardware loops in this unit suite.
	test("the entrypoint starts a non-blocking guarded record after revisions resolve", async () => {
		const main = await Bun.file(new URL("../main.ts", import.meta.url)).text();
		expect(main).toMatch(
			/void guardNonCritical\("boot-record", async \(\) => \{\s*await initRevisions\(\);\s*await logBootRecord\(\);\s*await recordDeviceStart\(\);\s*\}\);/,
		);
	});

	test("logBootRecord emits once and keeps senderVersion through the real logger chain", async () => {
		const sources = deps();
		const original = { ...defaultVersionContextDeps };
		Object.assign(defaultVersionContextDeps, sources);
		restores.push(() => {
			for (const key of Object.keys(defaultVersionContextDeps)) {
				Reflect.deleteProperty(defaultVersionContextDeps, key);
			}
			Object.assign(defaultVersionContextDeps, original);
		});
		const info = spyOn(logger, "info");
		restores.push(() => info.mockRestore());
		const ring = logger.transports.find(
			(transport) => transport.constructor.name === "Stream",
		);
		expect(ring).toBeDefined();
		if (!ring) throw new Error("logger ring transport missing");
		const logged = once(ring, "logged", { signal: AbortSignal.timeout(1000) });
		clearRecentLogLines();

		await logBootRecord();
		await logged;

		expect(info).toHaveBeenCalledTimes(1);
		expect(info).toHaveBeenCalledWith("device started", {
			module: "boot",
			versions: FULL_CONTEXT,
		});
		const lines = getRecentLogLines();
		expect(lines).toHaveLength(1);
		const line = lines[0] ?? "";
		expect(line).not.toContain("[REDACTED]");
		expect(JSON.parse(line)).toMatchObject({
			level: "info",
			msg: "device started",
			module: "boot",
			meta: { versions: FULL_CONTEXT },
		});
	});
});
