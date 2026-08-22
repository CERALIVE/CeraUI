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

/*
  Regulatory domain: persisted country → kernel regdomain → DERIVED AP channels.

  THE RULE: this module contains NO country→channel table, and must never gain
  one. A country code is applied to the kernel (`iw reg set <CC>`); the kernel
  then rewrites every wiphy's per-frequency flags from `wireless-regdb`, and the
  AP-usable set is read back OUT of `iw phy`. That is the only way the offered
  channels can stay correct across kernel/regdb updates, dual-radio boards, and
  self-managed adapters that carry their own regulatory rules.

  What "AP-usable" means here (and why each exclusion is not optional):
    - `disabled`         — the frequency is not permitted at all.
    - `no IR`            — NO_INITIATING_RADIATION: the radio may listen but must
                           not transmit first, which is exactly what starting an
                           AP does. Its pre-NO_IR spellings (`passive scanning`,
                           `no IBSS`) mean the same restriction on older kernels.
    - `radar detection`  — DFS. Legal for an AP only with a full radar-detection
                           + channel-availability-check implementation; CeraLive
                           has none, so a DFS channel is never offered.
    - a BAND the regulatory RULES permit no initiating radiation on — see
                           `wifi-regulatory-rules.ts`. That fact lives in the
                           rule data, NOT in the per-channel flags: board-proven
                           on a Rock 5B+ whose `iw phy` listed 5180/5200/5220 with
                           no `no IR` marker while every 5 GHz rule under the
                           world domain read `PASSIVE-SCAN`, so the offered
                           channel failed `Failed to start AP functionality`.
    - 6 GHz              — NetworkManager's `802-11-wireless.band` has no value
                           for it, and AP operation there additionally requires
                           WPA3-SAE. Excluded until both are handled.

  Every effectful call routes through the injectable {@link setRegdomainRunner}
  seam (the `set<Name>Runner` convention used by `ssh.ts` /
  `software-updates.ts`), so tests never touch the host's own regulatory domain.
*/

import { access } from "node:fs/promises";
import {
	REGULATORY_COUNTRY_RE,
	WORLD_REGULATORY_DOMAIN,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import {
	type AutoWifiChannel,
	autoChannelBand,
	type DerivedApChannel,
	explicitChannelId,
	explicitChannelNumber,
	isAutoWifiChannelName,
	type WifiChannel,
} from "./wifi-channels.ts";
import {
	parseRegulatoryRules,
	permitsApInitiationInRange,
	rulesForPhy,
} from "./wifi-regulatory-rules.ts";

export { REGULATORY_COUNTRY_RE, WORLD_REGULATORY_DOMAIN };

// ─── pure parsing ────────────────────────────────────────────────────────────

const WIPHY_RE = /^\s*Wiphy\s+(\S+)\s*$/;
/** `* 2472.0 MHz [13] (20.0 dBm) (no IR)` — the decimal is optional (older `iw`). */
const FREQUENCY_RE = /^\s*\*\s*(\d+)(?:\.\d+)?\s*MHz\s*\[(\d+)\]\s*(.*)$/;
const PAREN_GROUP_RE = /\(([^)]*)\)/g;

/**
 * Flags that make a frequency unusable for an ACCESS POINT. `no ibss` /
 * `passive scan` are the pre-NO_IR spellings of the same restriction.
 */
const AP_BLOCKING_FLAGS = [
	"disabled",
	"no ir",
	"radar detection",
	"passive scan",
	"no ibss",
] as const;

function bandForFrequency(
	freqMhz: number,
): DerivedApChannel["band"] | undefined {
	if (freqMhz >= 2400 && freqMhz <= 2500) return "bg";
	// Upper bound stops at the 6 GHz boundary (5925 MHz) on purpose.
	if (freqMhz >= 4900 && freqMhz < 5925) return "a";
	return undefined;
}

/**
 * The frequency span each band occupies, mirroring {@link bandForFrequency}.
 * Used ONLY to ask the regulatory RULES about a whole band — a channel's own
 * band is still decided by that function, from its own frequency.
 */
const BAND_SPANS: Record<
	DerivedApChannel["band"],
	readonly [startMhz: number, endMhz: number]
> = {
	bg: [2400, 2500],
	a: [4900, 5925],
};

/**
 * May this radio start an AP on this band at all? See
 * `wifi-regulatory-rules.ts` — the question is answered from the `iw reg get`
 * RULE data, which is where a PASSIVE-SCAN-only band is recorded.
 */
