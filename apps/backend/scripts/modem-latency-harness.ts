#!/usr/bin/env bun

/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Plug-to-UI latency harness — BOARD TOOL, never shipped in the backend.
 *
 *   sudo bun run modem-latency-harness --plug-cycle 4-1.3:4 --phase after --assert
 *   sudo bun run modem-latency-harness --observe-ms 480000 --phase property \
 *        --budgets ./scripts/lib/modem-latency-budgets-observe.json --assert
 *
 * There are TWO committed budget files because there are two kinds of run, and
 * `--assert` deliberately fails on a budgeted interval the phase never measured
 * ("not measured" is not a pass). A plug-cycle phase cannot produce the
 * steady-state property-propagation sample — ModemManager emits property signals
 * on its own schedule — so asserting it there would fail every healthy run; the
 * observe phase cannot produce the attach/detach spans for the same reason
 * inverted. Each file therefore holds exactly the intervals its phase exercises.
 *
 * It drives real plug cycles with `uhubctl` and times the whole path an
 * operator actually waits on: udev attach → ModemManager export → the row
 * reaching a WebSocket client on the device's own origin → a property update →
 * detach. It is deliberately SELF-CONTAINED (nothing imported from `src/`) so
 * it can be copied to a board that carries only the compiled `ceralive` binary
 * and no CeraUI source tree.
 *
 * It measures the SHIPPED path, not a simulation: the WebSocket client
 * authenticates and consumes exactly what the CeraUI frontend consumes, so a
 * regression in the wire producer shows up here as a real latency miss rather
 * than as a passing unit test.
 *
 * Requires root (uhubctl port power, `busctl --system monitor` eavesdropping).
 */

import {
	type CycleWindow,
	deriveCycleMilestones,
	type UdevEpochEvent,
	type WsRowEvent,
} from "./lib/latency-derive.ts";
import {
	budgetsAllGreen,
	type CycleMilestones,
	evaluateBudgets,
	renderBudgetTable,
	renderCycleTable,
	renderSummaryTable,
	summarizeCycles,
} from "./lib/latency-report.ts";
import {
	type BusctlSignal,
	type ModemRowFacts,
	parseBusctlSignals,
	parseUdevMonitorEvents,
	snapshotModemRows,
	udevEventEpochMs,
} from "./lib/latency-sources.ts";

interface Options {
	readonly hubLocation: string | null;
	readonly hubPort: string | null;
	readonly observeMs: number | null;
	readonly cycles: number;
	readonly phase: string;
	readonly wsUrl: string;
	readonly password: string;
	readonly offDelaySec: number;
	readonly settleMs: number;
	readonly tailMs: number;
	readonly gapMs: number;
	readonly budgetsPath: string;
	readonly jsonPath: string | null;
	readonly dumpDir: string | null;
	readonly assert: boolean;
}

const DEFAULT_BUDGETS_PATH = new URL(
	"./lib/modem-latency-budgets.json",
	import.meta.url,
).pathname;

function parseArgs(argv: readonly string[]): Options {
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined || !arg.startsWith("--")) continue;
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			flags.set(arg.slice(2), next);
			i++;
		} else {
			flags.set(arg.slice(2), "true");
		}
	}

	const plug = flags.get("plug-cycle");
	const observeRaw = flags.get("observe-ms");
	if (plug === undefined && observeRaw === undefined) {
		throw new Error(
			"--plug-cycle <hub-location>:<port> is required (or --observe-ms <ms> to measure steady-state property propagation without cycling a port)",
		);
	}
	let hubLocation: string | null = null;
	let hubPort: string | null = null;
	if (plug !== undefined) {
		const [loc, port] = plug.split(":");
		if (!loc || !port) {
			throw new Error(
				`--plug-cycle must be <hub-location>:<port>, got "${plug}"`,
			);
		}
		hubLocation = loc;
		hubPort = port;
	}

	const password = flags.get("password") ?? process.env.CERAUI_PASSWORD ?? "";
	if (password.length === 0) {
		throw new Error(
			"set --password or CERAUI_PASSWORD (the CeraUI UI password)",
		);
	}

	const num = (key: string, fallback: number): number => {
		const raw = flags.get(key);
		if (raw === undefined) return fallback;
		const value = Number(raw);
		if (!Number.isFinite(value)) throw new Error(`--${key} must be a number`);
		return value;
	};

	return {
		hubLocation,
		hubPort,
		observeMs: observeRaw === undefined ? null : num("observe-ms", 0),
		cycles: num("cycles", 3),
		phase: flags.get("phase") ?? "unlabelled",
		wsUrl: flags.get("ws") ?? "ws://127.0.0.1/ws",
		password,
		offDelaySec: num("off-delay", 3),
		settleMs: num("settle-ms", 120_000),
		tailMs: num("tail-ms", 12_000),
		gapMs: num("gap-ms", 10_000),
		budgetsPath: flags.get("budgets") ?? DEFAULT_BUDGETS_PATH,
		jsonPath: flags.get("json") ?? null,
		dumpDir: flags.get("dump-dir") ?? null,
		assert: flags.get("assert") === "true",
	};
}

