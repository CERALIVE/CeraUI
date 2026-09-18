// The private child channel proves listener ownership without a product endpoint.
if (!process.send) throw new Error('worker backend requires an IPC parent');
process.once('disconnect', () => process.kill(process.pid, 'SIGTERM'));

await import('../../../../backend/src/main.js');
const { getServer } = await import('../../../../backend/src/rpc/server.js');
const { getMockPreviewServer } = await import('../../../../backend/src/mocks/providers/preview.js');
const server = getServer();
const preview = getMockPreviewServer();
if (!server || !preview) throw new Error('worker backend did not bind both listeners');

process.send({ type: 'backend-ready', port: server.port, previewPort: preview.port });

export {};
