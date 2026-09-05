import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { password as bunPassword, write } from 'bun';

const e2ePassword = process.env.E2E_PASSWORD;
if (e2ePassword === undefined || e2ePassword.length === 0) {
	throw new Error('E2E_PASSWORD is required');
}

const backendDir = path.resolve(import.meta.dirname, '../../apps/backend');
const passwordHash = bunPassword.hashSync(e2ePassword, {
	algorithm: 'bcrypt',
	cost: 10,
});
const token = randomUUID();

await Promise.all([
	write(
		path.join(backendDir, 'config.json'),
		JSON.stringify({
			srtla_addr: '127.0.0.1',
			srtla_port: 5000,
			srt_streamid: 'e2e',
			max_br: 5000,
			remote_key: 'mock-pairing-key',
			remote_provider: 'ceralive',
			password_hash: passwordHash,
		}),
	),
	write(path.join(backendDir, 'auth_tokens.json'), JSON.stringify({ [token]: true })),
]);
