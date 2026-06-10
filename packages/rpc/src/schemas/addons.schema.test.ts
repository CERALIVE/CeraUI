/**
 * Add-on descriptor + state schema tests (T22).
 *
 * The descriptor fixture mirrors image-building-pipeline's debug-toolset.json.
 * It is inlined (not imported) because that file lives in a sibling repo and a
 * schema test must never read above the CeraUI checkout root (Rule D).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// APT_PACKAGE_NAME_RE is imported (never copied) to prove the add-on schema
// reuses the one canonical Debian package-name pattern (G5). It lives in a
// side-effect-free backend module so this rpc test can import it without
// loading the software-updates module graph. Test-only relative import — the
// @ceraui/rpc *source* must never import the backend.
import { APT_PACKAGE_NAME_RE } from '../../../../apps/backend/src/modules/system/apt-package-name';
import { AddonConfigSchema, AddonDescriptorSchema, AddonStateSchema } from './addons.schema';

const validDebugToolset = {
	id: 'debug-toolset',
	name: 'Debug Toolset',
	version: '1.0.0',
	category: 'debug',
	icon: 'wrench',
	payload: { type: 'sysext' },
	sysextLevel: '1',
	versionId: '12',
	compatibleOsVersions: ['12'],
	artifact: {
		urlTemplate: 'https://apt.ceralive.tv/addons/debug-toolset/{os_version}/debug-toolset.raw',
		sha256: 'd0009ed268df5fd0ec12904201c64be392f56671a4d61acec7355188536bb5e9',
		gpgSigRef: 'https://apt.ceralive.tv/addons/debug-toolset/{os_version}/debug-toolset.raw.asc',
		sizeDownload: 4194304,
		sizeInstalled: 12582912,
	},
	provides: ['/usr/bin/htop', '/usr/bin/strace', '/usr/bin/tcpdump', '/usr/bin/iperf3'],
	deps: [],
	conflicts: [],
	units: { unmask: [], enable: [], start: [] },
	validate: { cmd: '/usr/bin/strace -V', timeout: 10 },
};

describe('AddonDescriptorSchema', () => {
	test('valid debug-toolset descriptor parses successfully', () => {
		const parsed = AddonDescriptorSchema.parse(validDebugToolset);
		expect(parsed.id).toBe('debug-toolset');
		expect(parsed.sysextLevel).toBe('1');
		expect(parsed.versionId).toBe('12');
		expect(parsed.provides).toHaveLength(4);
	});

	test('G2 — a /etc path in provides[] is rejected with a provides field path', () => {
		const bad = { ...validDebugToolset, provides: ['/usr/bin/htop', '/etc/foo'] };
		const result = AddonDescriptorSchema.safeParse(bad);
		expect(result.success).toBe(false);
		if (result.success) throw new Error('expected /etc path to be rejected');
		const paths = result.error.issues.map((i) => i.path.join('.'));
		expect(paths).toContain('provides.1');
	});

	test('missing sysextLevel is rejected with a sysextLevel field path', () => {
		const { sysextLevel: _omitted, ...withoutLevel } = validDebugToolset;
		const result = AddonDescriptorSchema.safeParse(withoutLevel);
		expect(result.success).toBe(false);
		if (result.success) throw new Error('expected missing sysextLevel to be rejected');
		const paths = result.error.issues.map((i) => i.path.join('.'));
		expect(paths).toContain('sysextLevel');
	});
});

describe('AddonStateSchema / AddonConfigSchema', () => {
	test('a well-formed runtime state parses', () => {
		const state = AddonStateSchema.parse({ enabled: true, phase: 'active', autoDisabled: false });
		expect(state.phase).toBe('active');
	});

	test('an invalid phase enum value is rejected with a phase field path', () => {
		const result = AddonStateSchema.safeParse({
			enabled: true,
			phase: 'running',
			autoDisabled: false,
		});
		expect(result.success).toBe(false);
		if (result.success) throw new Error('expected invalid phase to be rejected');
		const paths = result.error.issues.map((i) => i.path.join('.'));
		expect(paths).toContain('phase');
	});

	test('AddonConfigSchema maps add-on id -> state', () => {
		const cfg = AddonConfigSchema.parse({
			'debug-toolset': { enabled: false, phase: 'idle', autoDisabled: false },
		});
		expect(cfg['debug-toolset']?.phase).toBe('idle');
	});
});

describe('G5 — package-name pattern is reused, not copied', () => {
	test('APT_PACKAGE_NAME_RE is the canonical imported regex', () => {
		expect(APT_PACKAGE_NAME_RE).toBeInstanceOf(RegExp);
		expect(APT_PACKAGE_NAME_RE.source).toBe('^[A-Za-z0-9.+:~-]+$');
	});

	test('addons.schema.ts does not redefine the Debian package-name charset', () => {
		const source = readFileSync(new URL('./addons.schema.ts', import.meta.url), 'utf8');
		expect(source).not.toContain('A-Za-z0-9.+:~-');
	});
});