const mapReplacer = (_key: string, value: unknown): unknown =>
	value instanceof Map ? Object.fromEntries(value) : value;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The epoch instant of boot, so udev's CLOCK_MONOTONIC header can be projected
 * onto the same axis as the bus timestamps and the WebSocket arrivals.
 *
 * `/proc/uptime` has 10 ms granularity and the two reads straddle a scheduling
 * gap, so the offset is sampled repeatedly and the MEDIAN kept — one unlucky
 * sample would otherwise bias every udev milestone in the run by the same
 * amount, which is exactly the kind of systematic error a latency table hides.
 */
async function measureBootEpochMs(samples = 9): Promise<number> {
	const offsets: number[] = [];
	for (let i = 0; i < samples; i++) {
		const text = await Bun.file("/proc/uptime").text();
		const uptimeSec = Number.parseFloat(text.split(" ")[0] ?? "");
		if (Number.isFinite(uptimeSec)) offsets.push(Date.now() - uptimeSec * 1000);
		await sleep(5);
	}
	if (offsets.length === 0) throw new Error("could not read /proc/uptime");
	offsets.sort((a, b) => a - b);
	return offsets[Math.floor(offsets.length / 2)] ?? offsets[0] ?? 0;
}

/** A long-lived capture child whose stdout is accumulated verbatim. */
interface Capture {
	readonly text: () => string;
	readonly stop: () => void;
}

function startCapture(command: readonly string[]): Capture {
	const proc = Bun.spawn([...command], { stdout: "pipe", stderr: "ignore" });
	let buffer = "";
	void (async () => {
		const decoder = new TextDecoder();
		try {
			for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
				buffer += decoder.decode(chunk, { stream: true });
			}
		} catch {
			// The stream ends when we kill the child; that is the normal exit.
		}
	})();
	return { text: () => buffer, stop: () => proc.kill() };
}

/** An authenticated CeraUI WebSocket client that records `status.modems` frames. */
async function connectRowFeed(
	url: string,
	password: string,
): Promise<{
	events: WsRowEvent[];
	latest: () => ReadonlyMap<string, ModemRowFacts>;
	close: () => void;
}> {
	const events: WsRowEvent[] = [];
	const socket = new WebSocket(url);
	let settleLogin: ((error: Error | null) => void) | null = null;

	// ONE message listener for the whole session. A second listener added after
	// login would double-record every `status.modems` frame, and a duplicated
	// frame is indistinguishable from a real re-emission in the milestone search.
	socket.addEventListener("message", (event: MessageEvent) => {
		const message = safeParse(String(event.data));
		if (message === null) return;
		if (message.ping !== undefined) {
			socket.send(JSON.stringify({ pong: true }));
			return;
		}
		if (message.id === "login") {
			const result = message.result as { success?: boolean } | undefined;
			settleLogin?.(
				result?.success === true
					? null
					: new Error("WS login rejected — wrong CeraUI password?"),
			);
			return;
		}
		recordStatus(message, events);
	});

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("WS login timed out")),
			20_000,
		);
		settleLogin = (error) => {
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			reject(new Error(`could not open ${url}`));
		});
		socket.addEventListener("open", () => {
			socket.send(
				JSON.stringify({
					id: "login",
					path: ["auth", "login"],
					input: { password, persistent_token: false },
				}),
			);
		});
	});

	return {
		events,
		latest: () => events[events.length - 1]?.rows ?? new Map(),
		close: () => socket.close(),
	};
}

