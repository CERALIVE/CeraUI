import { realpath } from "node:fs/promises";
import type { RadioHealth } from "@ceraui/rpc/schemas";
import { run } from "../../helpers/run.ts";
import { getUplinkHealthEngine } from "../network/uplink-health/state.ts";
import { type FreeAtResult, freeAtPorts } from "./free-at-port.ts";
import {
	getRadioRegistrationObservation,
	readRadioNas,
} from "./modem-registration.ts";
import type { WireModemEntry } from "./modem-wire-projection.ts";
import { getModem } from "./modems-state.ts";
import {
	diagnoseRadio,
	emptyRadio,
	metric,
	parseQeng,
	parseQmiSignal,
	type RadioEvidence,
} from "./radio-health.ts";

/** The serving-cell read, on the RM520's released AT port only. */
const readServingCell = (id: number): Promise<FreeAtResult> =>
	freeAtPorts.read(id, 'AT+QENG="servingcell"');

const defaults: {
	enabled: () => Promise<boolean>;
	readNas: typeof readRadioNas;
	readServing?: (id: number) => Promise<FreeAtResult>;
	registration: typeof getRadioRegistrationObservation;
	readText: (path: string) => Promise<string>;
	realpath: typeof realpath;
	run: typeof run;
	health: (
		iface: string,
	) => ReturnType<ReturnType<typeof getUplinkHealthEngine>["get"]>;
	modem: typeof getModem;
} = {
	readServing: readServingCell,
	enabled: async () =>
		!(await Bun.file("/run/ceralive/radio-health-disabled").exists()),
	readNas: readRadioNas,
	registration: getRadioRegistrationObservation,
	readText: (path: string) => Bun.file(path).text(),
	realpath,
	run,
	health: (iface: string) => getUplinkHealthEngine().get(iface),
	modem: getModem,
};
export function resetRadioHealthForTest(): void {
	records = {};
	previous.clear();
	committed.clear();
	lastAt = 0;
}
let records: Record<string, RadioHealth> = {};
/**
 * What a sample's registration was based on: the committed observation it
 * started from and the value it actually used (none once that had expired).
 */
type RegistrationBasis = {
	observation: RegistrationObservation | undefined;
	used: string | undefined;
};
/** The last sample per modem: generation, byte baseline, evidence, registration basis. */
const previous = new Map<
	string,
	{
		generation: number;
		bytes: number | null;
		evidence: RadioEvidence;
		registration: RegistrationBasis;
	}
>();
let lastAt = Date.now();
let refreshing = false;

type RadioIdentityRow = Partial<
	Pick<WireModemEntry, "ifname" | "stable_key" | "iccid">
>;
type RadioRow = Partial<
	Pick<
		WireModemEntry,
		| "ifname"
		| "stable_key"
		| "status"
		| "cell_info"
		| "signal_detail"
		| "registration_rejection"
		| "packet_service_state"
		| "model"
		| "availability_reason"
		| "iccid"
	>
>;
type RegistrationObservation = Readonly<{
	value: string | undefined;
	capturedAt: number;
}>;

/**
 * One modem as the last settled commit published it. The sampler reads only
 * this: the row, its identity, the registration observation committed with its
 * status and the home network. `generation` changes on every committed identity
 * change (a different device, interface or SIM, or the row leaving the roster),
 * and a byte baseline, record or neighbour reading from another generation is
 * never used or served.
 */
type CommittedRadio = Readonly<{
	key: string;
	generation: number;
	row: RadioRow;
	registration: RegistrationObservation | undefined;
	homeNetwork: string | undefined;
}>;
const committed = new Map<string, CommittedRadio>();
let generations = 0;

/** What a commit changed for radio health. */
export type RadioRosterChange = {
	/** IDs still present whose device, interface or SIM changed. */
	identity: string[];
	/** True when any ID was added, removed or changed identity. */
	roster: boolean;
	/** IDs with the same identity whose shown registration changed. */
	registration: string[];
};

