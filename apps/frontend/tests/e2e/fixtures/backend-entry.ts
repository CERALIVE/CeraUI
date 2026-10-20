// The private child channel proves listener ownership without a product endpoint.
if (!process.send) throw new Error('worker backend requires an IPC parent');
process.once('disconnect', () => process.kill(process.pid, 'SIGTERM'));

const { resolve } = await import('node:path');
const { setOrchestratorStateFilePathForTest } = await import(
	'../../../../backend/src/modules/system/update-orchestrator/persistence.js'
);
const { defaultOrchestratorRuntimeDeps, startUpdateOrchestrator } = await import(
	'../../../../backend/src/modules/system/update-orchestrator/runtime.js'
);
const { acquireTestOsStageControl } = await import(
	'../../../../backend/src/tests/helpers/os-stage-test-control.js'
);

// This child owns no installed OS updater. Supply its explicit test ports before
// boot, so production startup admission cannot borrow host /run or /data authority.
setOrchestratorStateFilePathForTest(resolve('update-agent.json'));
await startUpdateOrchestrator({
	...defaultOrchestratorRuntimeDeps,
	acquireOsStageControl: acquireTestOsStageControl,
});

await import('../../../../backend/src/main.js');
const { getServer } = await import('../../../../backend/src/rpc/server.js');
const { getMockPreviewServer } = await import('../../../../backend/src/mocks/providers/preview.js');
const server = getServer();
const preview = getMockPreviewServer();
if (!server || !preview) throw new Error('worker backend did not bind both listeners');

process.send({
	type: 'backend-ready',
	port: server.port,
	previewPort: preview.port,
});

export {};
