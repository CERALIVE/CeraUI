import { expect, test } from 'bun:test';
import { z } from 'zod';
import { loadReplayCorpus, sampleText } from './replay-corpus.ts';
import { dynamicPatterns, nativePatterns } from './replay-native-predicates.ts';
import { canonicalIwPhy } from './observations.ts';
import { mountEntry, failedIntentReasons } from './hybrid-observations.ts';

const corpus = await loadReplayCorpus();
const patterns = await nativePatterns();
const samples = (kind: string) => corpus.manifest.samples.filter((row) => row.kind === kind);

/** Views retain the literal recorded lines; device identity comes from the fixture oracle. */
function interfaceBlocks(text: string): readonly { device: string; text: string }[] {
	const result: { device: string; text: string }[] = [];
	let device = '';
	let lines: string[] = [];
	const flush = () => {
		if (device) result.push({ device, text: lines.join('\n') });
		device = '';
		lines = [];
	};
	for (const line of text.split('\n')) {
		const header = /^\s+Interface (\S+)$/.exec(line)?.[1];
		if (header) {
			flush();
			device = header;
			lines.push(line);
		} else if (/^phy#|^\s+Unnamed/.test(line)) flush();
		else if (device) lines.push(line);
	}
	flush();
	return result;
}

for (const [index, row] of patterns.entries()) {
	test(`literal native predicate ${index}: ${row.file}:${row.owner}`, () => {
		const match = (input: string) => {
			row.matcher.lastIndex = 0;
			return row.matcher.test(input);
		};
		if (row.file === 'guest-preflight.ts') {
			for (const sample of samples('iw-phy'))
				expect(match(canonicalIwPhy(sampleText(corpus, sample)))).toBe(true);
		} else if (row.pattern === '\\btype AP\\b' || row.pattern === '\\bchannel 6\\b') {
			for (const sample of samples('iw-dev')) {
				const blocks = interfaceBlocks(sampleText(corpus, sample));
				expect(blocks).toHaveLength(4);
				for (const block of blocks) {
					const expected =
						row.pattern === '\\btype AP\\b'
							? block.device === sample.expected.apDevice
							: z.array(z.string()).parse(sample.expected.channelDevices).includes(block.device);
					expect(match(block.text)).toBe(expected);
				}
			}
		} else if (row.pattern.startsWith('^\\/org\\/freedesktop')) {
			// No real summary Settings path was retained; these are protocol controls.
			expect(match('/org/freedesktop/NetworkManager/Settings/7')).toBe(true);
			for (const sample of samples('systemd'))
				for (const line of sampleText(corpus, sample).split('\n')) expect(match(line)).toBe(false);
			expect(match('/org/freedesktop/NetworkManager/Devices/7')).toBe(false);
		} else if (row.flags === 'm' && row.file === 'guest-preflight-nm.ts') {
			for (const sample of samples('keyfile'))
				expect(match(sampleText(corpus, sample))).toBe(
					z.boolean().parse(sample.expected.autoconnect),
				);
		} else if (row.pattern.startsWith('((?:password')) {
			for (const sample of samples('keyfile')) {
				const assignments = sampleText(corpus, sample)
					.split('\n')
					.filter((line) => line.startsWith('psk='));
				for (const line of assignments)
					expect(line.replace(row.matcher, '$1<redacted>')).toBe(line);
			}
			expect('psk=REPLAY_PRIVATE'.replace(row.matcher, '$1<redacted>')).toBe('psk=<redacted>');
		} else if (row.pattern.includes('mismatching')) {
			// Actual refusal output is unavailable; preserve a negative against real diagnostics.
			for (const capture of corpus.manifest.captures.filter((entry) =>
				entry.file.endsWith('native.json'),
			))
				expect(match(corpus.text.get(capture.file) ?? '')).toBe(false);
			expect(match('mismatching permanent MAC address')).toBe(true);
		} else if (row.owner === 'captureNmAudit') {
			for (const sample of samples('ps')) {
				const names = sampleText(corpus, sample)
					.split('\n')
					.map((line) => line.trim().split(row.matcher))
					.filter((fields) => fields.length >= 3)
					.map((fields) => fields.slice(2).join(' '));
				expect(names.includes('hostapd')).toBe(true);
				expect(names.includes('NetworkManager')).toBe(true);
			}
		} else if (row.pattern === '\\\\(.)') {
			// Plain captured filenames are real; escaped summary filenames remain a guest-only gap.
			for (const sample of samples('keyfile'))
				expect(sample.file.replace(row.matcher, '$1')).toBe(sample.file);
			expect('Cera\\:Test'.replace(row.matcher, '$1')).toBe('Cera:Test');
		} else if (row.pattern.startsWith('failed-intent:')) {
			for (const capture of corpus.manifest.captures.filter((entry) =>
				entry.file.endsWith('native.json'),
			))
				expect(match(corpus.text.get(capture.file) ?? '')).toBe(false);
			expect(
				match(
					row.pattern.includes('published')
						? 'failed-intent: published is true'
						: 'failed-intent: failures is []',
				),
			).toBe(true);
		} else if (row.owner === 'mountEntry') {
			for (const sample of samples('permissions'))
				expect(
					sampleText(corpus, sample).replace(row.matcher, (_, octal: string) =>
						String.fromCharCode(Number.parseInt(octal, 8)),
					),
				).toBe(sampleText(corpus, sample));
			expect(
				mountEntry(
					'/mnt/a b/file',
					'1 0 0:1 / / rw - ext4 /dev/vda rw\n2 1 0:2 / /mnt/a\\040b rw - tmpfs tmpfs rw\n',
				)?.point,
			).toBe('/mnt/a b');
		} else if (row.owner === 'profileSerialization' && row.pattern.startsWith('^[')) {
			for (const sample of samples('keyfile'))
				for (const line of sampleText(corpus, sample).split('\n')) expect(match(line)).toBe(false);
			expect(match('connection.uuid:owned')).toBe(true);
		} else if (row.owner === 'profileSerialization') {
			for (const sample of samples('keyfile')) {
				const lines = sampleText(corpus, sample)
					.split('\n')
					.filter((line) => line.includes('='));
				for (const line of lines) {
					const key = line.slice(0, line.indexOf('='));
					const last = key.charCodeAt(key.length - 1);
					expect(match(key)).toBe(last >= 48 && last <= 57);
				}
			}
			expect('wep-key0'.replace(row.matcher, '')).toBe('wep-key');
		} else if (row.owner === 'decodeIwPhy') {
			for (const sample of samples('iw-phy')) {
				const text = sampleText(corpus, sample);
				const line = text
					.split('\n')
					.find((value) =>
						row.pattern.includes('MHz')
							? value.includes('2437.0 MHz [6]')
							: value.trim() === '* AP',
					);
				if (!line) throw new Error('Required real phy field missing');
				expect(match(line)).toBe(true);
				expect(match('unrecognized phy output')).toBe(false);
			}
		} else {
			throw new Error(`Unreviewed native predicate ${row.file}:${row.owner}: ${row.pattern}`);
		}
	});
}

test('failed-intent reason parser does not invent failures from real guest logs', () => {
	for (const capture of corpus.manifest.captures.filter((row) =>
		row.file.endsWith('guest-console.txt'),
	))
		expect(
			failedIntentReasons((corpus.text.get(capture.file) ?? '').split('\n'), '02:00:00:00:01:00'),
		).toEqual([]);
});

test('both native dynamic matchers consume recorded values and retain explicit missing-sample gaps', async () => {
	const dynamic = await dynamicPatterns();
	expect(dynamic).toHaveLength(2);
	for (const row of dynamic) {
		if (row.file === 'hybrid-observations.ts') {
			for (const sample of samples('journal')) {
				const text = sampleText(corpus, sample);
				for (const field of ['op', 'uuid', 'pid', 'result'])
					expect(row.instantiate(field).test(text)).toBe(true);
			}
		} else if (row.file === 'first-ap.ts') {
			// Real `iw dev link` replies have not been captured. `iw dev` is not that format.
			for (const sample of samples('iw-dev')) {
				expect(row.instantiate('CeraTest').test(sampleText(corpus, sample))).toBe(false);
			}
			expect(row.instantiate('CeraTest').test('SSID: CeraTest\n')).toBe(true);
		} else throw new Error('Unreviewed dynamic matcher owner');
	}
});