export type ApInitiationGate = (
	phy: string,
	band: DerivedApChannel["band"],
) => boolean;

/**
 * The gate a derivation with no regulatory dump runs under: every band passes,
 * so the per-channel flags are the only filter. That is the pre-fix behaviour,
 * and it is the honest one — an answer we did not get is not a prohibition.
 */
const PERMIT_EVERY_BAND: ApInitiationGate = () => true;

/**
 * Build the band gate from an `iw reg get` dump. An absent or empty dump yields
 * {@link PERMIT_EVERY_BAND}; the per-phy section wins over the global one, so a
 * self-managed radio is judged by its OWN domain.
 */
export function buildApInitiationGate(
	regOutput: string | undefined,
): ApInitiationGate {
	if (regOutput === undefined || regOutput.trim() === "") {
		return PERMIT_EVERY_BAND;
	}

	const scopes = parseRegulatoryRules(regOutput);
	const cache = new Map<string, boolean>();

	return (phy, band) => {
		const key = `${phy}\u0000${band}`;
		const cached = cache.get(key);
		if (cached !== undefined) return cached;

		const [startMhz, endMhz] = BAND_SPANS[band];
		const permitted = permitsApInitiationInRange(
			rulesForPhy(scopes, phy),
			startMhz,
			endMhz,
		);
		cache.set(key, permitted);
		return permitted;
	};
}

/** Whether an AP may INITIATE on each band, judged from the regulatory rules. */
export type ApBandPermissions = Record<DerivedApChannel["band"], boolean>;

/** The verdict before any dump has been read: fail open, like the gate itself. */
export const PERMIT_ALL_AP_BANDS: ApBandPermissions = { bg: true, a: true };

function firstWiphyName(output: string): string | undefined {
	for (const line of output.split("\n")) {
		const wiphy = WIPHY_RE.exec(line);
		if (wiphy?.[1]) return wiphy[1];
	}
	return undefined;
}

/**
 * The SAME {@link buildApInitiationGate} predicate `parseIwPhyChannels` runs,
 * asked one layer up so the band-wide `auto_*` rungs can be gated too.
 *
 * Those rungs never came from the derived channel map — they are pushed from the
 * adapter's nmcli band capability — so narrowing the map alone left `auto_50`
 * offered on a PASSIVE-SCAN-only band (board-proven W1r). Phy resolution mirrors
 * {@link deriveApChannels}: the named radio, else the first wiphy in the dump.
 */
export function deriveApInitiationBands(
	phyOutput: string,
	phy?: string,
	regOutput?: string,
): ApBandPermissions {
	const name = phy ?? firstWiphyName(phyOutput);
	if (name === undefined) return PERMIT_ALL_AP_BANDS;

	const gate = buildApInitiationGate(regOutput);
	return { bg: gate(name, "bg"), a: gate(name, "a") };
}

function isApUsable(tail: string): boolean {
	PAREN_GROUP_RE.lastIndex = 0;
	for (const match of tail.matchAll(PAREN_GROUP_RE)) {
		const group = (match[1] ?? "").toLowerCase();
		// `(20.0 dBm)` is the transmit-power reading, not a restriction flag.
		if (group.includes("dbm")) continue;
		if (AP_BLOCKING_FLAGS.some((flag) => group.includes(flag))) return false;
	}
	return true;
}

/**
 * Parse an `iw phy` dump into per-wiphy AP-usable channel lists. Radios are kept
 * APART: a dual-radio board's two wiphys can carry different capabilities, and
 * unioning them would offer one radio a channel only the other can host.
 */
export function parseIwPhyChannels(
	output: string,
	permitsApInitiation: ApInitiationGate = PERMIT_EVERY_BAND,
): Map<string, DerivedApChannel[]> {
	const byPhy = new Map<string, DerivedApChannel[]>();
	let current: DerivedApChannel[] | undefined;
	let currentPhy: string | undefined;

	for (const line of output.split("\n")) {
		const wiphy = WIPHY_RE.exec(line);
		if (wiphy?.[1]) {
			current = [];
			currentPhy = wiphy[1];
			byPhy.set(wiphy[1], current);
			continue;
		}

		if (!current || currentPhy === undefined) continue;

		const freq = FREQUENCY_RE.exec(line);
		if (!freq?.[1] || !freq[2]) continue;

		const freqMhz = Number(freq[1]);
		const channel = Number(freq[2]);
		const band = bandForFrequency(freqMhz);
		if (band === undefined || !Number.isInteger(channel) || channel <= 0) {
			continue;
		}
		if (!permitsApInitiation(currentPhy, band)) continue;
		if (!isApUsable(freq[3] ?? "")) continue;
		if (current.some((c) => c.channel === channel)) continue;

		current.push({ channel, freqMhz, band });
	}

	return byPhy;
}