function safeParse(raw: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(raw);
		return typeof value === "object" && value !== null
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function recordStatus(
	message: Record<string, unknown>,
	events: WsRowEvent[],
): void {
	const status = message.status;
	if (typeof status !== "object" || status === null) return;
	const modems = (status as Record<string, unknown>).modems;
	if (modems === undefined) return;
	events.push({ epochMs: Date.now(), rows: snapshotModemRows(modems) });
}

/** Project the captured udev text onto the epoch axis. */
function udevEpochEvents(
	capture: string,
	bootEpochMs: number,
): readonly UdevEpochEvent[] {
	const projected: UdevEpochEvent[] = [];
	for (const event of parseUdevMonitorEvents(capture)) {
		const epochMs = udevEventEpochMs(event, bootEpochMs);
		if (epochMs === null) continue;
		projected.push({
			epochMs,
			action: event.action,
			devtype: event.properties.get("DEVTYPE") ?? "",
			idPath: event.properties.get("ID_PATH") ?? null,
		});
	}
	return projected;
}

/** Power-cycle one hub port. `-f` is never used — see the plan's runbook §3. */
async function cyclePort(options: Options): Promise<void> {
	if (options.hubLocation === null || options.hubPort === null) return;
	const proc = Bun.spawn(
		[
			"/usr/sbin/uhubctl",
			"-l",
			options.hubLocation,
			"-p",
			options.hubPort,
			"-a",
			"cycle",
			"-d",
			String(options.offDelaySec),
		],
		{ stdout: "ignore", stderr: "pipe" },
	);
	const code = await proc.exited;
	if (code !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`uhubctl exited ${code}: ${stderr.trim()}`);
	}
}

/**
 * Wait for the device to come back, then keep listening for `tailMs`.
 *
 * The tail is not padding: the property-update milestone is measured on a row
 * that ALREADY exists, so closing the window the instant the row appears would
 * structurally guarantee that interval never has a sample.
 */
async function waitForSettle(
	feed: {
		events: readonly WsRowEvent[];
		latest: () => ReadonlyMap<string, ModemRowFacts>;
	},
	preRows: ReadonlyMap<string, ModemRowFacts>,
	options: Options,
): Promise<void> {
	const deadline = Date.now() + options.settleMs;
	while (Date.now() < deadline) {
		const rows = feed.latest();
		const returned = [...rows].some(
			([key, row]) =>
				!preRows.has(key) && !row.provisional && !row.routerBacked,
		);
		if (returned) break;
		await sleep(250);
	}
	await sleep(options.tailMs);
}

