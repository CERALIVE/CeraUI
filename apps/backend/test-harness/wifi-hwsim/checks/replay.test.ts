import { expect, test } from 'bun:test';
import { z } from 'zod';
import { parseNmConnAddUuid } from '../../../src/modules/network/network-manager.ts';
import { nmcliParseSep } from '../../../src/modules/network/network-manager-output.ts';
import {
	bootstrapAssociated,
	canonicalIwPhy,
	decodeIwPhy,
	managedWifiState,
} from './observations.ts';
import {
	journalAudit,
	profileFieldDiff,
	profileSerialization,
	unrelatedProfileWrites,
} from './hybrid-observations.ts';
import { waitForManagedWifiDevice } from './hybrid-readiness.ts';
import { loadReplayCorpus, sampleText } from './replay-corpus.ts';
import { nativePatterns } from './replay-native-predicates.ts';

const corpus = await loadReplayCorpus();
const matchers = await nativePatterns();

test('every retained capture and sample has reviewed, sanitized exact bytes', () => {
	expect(corpus.manifest.captures).toHaveLength(42);
	expect(corpus.manifest.samples).toHaveLength(49);
	expect(new Set(corpus.manifest.samples.map((row) => row.run))).toEqual(
		new Set(['r19', 'r20', 'r21']),
	);
});

for (const sample of corpus.manifest.samples) {
	const text = sampleText(corpus, sample);
	switch (sample.kind) {
		case 'nm-add':
			test(`actual add decoder: ${sample.id}`, () => {
				const result = parseNmConnAddUuid(text);
				expect(result.ok && result.value).toBe(z.string().parse(sample.expected.uuid));
			});
			break;
		case 'nm-devices':
			test(`actual state/association predicates: ${sample.id}`, () => {
				const expected = z
					.object({ client: z.string(), state: z.string(), bootstrap: z.boolean() })
					.parse(sample.expected);
				const ready = [
					'disconnected',
					'connecting',
					'connected',
					'disconnecting',
					'failed',
				].includes(expected.state.split(' ')[0] ?? '');
				expect(managedWifiState(text, expected.client)).toBe(ready ? expected.state : undefined);
				expect(bootstrapAssociated(text, expected.client)).toBe(expected.bootstrap);
				expect(
					text
						.trim()
						.split('\n')
						.map(nmcliParseSep)
						.some(([name]) => name === expected.client),
				).toBe(true);
			});
			break;
		case 'iw-phy':
			test(`decoded physical fields and frozen native predicates: ${sample.id}`, () => {
				const decoded = decodeIwPhy(text);
				expect(decoded.modes.includes('AP')).toBe(z.boolean().parse(sample.expected.ap));
				expect(decoded.frequencies.find((row) => row.channel === 6)?.mhz).toBe(2437);
				const native = matchers.filter((row) => row.file === 'guest-preflight.ts');
				expect(native).toHaveLength(2);
				for (const row of native) expect(row.matcher.test(canonicalIwPhy(text))).toBe(true);
				expect(sample.complete).toBe(false);
				expect(sample.omittedCharacters).toBe(25867);
			});
			break;
		case 'journal':
			test(`actual journal/audit guard: ${sample.id}`, () => {
				const audit = journalAudit(text);
				const expected = z
					.array(
						z.object({
							at: z.number(),
							op: z.string(),
							uuid: z.string(),
							pid: z.string(),
							result: z.string(),
						}),
					)
					.parse(sample.expected.audit);
				expect(
					audit.map(({ at, op, uuid, pid, result }) => ({ at, op, uuid, pid, result })),
				).toEqual(expected);
				expect(audit.every((row) => Number.isFinite(row.at))).toBe(true);
				const uuids = new Set(audit.map((row) => row.uuid));
				const writes = unrelatedProfileWrites(audit, uuids, 0);
				expect(writes.map((row) => row.op)).toEqual(
					audit
						.filter(
							(row) =>
								row.op.startsWith('connection-update') ||
								[
									'connection-add',
									'connection-add-activate',
									'connection-delete',
									'connection-clear-secrets',
								].includes(row.op),
						)
						.map((row) => row.op),
				);
				expect(unrelatedProfileWrites(audit, new Set(), 0)).toEqual([]);
			});
			break;
		case 'keyfile':
			test(`actual persisted-byte comparison and offline predicate: ${sample.id}`, () => {
				const expected = z
					.object({ uuid: z.string(), autoconnect: z.boolean(), sha256: z.string() })
					.parse(sample.expected);
				for (const line of text.split('\n')) {
					const separator = line.indexOf('=');
					if (separator > 0 && /psk|passw|passwd|pin|puk|secret|wep[-_]?key|private[-_]?key/i
						.test(line.slice(0, separator)))
						expect(line.slice(separator + 1)).toBe('<redacted>');
				}
				const serialized = profileSerialization('', new TextEncoder().encode(text));
				expect(serialized).toBe(`keyfile-bytes:${expected.sha256}`);
				expect(profileFieldDiff(new Map([[expected.uuid, serialized]]), new Map())).toEqual([
					`${expected.uuid} (?): profile removed`,
				]);
				const predicate = matchers.find(
					(row) => row.file === 'guest-preflight-nm.ts' && row.flags === 'm',
				);
				if (!predicate) throw new Error('Missing offline keyfile predicate');
				expect(predicate.matcher.test(text)).toBe(expected.autoconnect);
			});
			break;
		case 'iw-dev':
		case 'rfkill':
		case 'os':
		case 'environment':
		case 'permissions':
		case 'systemd':
		case 'versions':
		case 'audit-json':
		case 'ps':
		case 'cloud-init':
			// Other tests exercise their consumers; the loader already checks every capture hash.
			break;
		default: {
			const exhaustive: never = sample.kind;
			throw new Error(`Unhandled replay kind ${exhaustive}`);
		}
	}
}