/**
 * AP-usable channels for ONE radio. With no `phy` name the FIRST wiphy is used —
 * never a union across radios. An unknown name derives nothing.
 *
 * `regOutput` is the `iw reg get` dump the per-channel flags cannot substitute
 * for; omitting it derives exactly as this function did before the rule gate
 * existed.
 */
export function deriveApChannels(
	output: string,
	phy?: string,
	regOutput?: string,
): DerivedApChannel[] {
	const byPhy = parseIwPhyChannels(output, buildApInitiationGate(regOutput));
	if (phy !== undefined) return byPhy.get(phy) ?? [];
	for (const channels of byPhy.values()) return channels;
	return [];
}

/** The active country code from `iw reg get`, or `undefined` when unreadable. */
export function parseRegulatoryDomain(output: string): string | undefined {
	const match = /^\s*country\s+([A-Z0-9]{2}):/m.exec(output);
	return match?.[1];
}

/**
 * The channel set an adapter may be configured with: its band-wide auto entries
 * first, then every derived channel whose band the adapter actually supports.
 * The band gate matters — a 2.4-only radio must never be offered a 5 GHz channel
 * the dump reported for a different band.
 *
 * `permitted` withholds a rung whose band the regulatory RULES forbid initiating
 * on, which the adapter's own band capability cannot know. It defaults to
 * permitting everything: a caller that never asked has learnt no prohibition.
 */
export function offeredHotspotChannels(
	autoChannels: readonly AutoWifiChannel[],
	derived: readonly DerivedApChannel[],
	permitted: ApBandPermissions = PERMIT_ALL_AP_BANDS,
): WifiChannel[] {
	const autos = autoChannels.filter((auto) => {
		const band = autoChannelBand(auto);
		return band === undefined || permitted[band];
	});

	const bands = new Set<DerivedApChannel["band"]>();
	if (autos.includes("auto_24")) bands.add("bg");
	if (autos.includes("auto_50")) bands.add("a");

	const explicit = derived
		.filter((c) => bands.has(c.band))
		.map((c) => explicitChannelId(c.channel));

	return [...autos, ...explicit];
}

/**
 * Recompute an adapter's offered channels against a fresh derivation. Dropping
 * the previous explicit channels first is what makes this idempotent — keeping
 * them would carry an old regdomain's now-illegal channels into the new set.
 *
 * `bandCapability` is the adapter's OWN nmcli band answer, recorded on the first
 * refresh. It has to be stored rather than recovered from `availableChannels`,
 * because a rung the regulatory rules withheld is no longer in there — recovering
 * from the offered set would forget the radio can do 5 GHz at all, and the rung
 * could never come back when the operator sets a country that permits it.
 */
export function refreshHotspotChannels(
	hotspot: {
		availableChannels: WifiChannel[];
		derivedChannels?: DerivedApChannel[];
		bandCapability?: AutoWifiChannel[];
	},
	derived: readonly DerivedApChannel[],
	permitted: ApBandPermissions = getApInitiationBands(),
): void {
	const adapterBandCapability =
		hotspot.bandCapability ??
		hotspot.availableChannels.filter(isAutoWifiChannelName);

	hotspot.bandCapability = [...adapterBandCapability];
	hotspot.derivedChannels = [...derived];
	hotspot.availableChannels = offeredHotspotChannels(
		adapterBandCapability,
		derived,
		permitted,
	);
}

// ─── hotspot restart semantics ───────────────────────────────────────────────

export type HotspotRegdomainAction =
	| { kind: "none" }
	| { kind: "restart" }
	| { kind: "clamp-and-restart"; channel: WifiChannel };

/**
 * What to do with a hotspot when the regulatory domain changes.
 *
 * A live AP is restarted so the new domain is actually applied to the radio
 * (NetworkManager bakes the band/channel into the activation, so an in-place
 * update is not enough). Clients re-associate on the same SSID/PSK.
 */
