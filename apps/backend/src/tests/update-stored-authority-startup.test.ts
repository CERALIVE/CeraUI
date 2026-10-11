import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
	toPersisted,
} from "../modules/system/update-orchestrator/persistence.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	checkUpdatesNow,
	defaultOrchestratorRuntimeDeps,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
});

const valid = JSON.stringify(
	toPersisted({
		...initialOrchestratorState(0),
		phase: "failed",
		failureReason: "commit_unit_absent_on_resume",
	}),
);

test.each([
	["truncated JSON", '{"schema":1,"phase":"committing"'],
	["array root", "[]"],
	["invalid schema", '{"schema":1,"phase":"idle"}'],
	["EIO", valid],
	["EACCES", valid],
])(
	"preserves authority and closes startup when agent has %s",
	async (fault, bytes) => {
		// Given real stored bytes and, for I/O faults, a narrow descriptor-open fault.
		const dir = mkdtempSync(join(tmpdir(), "ceraui-authority-"));
		const file = join(dir, "agent.json");
		setOrchestratorStateFilePathForTest(file);
		await Bun.write(file, bytes);
		const native = fs.open;
		const nativeFile = Bun.file;
		const bunFile = spyOn(Bun, "file").mockImplementation((path, options) => {
			// The legacy loader read through Bun.file; inject the same fault there.
			const blob =
				typeof path === "number"
					? nativeFile(path, options)
					: typeof path === "string" || path instanceof URL
						? nativeFile(path, options)
						: nativeFile(path, options);
			if (path === file && (fault === "EIO" || fault === "EACCES")) {
				spyOn(blob, "text").mockRejectedValue(
					Object.assign(new Error(fault), { code: fault }),
				);
			}
			return blob;
		});
		const open = spyOn(fs, "open").mockImplementation((path, flags, mode) => {
			if (path === file && (fault === "EIO" || fault === "EACCES"))
				return Promise.reject(Object.assign(new Error(fault), { code: fault }));
			return native(path, flags, mode);
		});
		let writes = 0;
		try {
			// When the actual startup consumes the production loader.
			await startUpdateOrchestrator({
				...defaultOrchestratorRuntimeDeps,
				acquireOsStageControl: acquireTestOsStageControl,
				startupRetryClock: { wait: () => Promise.resolve() },
				quarantine: new UpdateQuarantine(
					join(dir, "quarantine.json"),
					async () => {},
				),
				persist: (state) => {
					writes++;
					saveOrchestratorState(state);
				},
				isUpdateAdmissionReady: async () => true,
			}).catch((error: unknown) => {
				if (!(error instanceof Error)) throw error;
			});
			// Then no authority is overwritten and neither mutation is admitted.
			bunFile.mockRestore();
			expect(writes).toBe(0);
			expect(await Bun.file(file).text()).toBe(bytes);
			await expect(checkUpdatesNow()).rejects.toHaveProperty(
				"code",
				"UPDATE_ORCHESTRATOR_INITIALIZING",
			);
			await expect(installUpdatesNow()).rejects.toHaveProperty(
				"code",
				"UPDATE_ORCHESTRATOR_INITIALIZING",
			);
		} finally {
			open.mockRestore();
			bunFile.mockRestore();
			rmSync(dir, { recursive: true });
		}
	},
);
