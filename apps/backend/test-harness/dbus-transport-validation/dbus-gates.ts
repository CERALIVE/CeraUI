// Board-validation harness for the `@ceralive/modem-control` D-Bus transport seam.
//
// This is a TEST HARNESS, not product code: nothing in `apps/backend/src` imports it and
// it is never bundled into the shipped binary. It exists to prove, on real hardware and
// under the service's real identity (root, systemd unit context), that the pure-JS
// transport (`@ceralive/modem-control/transport`, backed by `@httptoolkit/dbus-native`)
// can hold a ModemManager subscription on the SYSTEM bus. The subprocess `busctl`/`gdbus`
// bridge is only built if one of the gates below goes red.
//
// Gates, and where each is observable in the emitted JSONL:
//   1  connect system bus                -> {"gate":1,...,"ok":true}
//   2  GetManagedObjects snapshot        -> {"gate":2,...,"modemCount":N}
//   3  InterfacesAdded/Removed +
//      PropertiesChanged + NameOwnerChanged -> {"event":"signal",...}
//   4  survive a ModemManager restart    -> {"gate":4,"phase":"resubscribed"|"resnapshot"}
//   5  clean shutdown on SIGTERM         -> {"gate":5,...} then exit 0
//   6  sustained subscription, no leak   -> {"event":"sample","rssKb":...,"fdCount":...}
//
// Every line is one JSON object on stdout (and, with --log, appended to a file) so the
// run is machine-checkable after the fact from the journal alone.

import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import {
	createDbusTransport,
	type DbusTransport,
	type DbusValue,
	type SignalEvent,
	type Subscription,
} from '@ceralive/modem-control/transport';

const MM_BUS_NAME = 'org.freedesktop.ModemManager1';
const MM_ROOT_PATH = '/org/freedesktop/ModemManager1';
const MM_MODEM_PATH = /^\/org\/freedesktop\/ModemManager1\/Modem\/\d+$/;
const SYSTEM_BUS_SOCKET = '/run/dbus/system_bus_socket';

interface Options {
	readonly socket: string;
	readonly durationSec: number;
	readonly sampleIntervalSec: number;
	readonly snapshotOnly: boolean;
	readonly logPath: string | undefined;
}

function parseArgs(argv: readonly string[]): Options {
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	return {
		socket: get('--socket') ?? SYSTEM_BUS_SOCKET,
		durationSec: Number(get('--duration-sec') ?? '0'),
		sampleIntervalSec: Number(get('--sample-interval-sec') ?? '300'),
		snapshotOnly: argv.includes('--snapshot-only'),
		logPath: get('--log'),
	};
}

const options = parseArgs(process.argv.slice(2));
const startedAt = Date.now();

function emit(record: Record<string, unknown>): void {
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		uptimeSec: Math.round((Date.now() - startedAt) / 1000),
		pid: process.pid,
		...record,
	});
	process.stdout.write(`${line}\n`);
	if (options.logPath !== undefined) {
		appendFileSync(options.logPath, `${line}\n`);
	}
}

// RSS from /proc rather than process.memoryUsage(): the soak gate's bound is stated
// against the same number an operator would read with `ps`/`cat /proc/<pid>/status`.
function rssKb(): number {
	const status = readFileSync('/proc/self/status', 'utf8');
	const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
	return match === null ? -1 : Number(match[1]);
}

function fdCount(): number {
	return readdirSync('/proc/self/fd').length;
}

function isModemPath(path: unknown): boolean {
	return typeof path === 'string' && MM_MODEM_PATH.test(path);
}

// `GetManagedObjects` replies with `a{oa{sa{sv}}}`, which the transport decodes to an
// array of `[objectPath, interfaces]` entry pairs.
function modemPathsFrom(body: readonly DbusValue[]): string[] {
	const dict = body[0];
	if (!Array.isArray(dict)) {
		return [];
	}
	return dict
		.map((entry) => (Array.isArray(entry) ? entry[0] : undefined))
		.filter(isModemPath) as string[];
}

async function snapshot(transport: DbusTransport, gate: number, phase: string): Promise<number> {
	const reply = await transport.callMethod({
		destination: MM_BUS_NAME,
		path: MM_ROOT_PATH,
		interface: 'org.freedesktop.DBus.ObjectManager',
		member: 'GetManagedObjects',
	});
	const paths = modemPathsFrom(reply.body);
	emit({
		gate,
		phase,
		event: 'snapshot',
		ok: true,
		signature: reply.signature,
		modemCount: paths.length,
		modemPaths: paths,
	});
	return paths.length;
}

function describeSignal(event: SignalEvent): Record<string, unknown> {
	const base = {
		event: 'signal',
		gate: 3,
		member: event.member,
		path: event.path,
		sender: event.sender,
		signature: event.signature,
	};
	if (event.member === 'NameOwnerChanged') {
		const [name, oldOwner, newOwner] = event.body;
		return { ...base, name, oldOwner, newOwner };
	}
	if (event.member === 'PropertiesChanged') {
		const [iface, changed] = event.body;
		const keys = Array.isArray(changed)
			? changed.map((entry) => (Array.isArray(entry) ? entry[0] : undefined))
			: [];
		return { ...base, iface, changedKeys: keys };
	}
	if (event.member === 'InterfacesAdded') {
		const [objectPath, ifaces] = event.body;
		const names = Array.isArray(ifaces)
			? ifaces.map((entry) => (Array.isArray(entry) ? entry[0] : undefined))
			: [];
		return { ...base, objectPath, interfaces: names };
	}
	if (event.member === 'InterfacesRemoved') {
		const [objectPath, ifaces] = event.body;
		return { ...base, objectPath, interfaces: ifaces };
	}
	return { ...base, body: event.body };
}