export function planHotspotRegdomainChange(
	current: { active: boolean; channel: WifiChannel | undefined },
	offered: readonly WifiChannel[],
): HotspotRegdomainAction {
	if (!current.active) return { kind: "none" };
	// A failed/empty derivation proves nothing about legality — never knock a
	// live AP off the air on the strength of an answer we did not get.
	if (offered.length === 0) return { kind: "none" };

	const channel = current.channel;
	if (channel === undefined || isAutoWifiChannelName(channel)) {
		return { kind: "restart" };
	}
	if (offered.includes(channel)) return { kind: "restart" };

	// The channel's whole BAND can be withdrawn by a domain change, so the only
	// always-legal fallback is handing the choice back to the kernel.
	return { kind: "clamp-and-restart", channel: "auto" };
}

// ─── wireless-regdb / CRDA precheck ──────────────────────────────────────────

/** Modern (CRDA-less) kernel regulatory database shipped by `wireless-regdb`. */
export const REGULATORY_DB_PATH = "/lib/firmware/regulatory.db";
/** Detached signature the kernel verifies before loading the database above. */
export const REGULATORY_DB_SIGNATURE_PATH = `${REGULATORY_DB_PATH}.p7s`;
/** Legacy userspace CRDA database, for kernels older than 4.15. */
export const LEGACY_CRDA_DB_PATH = "/usr/lib/crda/regulatory.bin";

export type RegdbSupport = {
	/** `iw reg set <CC>` can take effect on this image. */
	supported: boolean;
	regulatoryDb: boolean;
	regulatoryDbSignature: boolean;
	legacyCrdaDb: boolean;
};

export type RegdbProbeDeps = { exists: (path: string) => Promise<boolean> };

const defaultRegdbProbeDeps: RegdbProbeDeps = {
	exists: async (path) => {
		try {
			await access(path);
			return true;
		} catch {
			return false;
		}
	},
};

/**
 * Does the image actually ship a regulatory database? Without one the kernel
 * silently keeps the world domain and `iw reg set` is inert — so this is the
 * PRECHECK that turns a mysterious "my channel list never changed" into a
 * nameable image gap.
 *
 * Fails CLOSED: a probe that throws reports unsupported rather than propagating.
 */
export async function checkWirelessRegdbSupport(
	deps: RegdbProbeDeps = defaultRegdbProbeDeps,
): Promise<RegdbSupport> {
	const probe = async (path: string) => {
		try {
			return await deps.exists(path);
		} catch {
			return false;
		}
	};

	const regulatoryDb = await probe(REGULATORY_DB_PATH);
	const regulatoryDbSignature = await probe(REGULATORY_DB_SIGNATURE_PATH);
	const legacyCrdaDb = await probe(LEGACY_CRDA_DB_PATH);

	return {
		supported: regulatoryDb || legacyCrdaDb,
		regulatoryDb,
		regulatoryDbSignature,
		legacyCrdaDb,
	};
}

// ─── board-safety armed restore timer ────────────────────────────────────────

/** Transient systemd unit that restores the pre-drill regulatory domain. */
export const REGDOMAIN_RESTORE_UNIT = "dqw3-net-restore";
/** How long the drill has before the restore fires unattended. */
export const REGDOMAIN_RESTORE_DELAY = "10min";

export type RegdomainCommand = { bin: string; args: string[] };

/**
 * Build the `systemd-run` invocation that ARMS an unattended restore of the
 * captured pre-state country. Armed BEFORE any mutation, disarmed after a
 * verified restore — so a drill that loses its operator (or its SSH session)
 * still returns the radio to a known domain.
 *
 * Argv-only: there is no `sh -c`, so the country can never be shell syntax. It
 * is validated anyway and a malformed pre-state THROWS rather than arming a
 * timer that would do nothing.
 */
export function buildRegdomainRestoreCommand(opts: {
	country: string;
	unit?: string;
	delay?: string;
}): RegdomainCommand {
	const country = normalizeCountry(opts.country);
	if (country === undefined) {
		throw new Error(`refusing to arm a restore for country: ${opts.country}`);
	}

	return {
		bin: "systemd-run",
		args: [
			`--unit=${opts.unit ?? REGDOMAIN_RESTORE_UNIT}`,
			`--on-active=${opts.delay ?? REGDOMAIN_RESTORE_DELAY}`,
			"--collect",
			"--description=CeraUI regulatory-domain restore",
			"iw",
			"reg",
			"set",
			country,
		],
	};
}

/** Disarm the armed restore. `--on-active` creates a `<unit>.timer`, not a service. */
export function buildRegdomainDisarmCommand(
	unit: string = REGDOMAIN_RESTORE_UNIT,
): RegdomainCommand {
	return { bin: "systemctl", args: ["stop", `${unit}.timer`] };
}