/**
 * Record the committed roster. Called with every complete modem message the
 * moment it becomes the committed one, so its registration and home network
 * are those of the live modem the row was just built from. Every stored record
 * loses what it says about an ID whose identity changed or that left, its
 * history included, so no reading of the old modem is served under that ID.
 */
export function commitRadioRoster(
	rows: Readonly<Record<string, object>>,
	live: Pick<typeof defaults, "modem" | "registration"> = defaults,
	now = Date.now(),
): RadioRosterChange {
	const seen = new Set<string>();
	const identity: string[] = [];
	const registrationMoved: string[] = [];
	const moved = new Set<string>();
	for (const [id, entry] of Object.entries(rows)) {
		const row: RadioRow = entry;
		if (typeof row.ifname !== "string") continue;
		seen.add(id);
		const key = radioIdentity(row);
		const before = committed.get(id);
		if (before?.key !== key) {
			moved.add(id);
			if (before) identity.push(id);
		}
		const internal = live.modem(Number(id));
		const same = internal !== undefined && sameIdentity(internal, row);
		const registration = same ? live.registration(internal) : undefined;
		const shownBefore =
			before?.key === key ? shownRegistration(id, now) : undefined;
		committed.set(
			id,
			Object.freeze({
				key,
				generation: before?.key === key ? before.generation : ++generations,
				row: pickRadioRow(row),
				registration,
				homeNetwork: same ? internal.home_network : undefined,
			}),
		);
		// What subscribers see changes with the committed registration: a new
		// value, or a fresh read where the record showed an expired one.
		if (before?.key === key && shownRegistration(id, now) !== shownBefore)
			registrationMoved.push(id);
	}
	for (const id of committed.keys())
		if (!seen.has(id)) {
			committed.delete(id);
			moved.add(id);
		}
	if (moved.size > 0) forgetNeighbours(moved);
	return {
		identity,
		roster: moved.size > 0,
		registration: registrationMoved,
	};
}

/** Drop every stored reading of these IDs from the other modems' records. */
function forgetNeighbours(ids: ReadonlySet<string>): void {
	const unknownBand = (at: number) => emptyRadio(at).band;
	const finding = (f: RadioHealth["finding"], at: number) =>
		f.neighbour !== undefined && ids.has(f.neighbour)
			? emptyRadio(at).finding
			: f;
	for (const [id, record] of Object.entries(records)) {
		if (ids.has(id)) continue;
		records[id] = {
			...record,
			neighbours: record.neighbours.map((n) =>
				ids.has(n.id)
					? { ...n, band: unknownBand(n.capturedAt), transmitting: "unknown" }
					: n,
			),
			finding: finding(record.finding, record.capturedAt),
			timeline: record.timeline.map((entry) => ({
				...entry,
				finding: finding(entry.finding, entry.at),
				...(entry.observation
					? {
							observation: {
								...entry.observation,
								neighbours: entry.observation.neighbours.map((n) =>
									ids.has(n.id)
										? {
												...n,
												band: unknownBand(entry.at),
												transmitting: "unknown" as const,
											}
										: n,
								),
							},
						}
					: {}),
			})),
		};
	}
}

const RADIO_ROW_FIELDS = [
	"ifname",
	"stable_key",
	"status",
	"cell_info",
	"signal_detail",
	"registration_rejection",
	"packet_service_state",
	"model",
	"availability_reason",
	"iccid",
] as const satisfies readonly (keyof RadioRow)[];

/** A copy of only the fields the sampler reads, as this commit states them. */
function pickRadioRow(row: RadioRow): RadioRow {
	const out: Record<string, unknown> = {};
	for (const field of RADIO_ROW_FIELDS)
		if (row[field] !== undefined) out[field] = row[field];
	return out as RadioRow;
}

