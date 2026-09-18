import net from 'node:net';

export interface BackendPortLease {
	readonly port: number;
	release(): Promise<void>;
}

function close(server: net.Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	});
}

function listen(server: net.Server, target: net.ListenOptions): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(target, () => {
			server.off('error', reject);
			resolve();
		});
	});
}

/** Linux abstract sockets release with the process: no stale lockfiles to steal. */
export async function leaseBackendPort(preferred: number): Promise<BackendPortLease> {
	if (process.platform !== 'linux') {
		throw new Error('Local E2E backend port leasing requires Linux abstract sockets');
	}
	// Keep the upper half free for the CI cross-worker admission control's +50 peer.
	const count = 50;
	for (let offset = 0; offset < count; offset++) {
		const port = 3100 + ((preferred - 3100 + offset) % count);
		const lease = net.createServer((socket) => socket.destroy());
		try {
			await listen(lease, { path: `\0ceraui-e2e-backend-${port}` });
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') continue;
			throw error;
		}
		const probe = net.createServer((socket) => socket.destroy());
		try {
			await listen(probe, { port, host: '::', ipv6Only: false });
			await close(probe);
			return { port, release: () => close(lease) };
		} catch (error) {
			await close(lease);
			if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') continue;
			throw error;
		}
	}
	throw new Error('No free E2E backend port in 3100–3149');
}