/** Arm the restore timer. Never throws — an un-armable timer is reported, not fatal. */
export async function armRegdomainRestore(country: string): Promise<boolean> {
	let command: RegdomainCommand;
	try {
		command = buildRegdomainRestoreCommand({ country });
	} catch (err) {
		logger.warn(`regdomain restore not armed: ${err}`);
		return false;
	}

	try {
		await runner(command.bin, command.args);
		logger.info(
			`regdomain restore armed: ${REGDOMAIN_RESTORE_UNIT} in ${REGDOMAIN_RESTORE_DELAY} → ${country}`,
		);
		return true;
	} catch (err) {
		logger.warn(`failed to arm regdomain restore: ${err}`);
		return false;
	}
}

/** Disarm the restore timer. Never throws. */
export async function disarmRegdomainRestore(): Promise<boolean> {
	const command = buildRegdomainDisarmCommand();
	try {
		await runner(command.bin, command.args);
		return true;
	} catch (err) {
		logger.debug(`failed to disarm regdomain restore: ${err}`);
		return false;
	}
}

// ─── effectful surface (injectable) ──────────────────────────────────────────

export type RegdomainRunner = (bin: string, args: string[]) => Promise<string>;

const defaultRegdomainRunner: RegdomainRunner = (bin, args) => run(bin, args);

let runner: RegdomainRunner = defaultRegdomainRunner;
let derivedChannels: DerivedApChannel[] = [];
let apInitiationBands: ApBandPermissions = PERMIT_ALL_AP_BANDS;

/** Test seam — mirrors `setSshServiceRunner` / `setSoftwareUpdateRunner`. */
export function setRegdomainRunner(next: RegdomainRunner | null): void {
	runner = next ?? defaultRegdomainRunner;
}

/** Test seam: drop the derived cache and restore the real runner. */
export function resetRegdomainStateForTest(): void {
	runner = defaultRegdomainRunner;
	derivedChannels = [];
	apInitiationBands = PERMIT_ALL_AP_BANDS;
}

/**
 * Absolute-path fallback for `iw`. A systemd unit whose PATH omits /usr/sbin
 * cannot resolve the bare name, and the failure is indistinguishable from "this
 * image has no iw" unless the full path is tried.
 */
export const IW_FALLBACK_PATH = "/usr/sbin/iw";

function isBinaryMissing(err: unknown): boolean {
	const code = (err as { code?: unknown } | null)?.code;
	if (code === "ENOENT") return true;
	const message = err instanceof Error ? err.message : "";
	return /ENOENT|No such file or directory|command not found/.test(message);
}

/**
 * The ONE `iw` invocation path. Every caller — this module's regulatory
 * get/set and the per-adapter capability model — routes through it, so the
 * injected {@link setRegdomainRunner} seam covers the binary exactly once and a
 * test can never reach the host's radios through a second layer.
 */
export async function runIw(args: string[]): Promise<string> {
	try {
		return await runner("iw", args);
	} catch (err) {
		if (!isBinaryMissing(err)) throw err;
		return await runner(IW_FALLBACK_PATH, args);
	}
}

function normalizeCountry(country: string): string | undefined {
	const normalized = country.trim().toUpperCase();
	return REGULATORY_COUNTRY_RE.test(normalized) ? normalized : undefined;
}

/**
 * Apply a country to the kernel regulatory domain. Returns whether the command
 * was issued successfully — a malformed country spawns NOTHING.
 */
export async function applyRegulatoryDomain(country: string): Promise<boolean> {
	const normalized = normalizeCountry(country);
	if (normalized === undefined) {
		logger.warn(`refusing to set an invalid regulatory country: ${country}`);
		return false;
	}

	try {
		await runIw(["reg", "set", normalized]);
		logger.info(`regulatory domain set to ${normalized}`);
		return true;
	} catch (err) {
		logger.warn(`failed to set regulatory domain ${normalized}: ${err}`);
		return false;
	}
}

/** The kernel's currently-active country code, or `undefined` when unreadable. */
export async function readRegulatoryDomain(): Promise<string | undefined> {
	try {
		return parseRegulatoryDomain(await runIw(["reg", "get"]));
	} catch (err) {
		logger.debug(`failed to read regulatory domain: ${err}`);
		return undefined;
	}
}

/**
 * The raw `iw reg get` dump, or `undefined` when it could not be read. Separate
 * from {@link readRegulatoryDomain} because that one answers with a country code
 * and the band gate needs the RULE lines underneath it.
 */
