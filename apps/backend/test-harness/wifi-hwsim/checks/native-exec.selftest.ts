import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../../../../..');
const installer = new URL('./first-ap-nmcli-shim.ts', import.meta.url).href;
const lifecycle = `
import {installNativeNmcliShim} from ${JSON.stringify(installer)};
await installNativeNmcliShim("lifecycle-"+crypto.randomUUID());
switch(process.argv[1]) {
	case "throw": throw new Error("controlled crash");
	case "term": process.kill(process.pid,"SIGTERM"); break;
	case "kill": process.kill(process.pid,"SIGKILL"); break;
	default: process.exit(0);
}
await Bun.sleep(1000);
`;
const script = `
set -euo pipefail
ulimit -c 0
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /var/tmp
mount -t tmpfs -o mode=0755,nosuid,nodev,noexec tmpfs /run
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /usr/local/bin
touch /usr/local/bin/bun
mount --bind "$1" /usr/local/bin/bun
mkdir /var/tmp/lifecycle
cd /var/tmp/lifecycle
export HWSIM_REPO=/repo
for mode in throw term; do
	set +e
	bun -e "$3" "$mode" >"/var/tmp/$mode.log" 2>&1
	rc=$?
	set -e
	expected=1; test "$mode" != term || expected=143
	test "$rc" = "$expected"
	test ! -L /usr/local/bin/nmcli || { echo "FAIL: $mode left native launcher"; exit 1; }
	test -z "$(find . -maxdepth 1 -name '.hwsim-nmcli-*' -print -quit)"
	echo "PASS: $mode cleans launcher and state"
done
ln -s /foreign-nmcli /usr/local/bin/nmcli
set +e
bun -e "$3" exit >/var/tmp/exclusive.log 2>&1
rc=$?
set -e
test "$rc" = 1
test "$(readlink /usr/local/bin/nmcli)" = /foreign-nmcli
test -z "$(find . -maxdepth 1 -name '.hwsim-nmcli-*' -print -quit)"
echo "PASS: existing launcher is preserved after refused install"
for mode in throw term kill; do
	set +e
	{ bash "$2/apps/backend/test-harness/wifi-hwsim/native-exec.sh" bun -e "$3" "$mode"; } >"/var/tmp/ns-$mode.log" 2>&1
	rc=$?
	set -e
	expected=1; test "$mode" != term || expected=143; test "$mode" != kill || expected=137
	test "$rc" = "$expected"
	test "$(readlink /usr/local/bin/nmcli)" = /foreign-nmcli
	echo "PASS: private launcher mount disappears after $mode"
done
set +e
bash "$2/apps/backend/test-harness/wifi-hwsim/guest-preflight.sh" >/var/tmp/aggregate.log 2>&1
rc=$?
set -e
test "$rc" = 1
for name in guest-boundary os versions environment; do
	grep -Eq "^HWSIM-PREFLIGHT: $name exit=[1-9]" /var/tmp/aggregate.log ||
		{ echo "FAIL: aggregate omitted $name"; exit 1; }
done
grep -q '^HWSIM-PREFLIGHT: failures=' /var/tmp/aggregate.log
echo "PASS: preflight reports all independent failures and refuses guest actions"
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
		script,
		'native-lifecycle',
		process.execPath,
		repo,
		lifecycle,
	],
	{
		env: {
			...process.env,
			LC_ALL: 'C',
			NODE_ENV: 'development',
			MOCK_MODE: 'true',
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	},
);
const [stdout, stderr, code] = await Promise.all([
	new Response(child.stdout).text(),
	new Response(child.stderr).text(),
	child.exited,
]);
assert.deepEqual({ code, stderr }, { code: 0, stderr: '' }, stdout);
assert.equal(
	stdout,
	[
		'PASS: throw cleans launcher and state',
		'PASS: term cleans launcher and state',
		'PASS: existing launcher is preserved after refused install',
		'PASS: private launcher mount disappears after throw',
		'PASS: private launcher mount disappears after term',
		'PASS: private launcher mount disappears after kill',
		'PASS: preflight reports all independent failures and refuses guest actions',
		'',
	].join('\n'),
);
process.stdout.write(stdout);
