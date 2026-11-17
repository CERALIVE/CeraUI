import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const preflight = `
import {run,runWithStdin} from "./apps/backend/src/helpers/run.ts";
import {installNativeNmcliShim} from "./apps/backend/test-harness/wifi-hwsim/checks/first-ap-nmcli-shim.ts";
const probe=await installNativeNmcliShim("preflight-"+crypto.randomUUID());
try {
	await run("nmcli",["--version"]);
	await runWithStdin("nmcli",["--version"],"",{timeout:3000,maxBuffer:4096});
	if((await probe.events()).length!==2)throw new Error("missing native shim exec receipts");
	console.log("R19_FIRST_AP_SHIM_EXEC_PREFLIGHT=PASS");
} finally {
	await probe.close();
}
if(await Bun.file("/usr/local/bin/nmcli").exists())throw new Error("native shim launcher survived cleanup");
console.log("R19_FIRST_AP_SHIM_CLEANUP=PASS");
`;

const child = Bun.spawn(
	[
		'unshare',
		'--user',
		'--map-root-user',
		'--mount',
		'--pid',
		'--fork',
		'--mount-proc',
		'--propagation',
		'private',
		'bash',
		'-c',
		`
set -euo pipefail
mount -t tmpfs -o mode=0755,nosuid,nodev,noexec tmpfs /run
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /usr/local/bin
touch /usr/local/bin/bun
mount --bind "$1" /usr/local/bin/bun
exec /usr/local/bin/bun --eval "$2"
`,
		'native-shim-offline',
		process.execPath,
		preflight,
	],
	{
		cwd: resolve(import.meta.dir, '../../../../..'),
		env: { ...process.env, HWSIM_REPO: '/repo', LC_ALL: 'C' },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	},
);
const [stdout, stderr, exit] = await Promise.all([
	new Response(child.stdout).text(),
	new Response(child.stderr).text(),
	child.exited,
]);
assert.deepEqual(
	{ exit, stderr, stdout },
	{
		exit: 0,
		stderr: '',
		stdout: 'R19_FIRST_AP_SHIM_EXEC_PREFLIGHT=PASS\nR19_FIRST_AP_SHIM_CLEANUP=PASS\n',
	},
);
process.stdout.write(stdout);