/** True while the live modem is the device and SIM the committed row names. */
function sameIdentity(
	live: { ifname?: string | undefined; iccid?: string | undefined },
	row: RadioIdentityRow,
): boolean {
	return (
		(live.ifname === undefined || live.ifname === row.ifname) &&
		(live.iccid ?? "") === (row.iccid ?? "")
	);
}

/** The committed generation for this row, or none when the row is not it. */
function committedGeneration(
	id: string,
	row: RadioIdentityRow,
): number | undefined {
	const entry = committed.get(id);
	return entry && entry.key === radioIdentity(row)
		? entry.generation
		: undefined;
}

/**
 * True when this committed row is a different modem or SIM than the one the
 * cached record was sampled for, so subscribers must receive the reset.
 */
export function radioNeedsReset(id: string, row: object): boolean {
	const before = previous.get(id);
	return (
		before !== undefined && before.generation !== committedGeneration(id, row)
	);
}

/** Keep the sampled generation but drop what a later sample would compare with. */
function forgetBaseline(id: string): void {
	const before = previous.get(id);
	if (before)
		previous.set(id, {
			...before,
			bytes: null,
			evidence: { ...before.evidence, at: 0 },
		});
}

/** One modem's identity as the committed roster states it. */
export function radioIdentity(row: RadioIdentityRow): string {
	return `${row.stable_key ?? ""}:${row.ifname ?? ""}:${row.iccid ?? ""}`;
}

/** A registration read still within the 65 s freshness window at `now`. */
function freshRegistration(
	observed: RegistrationObservation | undefined,
	now: number,
): RegistrationObservation | undefined {
	return observed &&
		now >= observed.capturedAt &&
		now - observed.capturedAt <= 65000
		? observed
		: undefined;
}

/** The same owner read: equal value and read time. */
function sameObservation(
	a: RegistrationObservation | undefined,
	b: RegistrationObservation | undefined,
): boolean {
	return a?.value === b?.value && a?.capturedAt === b?.capturedAt;
}

/** The registration value the published record of this ID shows at `now`. */
function shownRegistration(id: string, now: number): unknown {
	const row = committed.get(id)?.row;
	return row ? currentRecord(id, row, now)?.registration.value : undefined;
}

/**
 * The stored record if it belongs to this committed row, else undefined. When
 * a later commit of the same modem brought a registration read whose fresh
 * value differs from what the sample used, the record shows that committed
 * registration and no finding, so it never contradicts the status it is
 * published beside.
 */
function currentRecord(
	id: string,
	row: RadioIdentityRow,
	now: number,
): RadioHealth | undefined {
	const record = records[id];
	const generation = committedGeneration(id, row);
	const sampled = previous.get(id);
	if (!record || generation === undefined || sampled?.generation !== generation)
		return undefined;
	const latest = committed.get(id)?.registration;
	if (sameObservation(latest, sampled.registration.observation)) return record;
	const registration = freshRegistration(latest, now);
	if (registration?.value === sampled.registration.used) return record;
	return {
		...record,
		registration: metric(
			registration?.value ?? null,
			"ModemManager 3GPP",
			"state",
			"unknown",
			registration?.capturedAt ?? 0,
		),
		finding: emptyRadio(record.capturedAt).finding,
	};
}

/**
 * The full cached record per committed modem, for the readings dialog. A row
 * whose identity no longer matches the sampled one (a SIM or device swap on
 * the same id) answers an explicit unknown, as the broadcast does.
 */
export function getRadioHealth(
	committedRows: Readonly<Record<string, object>>,
	now = Date.now(),
): Record<string, RadioHealth> {
	const out: Record<string, RadioHealth> = {};
	for (const [id, entry] of Object.entries(committedRows)) {
		const record = currentRecord(id, entry, now);
		if (!record) continue;
		out[id] = structuredClone(
			now < record.capturedAt || now - record.capturedAt > 65000
				? { ...emptyRadio(now), timeline: record.timeline }
				: record,
		);
	}
	return out;
}
/**
 * Called only by the retained modem status poll. No timer, probe or mutation.
 * Samples the committed roster as {@link commitRadioRoster} last recorded it:
 * one snapshot per modem, taken when the poll starts, is the source of every
 * identity, registration and baseline the poll reads or publishes.
 */
