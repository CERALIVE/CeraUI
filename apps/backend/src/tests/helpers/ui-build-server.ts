/**
 * The shipped entrypoint in a process of its own, in a directory of its own (its
 * working directory), bound to a free port it reports to its parent. What it
 * reads its build identity from, the socket upgrade and the login are all its
 * own; only host process cleanup, autostart, the installed updater and the mock
 * preview listener are kept out. `TEST_BUILD_STAMP` is the stamp an install
 * left beside it, `TEST_CONFIG` the settings it starts from.
 */
import { spyOn } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const { TEST_BUILD_STAMP, TEST_CONFIG } = process.env;
if (TEST_BUILD_STAMP !== undefined)
	writeFileSync("build-id", `${TEST_BUILD_STAMP}\n`);
writeFileSync(
	"config.json",
	JSON.stringify({
		password_hash: Bun.password.hashSync("correct-password", {
			algorithm: "bcrypt",
			cost: 4,
		}),
		...JSON.parse(TEST_CONFIG ?? "{}"),
	}),
);
// Mock boot checks that the sender is readable but never runs it.
writeFileSync("srtla_send", "");
writeFileSync(
	"setup.json",
	JSON.stringify({
		...JSON.parse(
			readFileSync(new URL("../../../setup.json", import.meta.url), "utf8"),
		),
		ips_file: resolve("srtla_ips"),
		srtla_path: resolve("srtla_send"),
		cerastream_socket: resolve("engine.sock"),
	}),
);
Object.assign(process.env, {
	MOCK_SCENARIO: "caps-full",
	CERALIVE_DEVICE_TYPE: "emulated",
	CERALIVE_EVENTS_DIR: resolve("events"),
	CERALIVE_STREAMING_MARKER: resolve("streaming"),
	NOTIFY_SOCKET: "",
	PORT: "0",
	PREVIEW_PORT: "0",
});

// Imported once the files and the environment they read are in place.
const processCleanup = await import("../../helpers/killall.ts");
const preview = await import("../../mocks/providers/preview.ts");
const streamloop = await import("../../modules/streaming/streamloop.ts");
const updates = await import("../../modules/system/update-bootstrap.ts");
const { setOrchestratorStateFilePathForTest } = await import(
	"../../modules/system/update-orchestrator/persistence.ts"
);
const { defaultOrchestratorRuntimeDeps, startUpdateOrchestrator } =
	await import("../../modules/system/update-orchestrator/runtime.ts");
const { acquireTestOsStageControl } = await import(
	"./os-stage-test-control.ts"
);

spyOn(processCleanup, "default").mockResolvedValue(undefined);
spyOn(preview, "startMockPreviewServer").mockReturnValue(null);
spyOn(streamloop, "checkAutoStartStream").mockResolvedValue(undefined);
spyOn(updates, "runUpdateBootstrap").mockResolvedValue(undefined);
setOrchestratorStateFilePathForTest(resolve("update-agent.json"));
await startUpdateOrchestrator({
	...defaultOrchestratorRuntimeDeps,
	acquireOsStageControl: acquireTestOsStageControl,
});

await import("../../main.ts");

const { getServer } = await import("../../rpc/server.ts");
process.send?.({ port: getServer()?.port });
