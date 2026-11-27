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
 * The APN a NEW gsm profile starts with, when Automatic APN would get it wrong.
 *
 * New profiles are created with `gsm.auto-config yes`, so NetworkManager picks
 * the APN at connect time from mobile-broadband-provider-info. Its rule
 * (`nm-modem-broadband.c` + `nm-service-providers.c`, unchanged from 1.22 to
 * 1.58) has two properties that matter here:
 *
 *  1. it is keyed on the SERVING network (`Modem3gpp.OperatorCode`), not on the
 *     SIM's home network;
 *  2. it takes the FIRST `<apn>` with `<usage type="internet"/>` of the first
 *     provider listing that network, in file order.
 *
 * Board-measured on a FM350 (NM 1.52.1, provider database 20250613): a SIM whose
 * home network is 26221 registered on 26202 and NM sent `web.vodafone.de`, the
 * host network's APN, which the network refused on every attempt. The same rule
 * gives Verizon's `vzwims` (an IMS APN listed first with usage "internet") for
 * any Verizon SIM.
 *
 * So this module answers one narrow question for a profile that does not exist
 * yet: would NetworkManager's automatic choice differ from the APN the database
 * lists for the SIM's OWN network? Only then is that APN written explicitly,
 * with Automatic APN off, and the UI says where the value comes from so it can
 * be corrected. In every other case the profile is created exactly as before.
 * A SIM whose home network the database does not list keeps Automatic APN too:
 * there is nothing better to write (an empty APN is not reliably the network's
 * default on every modem), but the UI says so instead of failing silently.
 */

import { readFile } from "node:fs/promises";
import { parseStringPromise } from "xml2js";

import { logger } from "../../helpers/logger.ts";

/** Read at use, so a test or a host can point it elsewhere. */
export function providerDatabasePath(): string {
	return (
		process.env.CERALIVE_PROVIDER_DATABASE_PATH ??
		"/usr/share/mobile-broadband-provider-info/serviceproviders.xml"
	);
}

export type ProviderApn = {
	readonly apn: string;
	readonly username: string;
	readonly password: string;
	/** `usage type` values, verbatim. NM matches only the exact "internet". */
	readonly usage: readonly string[];
};

export type ProviderEntry = {
	readonly name: string;
	/** MCC+MNC strings, e.g. "26201". */
	readonly networks: readonly string[];
	readonly apns: readonly ProviderApn[];
};

/** Providers in FILE order: NetworkManager's pick depends on that order. */
export type ProviderDatabase = readonly ProviderEntry[];

/** What a new profile should start with. */
export type ApnHint =
	| {
			readonly source: "provider-database";
			readonly homeNetwork: string;
			readonly apn: string;
			readonly username: string;
			readonly password: string;
	  }
	| { readonly source: "not-listed"; readonly homeNetwork: string };

/** Wire vocabulary for the hint, see `modemConfigSchema.apn_source`. */
export type ApnSource = ApnHint["source"];

type XmlNode = Record<string, unknown> & { $?: Record<string, string> };

function children(node: XmlNode | undefined, key: string): XmlNode[] {
	const value = node?.[key];
	return Array.isArray(value) ? (value as XmlNode[]) : [];
}

function text(node: XmlNode | undefined, key: string): string {
	const value = node?.[key];
	if (!Array.isArray(value) || value.length === 0) return "";
	const first = value[0] as unknown;
	if (typeof first === "string") return first.trim();
	const inner = (first as XmlNode | undefined)?._;
	return typeof inner === "string" ? inner.trim() : "";
}

/** Parse serviceproviders.xml into the subset the APN choice needs. */
export async function parseProviderDatabase(
	xml: string,
): Promise<ProviderDatabase> {
	const doc = (await parseStringPromise(xml)) as {
		serviceproviders?: XmlNode;
	};
	// Any other document is not this database; treating it as an empty one
	// would make every SIM look "not listed".
	if (doc?.serviceproviders === undefined) {
		throw new Error("not a serviceproviders document");
	}
	const providers: ProviderEntry[] = [];
	for (const country of children(doc.serviceproviders, "country")) {
		for (const provider of children(country, "provider")) {
			const gsm = children(provider, "gsm")[0];
			if (gsm === undefined) continue;
			const networks: string[] = [];
			for (const id of children(gsm, "network-id")) {
				const mcc = id.$?.mcc?.trim();
				const mnc = id.$?.mnc?.trim();
				if (mcc && mnc) networks.push(`${mcc}${mnc}`);
			}
			const apns: ProviderApn[] = [];
			for (const apn of children(gsm, "apn")) {
				// A blank value is kept: NetworkManager picks it like any other and
				// sends it as "the subscription default". It is never written here.
				const value = apn.$?.value?.trim();
				if (value === undefined) continue;
				apns.push({
					apn: value,
					username: text(apn, "username"),
					password: text(apn, "password"),
					usage: children(apn, "usage")
						.map((u) => u.$?.type ?? "")
						.filter((t) => t !== ""),
				});
			}
			providers.push({ name: text(provider, "name"), networks, apns });
		}
	}
	return providers;
}

/**
 * Read one provider database file. `undefined` when it is absent or unreadable:
 * then nothing here may claim to know better than NetworkManager.
 */