async function main(): Promise<void> {
	emit({ event: 'start', options, rssKb: rssKb(), fdCount: fdCount() });

	const transport = createDbusTransport({ socket: options.socket });
	transport.on('error', (payload) => emit({ event: 'transport-error', error: String(payload) }));
	transport.on('disconnected', () => emit({ event: 'transport-disconnected' }));
	transport.on('reconnected', () => emit({ event: 'transport-reconnected' }));

	// Gate 1 — connect the system bus.
	try {
		await transport.connect();
		emit({ gate: 1, event: 'connect', ok: true, connected: transport.isConnected() });
	} catch (error) {
		emit({ gate: 1, event: 'connect', ok: false, error: String(error) });
		process.exit(1);
	}

	// Gate 2 — initial managed-objects snapshot.
	await snapshot(transport, 2, 'initial');

	if (options.snapshotOnly) {
		await transport.disconnect();
		emit({ gate: 5, event: 'shutdown', reason: 'snapshot-only', ok: true });
		process.exit(0);
	}

	// Gate 3 — subscriptions. Kept in a rebuildable list so the MM-restart path (gate 4)
	// can tear every one down and re-issue it against the new name owner.
	let subscriptions: Subscription[] = [];
	const subscribeAll = async (): Promise<void> => {
		subscriptions = await Promise.all([
			transport.subscribeSignal(
				{ interface: 'org.freedesktop.DBus.ObjectManager', member: 'InterfacesAdded' },
				(event) => emit(describeSignal(event)),
			),
			transport.subscribeSignal(
				{ interface: 'org.freedesktop.DBus.ObjectManager', member: 'InterfacesRemoved' },
				(event) => emit(describeSignal(event)),
			),
			transport.subscribeSignal(
				{ interface: 'org.freedesktop.DBus.Properties', member: 'PropertiesChanged' },
				(event) => {
					// The bus-wide PropertiesChanged rule catches every service; only MM's own
					// objects are evidence for this gate.
					if (event.path.startsWith(MM_ROOT_PATH)) {
						emit(describeSignal(event));
					}
				},
			),
			transport.subscribeSignal(
				{
					interface: 'org.freedesktop.DBus',
					member: 'NameOwnerChanged',
					path: '/org/freedesktop/DBus',
				},
				(event) => {
					const [name, , newOwner] = event.body;
					if (name !== MM_BUS_NAME) {
						return;
					}
					emit(describeSignal(event));
					// Gate 4 — MM came back: re-issue every match rule against the new owner
					// and prove a fresh snapshot completes.
					if (typeof newOwner === 'string' && newOwner.length > 0) {
						void recover();
					}
				},
			),
		]);
		emit({
			gate: 3,
			event: 'subscribed',
			ok: true,
			subscriptionCount: transport.subscriptionCount(),
		});
	};

	const unsubscribeAll = async (): Promise<void> => {
		await Promise.all(subscriptions.map((s) => s.unsubscribe()));
		subscriptions = [];
	};

	let recovering = false;
	const recover = async (): Promise<void> => {
		if (recovering) {
			return;
		}
		recovering = true;
		try {
			await unsubscribeAll();
			await subscribeAll();
			emit({ gate: 4, phase: 'resubscribed', ok: true });
			await snapshot(transport, 4, 'resnapshot');
		} catch (error) {
			emit({ gate: 4, phase: 'recover', ok: false, error: String(error) });
		} finally {
			recovering = false;
		}
	};

	await subscribeAll();

	// Gate 6 — periodic RSS / fd / subscription-count samples.
	const baseline = { rssKb: rssKb(), fdCount: fdCount() };
	emit({ gate: 6, event: 'sample', label: 'baseline', ...baseline });
	const sampler = setInterval(() => {
		emit({
			gate: 6,
			event: 'sample',
			rssKb: rssKb(),
			fdCount: fdCount(),
			rssDeltaKb: rssKb() - baseline.rssKb,
			fdDelta: fdCount() - baseline.fdCount,
			subscriptionCount: transport.subscriptionCount(),
		});
	}, options.sampleIntervalSec * 1000);

	// Gate 5 — clean shutdown: drop every match rule, close the bus, exit 0.
	let shuttingDown = false;
	const shutdown = async (reason: string): Promise<void> => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		clearInterval(sampler);
		const final = { rssKb: rssKb(), fdCount: fdCount() };
		emit({
			gate: 6,
			event: 'sample',
			label: 'final',
			...final,
			rssDeltaKb: final.rssKb - baseline.rssKb,
			fdDelta: final.fdCount - baseline.fdCount,
		});
		try {
			await unsubscribeAll();
			await transport.disconnect();
			emit({
				gate: 5,
				event: 'shutdown',
				reason,
				ok: true,
				subscriptionCount: transport.subscriptionCount(),
			});
			process.exit(0);
		} catch (error) {
			emit({ gate: 5, event: 'shutdown', reason, ok: false, error: String(error) });
			process.exit(1);
		}
	};

	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	process.on('SIGINT', () => void shutdown('SIGINT'));

	if (options.durationSec > 0) {
		setTimeout(() => void shutdown('duration-elapsed'), options.durationSec * 1000);
	}
}

void main();
