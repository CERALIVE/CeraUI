import { expect, test } from 'bun:test';
import { loadReplayCorpus, sampleText, versionReplies } from './replay-corpus.ts';
import { replayShell } from './replay-shell-model.ts';

test('the real version checker accepts all seven captured GO-4 command replies', async () => {
	const corpus = await loadReplayCorpus();
	const sample = corpus.manifest.samples.find((row) => row.id === 'r21/versions');
	if (!sample) throw new Error('Missing real version sample');
	const replies = versionReplies(sampleText(corpus, sample));
	expect(Object.keys(replies)).toEqual([
		'bun',
		'NetworkManager',
		'nmcli',
		'iw',
		'hostapd',
		'wpa_supplicant',
		'dnsmasq',
	]);
	const result = await replayShell(
		{ kind: 'versions', replies },
		`
set -euo pipefail
# The replay must work on runners without /usr/bin/nmcli installed.
nmcli_fixture="$1/nmcli"
function /usr/bin/nmcli() { "$nmcli_fixture" "$@"; }
source "$2/guest-versions.sh" 1.4.4
`,
	);
	expect(result.code).toBe(0);
	expect(result.stderr).toBe('');
	expect(result.stdout).toContain('HWSIM-VERSION: bun exit=0 passed=1');
	expect(result.stdout).toContain('HWSIM-VERSION: hostapd exit=1 passed=1');
});

test('bootstrap establishes association instead of relying on profile creation', async () => {
	const corpus = await loadReplayCorpus();
	const before = corpus.manifest.samples.find((row) => row.id === 'r21/nm-devices-capture-2');
	const after = corpus.manifest.samples.find((row) => row.id === 'r20/nm-devices-capture-1');
	if (!before || !after) throw new Error('Missing real station observations');
	const result = await replayShell(
		{
			kind: 'client',
			before: sampleText(corpus, before),
			after: sampleText(corpus, after),
		},
		`
set -euo pipefail
mount -t tmpfs -o mode=0755,nosuid,nodev,noexec tmpfs /run
cd "$1"
printf '{}\\n' >setup.json
printf '{}\\n' >config.json
printf 'wlan1\\n' >/run/hwsim-client
printf 'AP-ENABLED\\n' >/run/hwsim-hostapd.log
check_bootstrap() {
	bash -c 'printf "%s\\n" "$$" >/run/hwsim-hostapd.pid; exec "$1" "$2"' _ "$3" "$2/checks/bootstrap.ts"
}
rc=0
check_bootstrap "$@" || rc=$?
test "$rc" = 1
bash "$2/bootstrap-client.sh" wlan1
check_bootstrap "$@"
`,
	);
	expect(result.code).toBe(0);
	expect(result.stderr).toBe('');
	expect(result.stdout).toContain('client-associated passed=0');
	expect(result.stdout).toContain('client-associated passed=1');
});