export function readProviderDatabase(
	file: string,
): Promise<ProviderDatabase | undefined> {
	return readFile(file, "utf8")
		.then(parseProviderDatabase)
		.catch((err: unknown) => {
			logger.warn(
				`Mobile provider database unavailable at ${file}: ${String(err)}`,
				{ module: "modems" },
			);
			return undefined;
		});
}

let cached: Promise<ProviderDatabase | undefined> | undefined;

/**
 * The installed provider database, read once per process. A failed read is not
 * kept, so a database installed later is picked up at the next new SIM.
 */
export async function loadProviderDatabase(): Promise<
	ProviderDatabase | undefined
> {
	cached ??= readProviderDatabase(providerDatabasePath());
	const db = await cached;
	if (db === undefined) cached = undefined;
	return db;
}

/** Test seam: forget the cached database. */
export function resetProviderDatabaseCache(): void {
	cached = undefined;
}

/** NetworkManager's own pick for `network`: first exact "internet" APN. */
export function networkManagerPick(
	db: ProviderDatabase,
	network: string,
): ProviderApn | undefined {
	for (const provider of db) {
		if (!provider.networks.includes(network)) continue;
		const apn = provider.apns.find((a) => a.usage.includes("internet"));
		if (apn !== undefined) return apn;
	}
	return undefined;
}

/**
 * An IMS APN carries voice signalling, not internet traffic. The database lists
 * some with usage "internet" (Verizon's `vzwims` comes first for 311480), and a
 * network that grants one gives a data path that goes nowhere.
 */
export function isImsApn(apn: string): boolean {
	const value = apn.trim().toLowerCase();
	return value === "vzwims" || /(^|\.)ims(\.|$)/.test(value);
}

function firstApn(
	db: ProviderDatabase,
	network: string,
	usable: (apn: ProviderApn) => boolean,
): ProviderApn | undefined {
	for (const provider of db) {
		if (!provider.networks.includes(network)) continue;
		const apn = provider.apns.find(usable);
		if (apn !== undefined) return apn;
	}
	return undefined;
}

/**
 * The database's data APN for the SIM's own network: NetworkManager's rule
 * minus IMS APNs. Only when no entry is marked exactly "internet" does a
 * combined usage such as "mms-internet-hipri" count; NetworkManager finds
 * nothing for such a network and fails the connection outright.
 */
export function homeNetworkPick(
	db: ProviderDatabase,
	network: string,
): ProviderApn | undefined {
	const writable = (a: ProviderApn) => a.apn !== "" && !isImsApn(a.apn);
	return (
		firstApn(db, network, (a) => a.usage.includes("internet") && writable(a)) ??
		firstApn(
			db,
			network,
			(a) =>
				a.usage.some((u) => u.split("-").includes("internet")) && writable(a),
		)
	);
}

function sameApn(
	a: ProviderApn | undefined,
	b: ProviderApn | ApnHint,
): boolean {
	return (
		a !== undefined &&
		"apn" in b &&
		a.apn === b.apn &&
		a.username === b.username &&
		a.password === b.password
	);
}

function plmn(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && /^\d{5,6}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * What the database says about the SIM's own network, or `undefined` when there
 * is nothing to say (no database or no readable home network). Describes the database, not who set a profile's APN.
 */
export function describeHomeApn(
	db: ProviderDatabase | undefined,
	simHomeNetwork: string | undefined,
): ApnHint | undefined {
	const home = plmn(simHomeNetwork);
	if (db === undefined || home === undefined) return undefined;
	const wanted = homeNetworkPick(db, home);
	if (wanted === undefined) return { source: "not-listed", homeNetwork: home };
	return {
		source: "provider-database",
		homeNetwork: home,
		apn: wanted.apn,
		username: wanted.username,
		password: wanted.password,
	};
}

/**
 * Whether a NEW profile should be written with the home network's APN instead
 * of Automatic APN: only when NetworkManager's automatic choice differs from it.
 *
 * NetworkManager looks up `gsm.network-id` when the profile pins one, otherwise
 * the serving network. `servingNetwork` is optional because a profile can be
 * created before the modem has registered; then NetworkManager is assumed to end
 * up on the home network, which is what it will look up there.
 */
export function shouldWriteHomeApn(
	db: ProviderDatabase | undefined,
	hint: ApnHint | undefined,
	servingNetwork: string | undefined,
	pinnedNetwork?: string,
): boolean {
	if (db === undefined || hint?.source !== "provider-database") return false;
	const automatic = networkManagerPick(
		db,
		plmn(pinnedNetwork) ?? plmn(servingNetwork) ?? hint.homeNetwork,
	);
	return !sameApn(automatic, hint);
}

/**
 * Whether the dialog should say where the APN came from.
 *
 * Derived from the CURRENT values rather than stored as a flag: once the APN is
 * changed it stops matching the hint and the note disappears, and a manual
 * entry that happens to equal the database value is still truthfully described.
 */
export function deriveApnSource(
	hint: ApnHint | undefined,
	config: {
		readonly autoconfig: boolean;
		readonly apn: string;
		readonly username: string;
		readonly password: string;
	},
): ApnSource | undefined {
	if (hint === undefined) return undefined;
	if (hint.source === "not-listed") {
		return config.autoconfig ? "not-listed" : undefined;
	}
	return !config.autoconfig &&
		config.apn === hint.apn &&
		config.username === hint.username &&
		config.password === hint.password
		? "provider-database"
		: undefined;
}
