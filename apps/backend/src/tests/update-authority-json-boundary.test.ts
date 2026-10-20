import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadOrchestratorState,
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
	toPersisted,
} from "../modules/system/update-orchestrator/persistence.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	admitAndPrepareStreamStart,
	checkUpdatesNow,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { fakeDeps } from "./helpers/orchestrator-runtime-harness.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
});

test.each(["absent", "pretty"])(
	"actual %s startup still opens fresh idle admission",
	async (kind) => {
		const dir = await mkdtemp(join(tmpdir(), "authority-first-boot-"));
		const path = join(dir, "agent.json");
		if (kind === "pretty")
			await writeFile(
				path,
				JSON.stringify(toPersisted(initialOrchestratorState(0)), null, 2),
			);
		setOrchestratorStateFilePathForTest(path);
		let writes = 0;
		try {
			await startUpdateOrchestrator(
				fakeDeps({
					readPersistedState: loadOrchestratorState,
					startupRetryClock: { wait: async () => {} },
					isUpdateAdmissionReady: async () => true,
					quarantine: new UpdateQuarantine(
						join(dir, "quarantine"),
						async () => {},
					),
					persist: (state) => {
						writes++;
						saveOrchestratorState(state);
					},
				}),
			);
			expect(getOrchestratorState().phase).toBe("idle");
			expect(writes).toBe(kind === "absent" ? 1 : 0);
			expect((await admitAndPrepareStreamStart()).allowed).toBe(true);
			expect(await checkUpdatesNow()).toMatchObject({ started: true });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test.each(["phase", "nested"])(
	"startup preserves contradictory %s authority with zero writes",
	async (kind) => {
		// Given a real valid record whose raw members disagree.
		const dir = await mkdtemp(join(tmpdir(), "authority-json-"));
		const path = join(dir, "agent.json");
		const valid = JSON.stringify(toPersisted(initialOrchestratorState(0)));
		const bytes =
			kind === "phase"
				? valid.replace('"phase":"idle"', '"phase":"committing","phase":"idle"')
				: valid.replace(
						'"packageCheck":{',
						'"packageCheck":{"lastCheckedAt":1,"lastCheckedAt":2,',
					);
		await writeFile(path, bytes);
		setOrchestratorStateFilePathForTest(path);
		let writes = 0;
		try {
			// When actual runtime startup uses the production state boundary.
			await startUpdateOrchestrator(
				fakeDeps({
					readPersistedState: loadOrchestratorState,
					startupRetryClock: { wait: async () => {} },
					acquireOsStageControl: acquireTestOsStageControl,
					isUpdateAdmissionReady: async () => true,
					quarantine: new UpdateQuarantine(
						join(dir, "quarantine"),
						async () => {},
					),
					persist: (state) => {
						writes++;
						saveOrchestratorState(state);
					},
				}),
			);
			// Then ambiguity latches maintenance; neither D8 nor discovery can clear it.
			expect(writes).toBe(0);
			expect(await readFile(path, "utf8")).toBe(bytes);
			expect(getOrchestratorState().phase).toBe("failed");
			await expect(admitAndPrepareStreamStart()).rejects.toHaveProperty(
				"code",
				"UPDATE_ORCHESTRATOR_INITIALIZING",
			);
			await expect(checkUpdatesNow()).rejects.toHaveProperty(
				"code",
				"UPDATE_ORCHESTRATOR_INITIALIZING",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test.each(["top", "nested"])(
	"quarantine rejects %s duplicate protection members",
	async (kind) => {
		const dir = await mkdtemp(join(tmpdir(), "quarantine-json-"));
		const path = join(dir, "quarantine.json");
		const row =
			kind === "top"
				? '"os":[{"version":"2026.10.5","bootedVersion":"2026.10.4"}],"os":[]'
				: '"os":[{"version":"2026.10.5","version":"2026.10.6","bootedVersion":"2026.10.4"}]';
		const bytes = `{"schema":1,"packages":[],${row},"failedCommits":[]}`;
		await writeFile(path, bytes);
		try {
			await expect(
				new UpdateQuarantine(path).isOsVersionQuarantined("2026.10.5"),
			).rejects.toThrow();
			expect(await readFile(path, "utf8")).toBe(bytes);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test.each(["dangling-parent", "invalid-utf8", "oversize"])(
	"stored agent refuses %s without erasing bytes",
	async (kind) => {
		const dir = await mkdtemp(join(tmpdir(), "authority-encoding-"));
		const path = join(dir, "agent.json");
		const valid = JSON.stringify(toPersisted(initialOrchestratorState(0)));
		let target = path;
		if (kind === "dangling-parent") {
			await symlink(join(dir, "missing"), join(dir, "parent"));
			target = join(dir, "parent/agent.json");
		} else if (kind === "invalid-utf8")
			await writeFile(
				path,
				Buffer.from(
					valid.replace('"failureReason":null', '"failureReason":"\u00ff"'),
					"latin1",
				),
			);
		else await writeFile(path, valid + " ".repeat(1024 * 1024));
		try {
			await expect(loadOrchestratorState(target)).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test("valid pretty JSON and genuine missing directory retain first-boot semantics", async () => {
	const dir = await mkdtemp(join(tmpdir(), "authority-valid-"));
	const path = join(dir, "agent.json");
	const state = initialOrchestratorState(0);
	await writeFile(path, JSON.stringify(toPersisted(state), null, 2));
	try {
		expect(await loadOrchestratorState(path)).toEqual(state);
		expect(
			await loadOrchestratorState(join(dir, "fresh/agent.json")),
		).toBeNull();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