async function main(): Promise<number> {
	const options = parseArgs(process.argv.slice(2));
	if (process.getuid?.() !== 0) {
		console.error(
			"! not running as root: uhubctl and `busctl --system monitor` will fail",
		);
		return 2;
	}

	const bootEpochMs = await measureBootEpochMs();
	const feed = await connectRowFeed(options.wsUrl, options.password);
	const udev = startCapture([
		"udevadm",
		"monitor",
		"--property",
		"--udev",
		"--subsystem-match=usb/usb_device",
	]);
	const bus = startCapture([
		"busctl",
		"--system",
		"monitor",
		"org.freedesktop.ModemManager1",
	]);

	const cycles: CycleMilestones[] = [];
	const windows: CycleWindow[] = [];

	try {
		// Let both captures and the row feed settle before the first cycle, so a
		// milestone is never missed because its source had not started reading.
		await sleep(3000);
		// A cycle is scored by DIFFERENCE against the rows that were already
		// standing, so starting before the first frame arrives would make every
		// row look new and every milestone land on the first frame after the
		// cycle. Refusing to start is the only honest response.
		if (feed.events.length === 0) {
			throw new Error(
				"no status.modems frame arrived after login — cannot establish a pre-cycle baseline",
			);
		}

		if (options.observeMs !== null) {
			const preRows = feed.latest();
			const startMs = Date.now();
			console.error(
				`· observing ${Math.round(options.observeMs / 1000)} s with no port cycle; ${preRows.size} rows standing …`,
			);
			await sleep(options.observeMs);
			windows.push({
				cycle: 1,
				startMs,
				endMs: Date.now(),
				preRows,
				observeOnly: true,
			});
		} else {
			for (let cycle = 1; cycle <= options.cycles; cycle++) {
				const preRows = feed.latest();
				const startMs = Date.now();
				console.error(
					`· cycle ${cycle}/${options.cycles}: ${preRows.size} rows standing; cycling port …`,
				);
				await cyclePort(options);
				await waitForSettle(feed, preRows, options);
				windows.push({ cycle, startMs, endMs: Date.now(), preRows });
				console.error(
					`  cycle ${cycle} window closed after ${Math.round((Date.now() - startMs) / 1000)} s`,
				);
				if (cycle < options.cycles) await sleep(options.gapMs);
			}
		}
	} finally {
		// Drain whatever the pipes still hold before the children go away.
		await sleep(1500);
		udev.stop();
		bus.stop();
		await sleep(500);
		feed.close();
	}

	const udevEvents = udevEpochEvents(udev.text(), bootEpochMs);
	const busSignals: readonly BusctlSignal[] = parseBusctlSignals(bus.text());
	console.error(
		`· captured ${udevEvents.length} udev events, ${busSignals.length} bus signals, ${feed.events.length} status frames`,
	);

	// The raw feeds are the audit trail behind every number in the tables: a
	// milestone that reads "—" is only trustworthy if the capture it was derived
	// from can be shown to have (or not have) the event.
	if (options.dumpDir !== null) {
		await Bun.write(`${options.dumpDir}/udev.txt`, udev.text());
		await Bun.write(`${options.dumpDir}/busctl.txt`, bus.text());
		await Bun.write(
			`${options.dumpDir}/status-frames.jsonl`,
			feed.events
				.map((event) =>
					JSON.stringify({
						epochMs: event.epochMs,
						rows: Object.fromEntries(event.rows),
					}),
				)
				.join("\n"),
		);
		await Bun.write(
			`${options.dumpDir}/derived.json`,
			JSON.stringify(
				{ bootEpochMs, windows, udevEvents, busSignals },
				mapReplacer,
				2,
			),
		);
	}
	for (const window of windows) {
		cycles.push(
			deriveCycleMilestones(window, udevEvents, busSignals, feed.events),
		);
	}

	const summaries = summarizeCycles(cycles);
	const budgets = (await Bun.file(options.budgetsPath).json()) as Record<
		string,
		number
	>;
	const verdicts = evaluateBudgets(summaries, budgets);

	console.log(`\n## Phase: ${options.phase}`);
	console.log(
		`port ${options.hubLocation}:${options.hubPort}, ${cycles.length} cycles\n`,
	);
	console.log("### Per-cycle intervals\n");
	console.log(renderCycleTable(cycles));
	console.log("\n### Phase summary\n");
	console.log(renderSummaryTable(summaries));
	console.log("\n### Budgets\n");
	console.log(renderBudgetTable(verdicts));
	for (const cycle of cycles) {
		for (const note of cycle.notes)
			console.log(`\n- cycle ${cycle.cycle}: ${note}`);
	}

	if (options.jsonPath !== null) {
		await Bun.write(
			options.jsonPath,
			`${JSON.stringify(
				{
					phase: options.phase,
					port:
						options.hubLocation === null
							? null
							: `${options.hubLocation}:${options.hubPort}`,
					capturedAt: new Date().toISOString(),
					cycles,
					summaries,
					verdicts,
				},
				mapReplacer,
				2,
			)}\n`,
		);
	}

	if (!options.assert) return 0;
	return budgetsAllGreen(verdicts) ? 0 : 1;
}

main()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(2);
	});