async function probeRegulatoryRules(): Promise<string | undefined> {
	try {
		return await runIw(["reg", "get"]);
	} catch (err) {
		logger.debug(`failed to read the regulatory rules: ${err}`);
		return undefined;
	}
}

/**
 * The bands the rule gate removed, named for the one diagnostic line a withheld
 * band is worth. Derived by re-deriving WITHOUT the gate rather than from the
 * gate's own bookkeeping, so it reports what was actually withheld.
 */
function bandsWithheldByRules(
	phyOutput: string,
	phy: string | undefined,
	gated: readonly DerivedApChannel[],
): DerivedApChannel["band"][] {
	const kept = new Set(gated.map((c) => c.channel));
	const withheld = new Set<DerivedApChannel["band"]>();
	for (const channel of deriveApChannels(phyOutput, phy)) {
		if (!kept.has(channel.channel)) withheld.add(channel.band);
	}
	return [...withheld];
}

/** One radio's post-regdomain AP answer: its channels AND its band permissions. */
export type ApChannelProbe = {
	channels: DerivedApChannel[];
	bands: ApBandPermissions;
};

/** AP-usable channels for one radio, read back from the kernel post-regdomain. */
export async function probeApChannels(phy?: string): Promise<ApChannelProbe> {
	try {
		const phyOutput = await runIw(["phy"]);
		const regOutput = await probeRegulatoryRules();
		const derived = deriveApChannels(phyOutput, phy, regOutput);
		const bands = deriveApInitiationBands(phyOutput, phy, regOutput);

		const withheld = bandsWithheldByRules(phyOutput, phy, derived);
		if (withheld.length > 0) {
			logger.warn(
				`withholding AP channels on ${withheld.join(", ")}: the effective ` +
					"regulatory domain permits no initiating radiation there " +
					"(PASSIVE-SCAN only), so an AP cannot be started on them",
			);
		}

		return { channels: derived, bands };
	} catch (err) {
		logger.debug(`failed to enumerate wiphy channels: ${err}`);
		return { channels: [], bands: PERMIT_ALL_AP_BANDS };
	}
}

/**
 * Re-derive and cache the AP channel set. Called after boot-apply and after
 * every country change; RETAINS the previous derivation when the probe answers
 * nothing, because an empty answer is a failed probe, not a legal verdict.
 *
 * The band permissions are committed under the SAME rule, for the same reason —
 * a failed read must not be allowed to retire a band.
 */
export async function refreshDerivedApChannels(
	phy?: string,
): Promise<DerivedApChannel[]> {
	const probed = await probeApChannels(phy);
	if (probed.channels.length > 0) {
		derivedChannels = probed.channels;
		apInitiationBands = probed.bands;
	}
	return derivedChannels;
}

/** Last derived AP channel set. Empty until the first successful probe. */
export function getDerivedApChannels(): DerivedApChannel[] {
	return derivedChannels;
}

/** Test/boot seam: seed the derived cache without probing. */
export function setDerivedApChannels(
	channels: readonly DerivedApChannel[],
): void {
	derivedChannels = [...channels];
}

/**
 * Which bands the rules last permitted an AP to initiate on. Permits everything
 * until a probe says otherwise — an unread dump is not a prohibition.
 */
export function getApInitiationBands(): ApBandPermissions {
	return apInitiationBands;
}

/** Test/boot seam: seed the band verdict without probing. */
export function setApInitiationBands(next: ApBandPermissions): void {
	apInitiationBands = { ...next };
}

/**
 * Boot hook: apply the persisted country (absent ⇒ the world domain) and derive
 * the channel set from whatever the kernel then reports. Never throws — a device
 * whose kernel cannot honour `iw reg set` keeps its previous behaviour.
 */
export async function applyPersistedCountry(
	country: string | undefined,
): Promise<void> {
	const target = country ?? WORLD_REGULATORY_DOMAIN;

	const support = await checkWirelessRegdbSupport();
	if (!support.supported) {
		logger.warn(
			`no regulatory database on this image (${REGULATORY_DB_PATH} / ${LEGACY_CRDA_DB_PATH}); ` +
				"the kernel will keep the world domain and hotspot channels stay conservative",
		);
	}

	await applyRegulatoryDomain(target);
	await refreshDerivedApChannels();
}

/** Explicit channel number for a selection, or `undefined` for an auto entry. */
export const channelNumberOf = explicitChannelNumber;
