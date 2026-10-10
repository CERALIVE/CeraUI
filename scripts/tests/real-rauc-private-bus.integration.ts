import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Bun from 'bun';
import { STAGE_CENSUS_DRIFT } from '../../apps/backend/src/modules/system/update-orchestrator/os-stage-admission-diagnostics.ts';
import { observeRaucStage } from '../../apps/backend/src/modules/system/update-orchestrator/os-stage-observation.ts';
import { stageEvidence } from '../../apps/backend/src/modules/system/update-orchestrator/os-stage-process-evidence.ts';
import { runOsStageJob } from '../../apps/backend/src/modules/system/update-orchestrator/os-stage-run.ts';
import { rockHelperFixture } from '../../apps/backend/src/tests/helpers/os-stage-rock-helper-fixture.ts';
import { harness } from '../../apps/backend/src/tests/helpers/os-stage-run-harness.ts';
import { manifest } from '../../apps/backend/src/tests/helpers/os-stage-run-inputs.ts';

test('real private RAUC read helpers fence next-pair dispatch', async () => {
	// Given unmodified boot helpers, real host RAUC/private bus/cgroup and synthetic install/slot authority.
	const source = process.env.CERALIVE_BOOT_HELPERS;
	if (!source)
		throw new Error(
			'CERALIVE_BOOT_HELPERS must name the directory containing the unmodified image boot helpers',
		);
	const root = await mkdtemp(join(tmpdir(), 'uso-private-rauc-'));
	await chmod(root, 0o700);
	const unit = `uso-private-rauc-${crypto.randomUUID()}.service`;
	const exec = async (argv: string[]) => {
		const child = Bun.spawn(['timeout', '10', ...argv], { stdout: 'pipe', stderr: 'pipe' });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode) throw new Error(JSON.stringify({ argv: argv.slice(0, 3), exitCode, stderr }));
		return { stdout, stderr, exitCode };
	};
	const bus = Bun.spawn(
		['dbus-daemon', '--session', '--nofork', `--address=unix:path=${root}/bus`],
		{ stdout: 'ignore', stderr: 'pipe' },
	);
	let launched = false;
	const captures: unknown[] = [];
	try {
		expect((await exec(['rauc', '--version'])).stdout.trim()).toBe('rauc 1.15.2');
		await mkdir(join(root, 'bin'));
		await Bun.write(join(root, 'state'), 'BOOT_ORDER=B A\nBOOT_A_LEFT=3\nBOOT_B_LEFT=3\n');
		await Bun.write(join(root, 'cmdline'), 'rauc.slot=B\n');
		await Bun.write(join(root, 'a'), 'file-backed test slot A');
		await Bun.write(join(root, 'b'), 'file-backed test slot B');
		await exec(['mkfifo', join(root, 'ready'), join(root, 'gate')]);
		await Bun.write(
			join(root, 'bin', 'dirname'),
			`#!/bin/bash\nif [[ -e '${root}/hold' ]]; then printf '%s\\n' "$PPID" > '${root}/ready'; read -r release < '${root}/gate'; fi\nexec /usr/bin/dirname "$@"\n`,
		);
		await chmod(join(root, 'bin', 'dirname'), 0o700);
		await Bun.write(
			join(root, 'system.conf'),
			`[system]\ncompatible=uso-host-only\nbootloader=custom\nstatusfile=${root}/status.raucs\n[handlers]\nbootloader-custom-backend=${source}/ceralive-rauc-boot-adapter.sh\n[slot.rootfs.0]\ndevice=${root}/a\ntype=raw\nbootname=A\n[slot.rootfs.1]\ndevice=${root}/b\ntype=raw\nbootname=B\n`,
		);
		await exec([
			'systemd-run',
			'--user',
			`--unit=${unit}`,
			'--service-type=exec',
			'--property=RuntimeMaxSec=90',
			'--property=TimeoutStopSec=5',
			`--setenv=DBUS_SYSTEM_BUS_ADDRESS=unix:path=${root}/bus`,
			`--setenv=CERALIVE_BOOT_STATE_BIN=${source}/ceralive-boot-state.sh`,
			`--setenv=CERALIVE_BOOT_STATE_FILE=${root}/state`,
			`--setenv=CERALIVE_BOOT_STATE_CORE=${process.env.CERALIVE_BOOT_STATE_CORE ?? join(source, 'boot-state-core.sh')}`,
			`--setenv=CERALIVE_KERNEL_CMDLINE_FILE=${root}/cmdline`,
			`--setenv=PATH=${root}/bin:/usr/bin:/bin`,
			'rauc',
			'-c',
			join(root, 'system.conf'),
			'--override-boot-slot=B',
			'service',
		]);
		launched = true;
		const address = `unix:path=${root}/bus`;
		await exec(['gdbus', 'wait', `--address=${address}`, '--timeout=5', 'de.pengutronix.rauc']);
		await exec([
			'busctl',
			`--address=${address}`,
			'--timeout=5',
			'--watch-bind=yes',
			'get-property',
			'de.pengutronix.rauc',
			'/',
			'de.pengutronix.rauc.Installer',
			'Operation',
		]);
		const actual = await exec([
			'systemctl',
			'--user',
			'show',
			unit,
			'--property=MainPID,ControlGroup,InvocationID,ActiveState',
		]);
		const group = /^ControlGroup=(.+)$/m.exec(actual.stdout)?.[1];
		const daemon = /^MainPID=(.+)$/m.exec(actual.stdout)?.[1];
		if (!group || !daemon) throw new Error('private cgroup unavailable');
		const h = await harness();
		const synthetic = rockHelperFixture([]).deps;
		let held = false;
		let armed = false;
		let remaining = new Set<string>();
		let request: Promise<unknown> | undefined;
		let capturedHelper = false;
		const diagnostics: string[] = [];
		const observeDeps = {
			...synthetic,
			device: async (path: string) => (path === join(root, 'b') ? '179:5' : '179:4'),
			read: async (path: string) => {
				if (path.endsWith('cgroup.procs')) {
					const raw = await Bun.file(`/sys/fs/cgroup${group}/cgroup.procs`).text();
					remaining = new Set(raw.trim().split(/\s+/));
					return raw;
				}
				if (/^\/proc\/[0-9]+\//.test(path)) {
					const raw = await Bun.file(path).text();
					const pid = /^\/proc\/([0-9]+)\/stat$/.exec(path)?.[1];
					if (pid && remaining.has(pid)) {
						captures.push({ path, raw });
						if (held && pid !== daemon) capturedHelper = true;
						remaining.delete(pid);
						if (held && remaining.size === 0) {
							// Retire between censuses: holding through status blocks the real daemon's GetPrimary.
							held = false;
							await exec(['bash', '-c', 'printf "release\\n" > "$1"', 'bash', join(root, 'gate')]);
							await request;
							await rm(join(root, 'hold'));
						}
					}
					return raw;
				}
				return synthetic.read(path);
			},
			run: async (argv: string[]) => {
				if (argv[0] === 'systemctl')
					return { ...actual, stdout: actual.stdout.replace(group, '/system.slice/rauc.service') };
				if (argv[0] === 'busctl') return exec(['busctl', `--address=${address}`, ...argv.slice(1)]);
				return exec([
					'env',
					`DBUS_SYSTEM_BUS_ADDRESS=${address}`,
					'rauc',
					'-c',
					join(root, 'system.conf'),
					...argv.slice(1),
				]);
			},
		};
		// When replacement admission crosses the real helper's first/final census retirement.
		const result = await runOsStageJob(manifest, h.control, {
			...h.deps,
			observe: async (...args) => {
				if (h.attempts() === 0) return h.deps.observe(...args);
				const snapshot = await observeRaucStage(args[0], observeDeps, (detail) => {
					diagnostics.push(detail);
					args[2]?.(detail);
				});
				captures.push({ snapshot, evidence: stageEvidence(snapshot) });
				return snapshot;
			},
			selection: async () => {
				const selected = await h.deps.selection();
				if (h.attempts() === 1 && !armed) {
					armed = true;
					await Bun.write(join(root, 'hold'), 'hold');
					const ready = exec([
						'bash',
						'-c',
						'read -r pid < "$1"; printf "%s\\n" "$pid"',
						'bash',
						join(root, 'ready'),
					]);
					request = exec([
						'busctl',
						`--address=${address}`,
						'call',
						'de.pengutronix.rauc',
						'/',
						'de.pengutronix.rauc.Installer',
						'GetPrimary',
					]);
					captures.push({ helperReady: await ready });
					held = true;
				}
				return selected;
			},
		});
		captures.push({ unit, service: actual.stdout, result, events: h.events, diagnostics });
		// Then the real drift refuses its sample, and fresh clean proof authorizes exactly one replacement.
		expect(capturedHelper).toBe(true);
		expect(diagnostics).toContain(STAGE_CENSUS_DRIFT);
		expect(result).toBe('receipt');
		expect(h.attempts()).toBe(2);
		process.stdout.write(
			'PASS: real RAUC 1.15.2/private bus/user-systemd cgroup/unmodified boot helpers. Install, guardian and slot/resource authority are synthetic; no board qualification.\n',
		);
	} catch (error) {
		captures.push({
			journal: await exec(['journalctl', '--user', `--unit=${unit}`, '--no-pager', '--lines=30']),
		});
		throw error;
	} finally {
		if (process.env.CERALIVE_RAUC_PROOF_OUTPUT)
			await Bun.write(process.env.CERALIVE_RAUC_PROOF_OUTPUT, JSON.stringify(captures, null, 2));
		if (launched) await exec(['systemctl', '--user', 'stop', unit]);
		bus.kill();
		await bus.exited;
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
