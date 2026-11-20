import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Model =
	| {
			readonly kind: 'versions';
			readonly replies: Readonly<
				Record<
					string,
					{
						readonly output: string;
						readonly code: number;
					}
				>
			>;
	  }
	| { readonly kind: 'client'; readonly before: string; readonly after: string };

const driver = `
import {readFileSync,writeFileSync} from "node:fs";
const m=JSON.parse(readFileSync(process.env.HWSIM_REPLAY_MODEL,"utf8"));
const args=process.argv.slice(2);
switch(m.kind) {
case "versions": {
	const reply=m.replies[name];
	if(!reply||!Number.isInteger(reply.code)||reply.code<0||reply.code>255)process.exit(64);
	process.stdout.write(reply.output);process.exit(reply.code);
}
case "client": {
	if(name!=="nmcli")process.exit(64);
	const field=(key)=>args[args.indexOf(key)+1];
	const connection=args.indexOf("connection");
	if(connection>=0&&args[connection+1]==="add") {
		if(field("ifname")!=="wlan1"||field("con-name")!=="CeraTest")process.exit(65);
		writeFileSync(process.env.HWSIM_REPLAY_STATE,m.before);process.exit(0);
	}
	if(connection>=0&&args[connection+1]==="up") {
		if(field("ifname")!=="wlan1"||field("id")!=="CeraTest")process.exit(66);
		writeFileSync(process.env.HWSIM_REPLAY_STATE,m.after);process.exit(0);
	}
	if(args.includes("device")&&args.includes("status")) {
		process.stdout.write(readFileSync(process.env.HWSIM_REPLAY_STATE,"utf8"));process.exit(0);
	}
	process.exit(67);
}
default: process.exit(68);
}
`;

/** Static command model emits captured data; it never evaluates a sample as code. */
export async function replayShell(model: Model, script: string) {
	const root = await mkdtemp(join(tmpdir(), 'wifi-replay-'));
	try {
		const modelPath = join(root, 'model.json');
		const state = join(root, 'state.txt');
		await writeFile(modelPath, JSON.stringify(model), { mode: 0o600 });
		if (model.kind === 'client') await writeFile(state, model.before, { mode: 0o600 });
		for (const name of [
			'bun',
			'NetworkManager',
			'nmcli',
			'iw',
			'hostapd',
			'wpa_supplicant',
			'dnsmasq',
		])
			await writeFile(
				join(root, name),
				`#!${process.execPath}\nconst name=${JSON.stringify(name)};\n${driver}`,
				{ mode: 0o700 },
			);
		const child = Bun.spawn(
			[
				'unshare',
				'--user',
				'--map-root-user',
				'--mount',
				'--pid',
				'--fork',
				'--mount-proc',
				'--net',
				'--propagation',
				'private',
				'bash',
				'-c',
				script,
				'replay',
				root,
				resolve(import.meta.dir, '..'),
				process.execPath,
			],
			{
				env: {
					...process.env,
					PATH: `${root}:/usr/bin:/bin`,
					HWSIM_REPLAY_MODEL: modelPath,
					HWSIM_REPLAY_STATE: state,
					HWSIM_REPO: '/repo',
					NODE_ENV: 'production',
					MOCK_MODE: 'false',
					LC_ALL: 'C',
				},
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: 15000,
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