export async function refreshRadioHealth(
	now = Date.now(),
	deps = defaults,
): Promise<void> {
	if (refreshing) return;
	refreshing = true;
	try {
		if (!(await deps.enabled())) {
			records = {};
			previous.clear();
			lastAt = now;
			return;
		}
		const roster = [...committed.entries()];
		const next: Record<string, RadioHealth> = {};
		const samples = new Map<
			string,
			{
				generation: number;
				bytes: number | null;
				registration: RegistrationBasis;
			}
		>();
		const evidence: Record<string, RadioEvidence> = {};
		let kernel:
			| { MESSAGE?: unknown; __REALTIME_TIMESTAMP?: string }[]
			| undefined;
		try {
			const text = await deps.run(
				"journalctl",
				[
					"-k",
					"-b",
					"--since",
					`@${lastAt / 1000}`,
					"--until",
					`@${now / 1000}`,
					"-o",
					"json",
					"--no-pager",
					"-n",
					"512",
				],
				{ timeout: 1500, maxBuffer: 131072 },
			);
			kernel = text
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			if (kernel && kernel.length >= 512) kernel = undefined;
		} catch {
			kernel = undefined;
		}
		const stillCommitted = (id: string, snapshot: CommittedRadio) =>
			committed.get(id)?.generation === snapshot.generation;
		for (const [id, snapshot] of roster) {
			const modem = snapshot.row;
			if (!modem.ifname || !/^[a-zA-Z0-9_.-]+$/.test(modem.ifname)) continue;
			const record = emptyRadio(now);
			if (modem.availability_reason?.startsWith("mm-")) {
				next[id] = record;
				previous.delete(id);
				continue;
			}
			const internal = deps.modem(Number(id));
			// Sample only while the live modem is still the committed one: a
			// staged SIM or device swap waits for the next committed roster.
			// The previous generation stays: it is what makes the next committed
			// frame carry the reset to subscribers. Its byte baseline and evidence
			// do not, so a SIM that comes back starts fresh.
			if (internal && !sameIdentity(internal, modem)) {
				forgetBaseline(id);
				next[id] = record;
				continue;
			}
			// Registration is the observation committed with this row's status.
			// A later live read may only renew its time, when it agrees: a
			// different staged value waits for its commit.
			const live = internal ? deps.registration(internal) : undefined;
			const observed =
				live &&
				snapshot.registration &&
				live.value === snapshot.registration.value &&
				live.capturedAt > snapshot.registration.capturedAt
					? live
					: snapshot.registration;
			const registration = freshRegistration(observed, now);
			record.registration = metric(
				registration?.value ?? null,
				"ModemManager 3GPP",
				"state",
				"unknown",
				registration?.capturedAt ?? 0,
			);
			const cell = modem.cell_info;
			if (
				cell?.provenance?.observed_at &&
				now >= cell.provenance.observed_at &&
				now - cell.provenance.observed_at < 65000
			) {
				record.layer = metric(
					cell.tech ?? null,
					cell.provenance.source ?? "ModemManager",
					"",
					cell.tech ?? "unknown",
					cell.provenance.observed_at,
				);
				record.band = metric(
					cell.band ?? null,
					cell.provenance.source ?? "ModemManager",
					"band",
					cell.tech ?? "unknown",
					cell.provenance.observed_at,
				);
			}
			const nas: Awaited<ReturnType<typeof readRadioNas>> =
				modem.model === "RM520N-GL"
					? await deps.readNas(Number(id))
					: { signal: "", band: "" };
			Object.assign(record.metrics, parseQmiSignal(nas.signal, now));
			let servingRaw = "";
			if (nas.listed && deps.readServing) {
				const result = await deps.readServing(Number(id));
				if (result.ok) servingRaw = result.raw;
				// Never a silent unknown: the fixed reason is part of the field.
				else
					record.metrics.servingCell = {
						...metric(
							null,
							result.unavailable
								? `QENG servingcell · not available: ${result.reason}`
								: `QENG servingcell · no reading: ${result.reason}`,
							"",
							"unknown",
							result.unavailable ? (result.capturedAt ?? now) : now,
						),
						...(result.unavailable ? { reason: "not-available" as const } : {}),
					};
			}
			const serving = parseQeng(servingRaw, now);
			if (serving) {
				record.layer = serving.layer;
				record.band = serving.band;
				Object.assign(record.metrics, serving.metrics);
			}
			if (nas.tx !== undefined)
				record.metrics.lteTxPower = metric(
					null,
					"QMI NAS tx-rx-info",
					"dBm",
					"lte",
					now,
				);
			const tx = nas.tx?.match(/Tx power:\s*'?(-?\d+(?:\.\d+)?)\s*dBm/i);
			if (tx?.[1])
				record.metrics.lteTxPower = metric(
					Number(tx[1]),
					"QMI NAS tx-rx-info",
					"dBm",
					"lte",
					now,
				);
			const band = nas.band.match(/Active band:\s*'([^']+)'/);
			if (band?.[1] && !serving)
				record.band = metric(
					band[1],
					"QMI NAS rf-band-info",
					"band",
					band[1].includes("LTE") ? "lte" : "unknown",
					now,
				);
			for (const name of ["rsrp", "rsrq", "snr", "sinr"] as const) {
				const value = modem.signal_detail?.[name];
				if (
					value?.state === "known" &&
					modem.signal_detail?.quality_recent.state === "known" &&
					modem.signal_detail.quality_recent.value
				)
					record.metrics[`mm.${name}`] = metric(
						value.value,
						`ModemManager Signal ${name}`,
						name === "rsrp" ? "dBm" : "dB",
						cell?.tech ?? "unknown",
						now,
					);
			}
			let bytes: number | null = null;
			try {
				const n = Number(
					await deps.readText(
						`/sys/class/net/${modem.ifname}/statistics/tx_bytes`,
					),
				);
				if (Number.isSafeInteger(n) && n >= 0) bytes = n;
			} catch {
				/* A failed read remains explicitly unavailable. */
			}
			const before = previous.get(id);
			const valid =
				before?.generation === snapshot.generation &&
				now > before.evidence.at &&
				now - before.evidence.at <= 65000;
			const transmitting =
				valid && bytes !== null && before.bytes !== null && bytes > before.bytes
					? "yes"
					: "unknown";
			let port: string | undefined;
			try {
				port = (
					await deps.realpath(`/sys/class/net/${modem.ifname}/device`)
				).match(/\/(\d+-\d+(?:\.\d+)*):\d+\.\d+(?:\/|$)/)?.[1];
			} catch {
				/* A failed read remains explicitly unavailable. */
			}
			const events: RadioEvidence["usb"] = [];
			if (port)
				for (const line of kernel ?? []) {
					if (
						typeof line.MESSAGE !== "string" ||
						!line.MESSAGE.startsWith(`usb ${port}:`)
					)
						continue;
					const kind = /reset .*USB device/.test(line.MESSAGE)
						? "reset"
						: /USB disconnect/.test(line.MESSAGE)
							? "disconnect"
							: undefined;
					const at = Number(line.__REALTIME_TIMESTAMP) / 1000;
					if (kind && Number.isFinite(at)) events.push({ at, kind });
				}
			record.usb = {
				available: kernel !== undefined && port !== undefined,
				events: events.slice(-128),
			};
			// The reads above awaited; a swap staged meanwhile must not be stored
			// under this snapshot's identity. A committed one is dropped below.
			const after = deps.modem(Number(id));
			if ((internal && !after) || (after && !sameIdentity(after, modem))) {
				forgetBaseline(id);
				next[id] = emptyRadio(now);
				continue;
			}
			samples.set(id, {
				generation: snapshot.generation,
				bytes,
				registration: {
					observation: snapshot.registration,
					used: registration?.value,
				},
			});
			const health = deps.health(modem.ifname);
			const numeric = Object.entries(record.metrics);
			evidence[id] = {
				at: now,
				intervalStart: valid ? before.evidence.at : now,
				registration: registration?.value ?? "unknown",
				homeNetwork: snapshot.homeNetwork,
				rejectedNetwork: modem.registration_rejection?.operator_id,
				refused: !!modem.registration_rejection,
				rejectionCause: modem.registration_rejection?.error,
				granted: modem.packet_service_state === "attached",
				failedProbes:
					health?.reason === "probe_failed" ? health.probes.failures : 0,
				probeAt: health?.signals.activeAt,
				rsrp:
					numeric.find(
						([key, m]) =>
							key.endsWith("rsrp") && m.unit === "dBm" && m.value !== null,
					)?.[1] ?? metric(null, "not-observed", "dBm", "unknown", now),
				quality:
					numeric.find(
						([key, m]) =>
							(key.endsWith("rsrq") || key.endsWith("snr")) &&
							m.unit === "dB" &&
							m.value !== null,
					)?.[1] ?? metric(null, "not-observed", "dB", "unknown", now),
				transmitting,
				usb: events,
			};
			next[id] = record;
		}
		// Every read awaited: drop each sample whose identity a commit changed
		// since, before any of them is compared, kept in history or published as
		// a neighbour.
		for (const [id, snapshot] of roster) {
			if (!samples.has(id) || stillCommitted(id, snapshot)) continue;
			samples.delete(id);
			delete evidence[id];
			forgetBaseline(id);
			next[id] = emptyRadio(now);
		}
		for (const [id, record] of Object.entries(next)) {
			const current = evidence[id];
			const sample = samples.get(id);
			if (!current || !sample) continue;
			const before = previous.get(id);
			const sameGeneration = before?.generation === sample.generation;
			const neighbours = Object.fromEntries(
				Object.entries(evidence).filter(([other]) => other !== id),
			);
			record.finding = diagnoseRadio(
				current,
				sameGeneration ? before?.evidence : undefined,
				neighbours,
			);
			record.neighbours = Object.keys(next)
				.filter((other) => other !== id)
				.map((other) => ({
					id: other,
					band: next[other]?.band ?? emptyRadio(now).band,
					transmitting: neighbours[other]?.transmitting ?? "unknown",
					source: "interface tx_bytes delta; zero payload is not radio silence",
					capturedAt: now,
				}));
			record.timeline = [
				...(sameGeneration ? (records[id]?.timeline ?? []) : []),
				{
					at: now,
					finding: record.finding,
					observation: {
						band: record.band,
						rsrp: current.rsrp,
						quality: current.quality,
						usbEvents: record.usb.events.length,
						neighbours: record.neighbours.map(({ id, band, transmitting }) => ({
							id,
							band,
							transmitting,
						})),
					},
				},
			].slice(-120);
			previous.set(id, { ...sample, evidence: current });
		}
		for (const id of previous.keys()) if (!next[id]) previous.delete(id);
		records = next;
		lastAt = now;
	} finally {
		refreshing = false;
	}
}

/** Explicit unknown replaces cached data on a new device or unavailable owner. */
export function radioForModem(
	id: string,
	row: Pick<WireModemEntry, "ifname" | "stable_key" | "availability_reason"> &
		Partial<Pick<WireModemEntry, "iccid">>,
	now = Date.now(),
): RadioHealth {
	const record = currentRecord(id, row, now);
	if (row.availability_reason?.startsWith("mm-") || !record)
		return emptyRadio(0);
	return structuredClone(
		now < record.capturedAt || now - record.capturedAt > 65000
			? { ...emptyRadio(0), timeline: record.timeline.slice(-1) }
			: { ...record, timeline: record.timeline.slice(-1) },
	);
}
