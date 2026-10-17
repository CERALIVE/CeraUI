import { afterAll, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJsonConfigSync } from "../helpers/config-loader.ts";
import {
	SETUP_CONFIG_DEFAULTS,
	setupConfigSchema,
} from "../helpers/config-schemas.ts";
import { setStreamReconciliationCompletedForTest } from "../modules/system/stream-reconciliation-latch.ts";

// Isolated globals still share /run; seed ownership only from this file's sentinel.
const runtimeRoot = mkdtempSync(join(tmpdir(), "ceraui-backend-test-"));
const previousStreamingMarker = process.env.CERALIVE_STREAMING_MARKER;
process.env.CERALIVE_STREAMING_MARKER = join(runtimeRoot, "streaming");

const setup = await loadJsonConfigSync(
	"setup.json",
	setupConfigSchema,
	SETUP_CONFIG_DEFAULTS,
	false,
);
mock.module("../modules/setup.ts", () => ({ setup }));
// A test process models a booted backend whose stream reconciliation returned;
// suites that exercise the pre-reconciliation window close the latch themselves.
setStreamReconciliationCompletedForTest(true);

afterAll(async () => {
	await Bun.sleep(0);
	await rm("stream.armed.json", { force: true });
	if (previousStreamingMarker === undefined)
		delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = previousStreamingMarker;
	await rm(runtimeRoot, { recursive: true, force: true });
});