test('channel flags and the exact AP mode cannot be hidden by frequency normalization', () => {
	const sample = corpus.manifest.samples.find((row) => row.kind === 'iw-phy');
	if (!sample) throw new Error('Missing actual phy sample');
	const text = sampleText(corpus, sample);
	const predicate = matchers.find(
		(row) => row.file === 'guest-preflight.ts' && row.pattern.startsWith('2437'),
	);
	const ap = matchers.find(
		(row) => row.file === 'guest-preflight.ts' && row.pattern.startsWith('\\*'),
	);
	if (!predicate || !ap) throw new Error('Missing frozen predicates');
	expect(
		predicate.matcher.test(
			canonicalIwPhy(text.replace(/(\* 2437[.]0 MHz \[6\]).*/, '$1 (disabled)')),
		),
	).toBe(false);
	expect(
		predicate.matcher.test(canonicalIwPhy(text.replace('2437.0 MHz [6]', '2438.0 MHz [6]'))),
	).toBe(false);
	expect(ap.matcher.test(canonicalIwPhy(text.replace(/^\s+\* AP\s*$/m, '')))).toBe(false);
	expect(predicate.matcher.test(canonicalIwPhy(text.replaceAll('.0 MHz', ' MHz')))).toBe(true);
});

test('readiness consumes the real unavailable then disconnected sequence without claiming association', async () => {
	const first = corpus.manifest.samples.find((row) => row.id === 'r21/nm-devices-capture-1');
	const second = corpus.manifest.samples.find((row) => row.id === 'r21/nm-devices-capture-2');
	if (!first || !second) throw new Error('Missing real restart observations');
	const replies = [sampleText(corpus, first), sampleText(corpus, second)];
	let reads = 0;
	const state = await waitForManagedWifiDevice(
		'wlan1',
		'nmcli',
		async () => {
			const reply = replies[reads++];
			if (!reply) throw new Error('Readiness exhausted captured replies');
			return reply;
		},
		(text) => text,
	);
	expect(state).toBe('disconnected');
	expect(reads).toBe(2);
	expect(bootstrapAssociated(replies[1] ?? '', 'wlan1')).toBe(false);
});
