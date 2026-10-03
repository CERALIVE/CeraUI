import { expect, test } from "bun:test";
import ts from "typescript";
import { pendingPackageSuccess } from "../modules/system/update-orchestrator/pending-success-fence.ts";
import { saveOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import {
	admitAndPrepareStreamStart,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";

test("combined D8 has a package refusal between publishing recovery and phase inspection", async () => {
	// Given the actual merged entrypoint, including its publishing-recovery await.
	const text = await Bun.file(
		new URL(
			"../modules/system/update-orchestrator/runtime.ts",
			import.meta.url,
		),
	).text();
	const source = ts.createSourceFile(
		"runtime.ts",
		text,
		ts.ScriptTarget.Latest,
		true,
	);
	const entry = source.statements.find(
		(node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) &&
			node.name?.text === "admitAndPrepareStreamStart",
	);
	if (!entry?.body) throw new Error("D8 entrypoint absent");
	// When structural statement order is inspected, not a comment or duplicate text.
	const statements = entry.body.statements;
	const osRecovery = statements.findIndex(
		(node) =>
			ts.isIfStatement(node) &&
			node.expression.getText(source).startsWith("publishingIntentPending("),
	);
	const packageGuard = statements.findIndex(
		(node) =>
			ts.isIfStatement(node) &&
			node.expression.getText(source) === "pendingPackageSuccess.pending",
	);
	const inspection = statements.findIndex(
		(node) =>
			ts.isVariableStatement(node) &&
			node.declarationList.declarations.some(
				(declaration) => declaration.name.getText(source) === "cached",
			),
	);
	// Then an observation during recovery cannot inherit the earlier admission verdict.
	expect(osRecovery).toBeGreaterThanOrEqual(0);
	expect(packageGuard).toBeGreaterThan(osRecovery);
	expect(inspection).toBeGreaterThan(packageGuard);
	const guard = statements[packageGuard];
	if (!guard || !ts.isIfStatement(guard))
		throw new Error("package guard absent");
	expect(guard.thenStatement.getText(source)).toBe(
		"return COMMIT_STAGE_REFUSAL;",
	);
});

test("combined D8 withholds phase dispatch when completion arrives after stop submission", async () => {
	// Given an admitted real persisted download with its stop promise controlled.
	const stopped = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let stops = 0;
	const f = runtimeFixture({
		recoverSoftwareUpdateIfRunning: async () => true,
		getPackageInstallWireState: () => ({
			kind: "downloading",
			progress: { total: 1, downloading: 0, unpacking: 0, setting_up: 0 },
		}),
		isCommitStageRunning: async () => false,
		stopPackageInstallUnit: async () => {
			stops++;
			stopped.resolve();
			await release.promise;
		},
	});
	saveOrchestratorState(
		{ ...initialOrchestratorState(0), phase: "downloading" },
		f.file,
	);
	try {
		await startUpdateOrchestrator(f.deps);
		const before = await Bun.file(f.file).text();
		const admission = admitAndPrepareStreamStart();
		await stopped.promise;
		// When success is observed after the stop was submitted, not before it.
		pendingPackageSuccess.observe();
		release.resolve();
		// Then submitted work is not undone, but no aborted-phase write borrows permission.
		expect(await admission).toMatchObject({
			allowed: false,
			reason: "update_in_progress",
		});
		expect(stops).toBe(1);
		expect(await Bun.file(f.file).text()).toBe(before);
	} finally {
		release.resolve();
		f.cleanup();
	}
});
