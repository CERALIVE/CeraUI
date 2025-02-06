/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2022 BELABOX project

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
  mmcli helpers
*/
import { execFileP } from "../helpers/exec.ts";

import { logger } from "../helpers/logger.ts";
import type { ModemInfo, NetworkType, SimInfo } from "./modems.ts";
import { setup } from "./setup.ts";

type NetworkTypeWithLabel = NetworkType & {
	label: string;
};

const mmcliBinary = setup.mmcli_binary ?? "mmcli";

const mmcliKeyPattern = /\.length$/;
const mmcliValuePattern = /\.value\[\d+]$/;

function mmcliParseSep(input: string) {
	const output: Record<string, Array<string>> = {};
	for (let line of input.split("\n")) {
		line = line.replace(/\\\d+/g, ""); // strips special escaped characters
		if (!line) continue;

		const kv = line.split(/:(.*)/); // splits on the first ':' only
		if (kv.length !== 3) {
			logger.error(`mmcliParseSep: error parsing line ${line}`);
			continue;
		}
		let key = kv[0]?.trim();
		const value = kv[1]?.trim();
		if (key === undefined || value === undefined) continue;

		// skip empty values
		if (value === "--") continue;

		// Parse mmcli arrays
		if (key.match(mmcliKeyPattern)) {
			key = key.replace(mmcliKeyPattern, "");
			output[key] = [];
		}

		if (key.match(mmcliValuePattern)) {
			key = key.replace(mmcliValuePattern, "");
			output[key]?.push(value);
		}
	}

	return output;
}

export function mmConvertNetworkType(mmType: string): NetworkTypeWithLabel {
	const typeMatch = mmType.match(/^allowed: (.+); preferred: (.+)$/) as
		| [string, string, string]
		| null;
	if (typeMatch === null)
		throw new Error(`mmConvertNetworkType: invalid type ${mmType}`);

	const label = typeMatch[1].split(/,? /).sort().reverse().join("");
	const allowed = typeMatch[1].replace(/,? /g, "|");
	const preferred = typeMatch[2];
	return { label, allowed, preferred };
}

export function mmConvertNetworkTypes(mmTypes: Array<string>) {
	const types: Record<string, NetworkType> = {};
	for (const mmType of mmTypes) {
		const type = mmConvertNetworkType(mmType);
		const data = types[type.label];
		if (!data || data.preferred === "none" || data.preferred < type.preferred) {
			types[type.label] = { allowed: type.allowed, preferred: type.preferred };
		}
	}
	return types;
}

const accessTechToGen = {
	gsm: "2G",
	umts: "3G",
	hsdpa: "3G+",
	hsupa: "3G+",
	lte: "4G",
	"5gnr": "5G",
} as const;

const isAccessTech = (tech: string): tech is keyof typeof accessTechToGen =>
	tech in accessTechToGen;

export function mmConvertAccessTech(accessTechs?: Array<string>): string {
	if (!accessTechs || accessTechs.length === 0) {
		return "";
	}

	// Return the highest gen for situations such as 5G NSA, which will report "lte, 5gnr"
	let gen = "";
	for (const t of accessTechs) {
		if (!isAccessTech(t)) {
			logger.warn(`mmConvertAccessTech: unknown access tech ${t}`);
			continue;
		}

		const tech = accessTechToGen[t];
		if (tech > gen) {
			gen = tech;
		}
	}

	// If we only encountered unknown access techs, simply return the first one
	if (!gen) return accessTechs[0] ?? "";
	return gen;
}

export async function mmList() {
	try {
		const result = await execFileP(mmcliBinary, ["-K", "-L"]);
		const modems = mmcliParseSep(result.stdout.toString())["modem-list"] ?? [];

		const list = [];
		for (const m of modems) {
			const id = m.match(/\/org\/freedesktop\/ModemManager1\/Modem\/(\d+)/) as
				| [string, string]
				| null;
			if (id) {
				list.push(Number.parseInt(id[1], 10));
			}
		}
		return list;
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`mmList err: ${err.message}`);
		}
	}
}

export async function mmGetModem(id: number) {
	try {
		const result = await execFileP(mmcliBinary, ["-K", "-m", String(id)]);
		return mmcliParseSep(result.stdout.toString()) as unknown as ModemInfo;
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`mmGetModem err: ${err.message}`);
		}
	}
}

export async function mmGetSim(id: number) {
	try {
		const result = await execFileP(mmcliBinary, ["-K", "-i", String(id)]);
		return mmcliParseSep(result.stdout.toString()) as unknown as SimInfo;
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`mmGetSim err: ${err.message}`);
		}
	}
}

export async function mmSetNetworkTypes(
	id: number,
	allowed: string,
	preferred: string,
) {
	try {
		const args = ["-m", String(id), `--set-allowed-modes=${allowed}`];
		if (preferred !== "none") {
			args.push(`--set-preferred-mode=${preferred}`);
		}
		const result = await execFileP(mmcliBinary, args);
		return result.stdout.match(/successfully set current modes in the modem/);
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`mmSetNetworkTypes err: ${err.message}`);
		}
	}
}

export type NetworkScanResult = {
	"operator-code": string;
	"operator-name": string;
	availability?: "unavailable" | "available" | "current" | "unknown";
};

export async function mmNetworkScan(id: number, timeout = 240) {
	try {
		const result = await execFileP(mmcliBinary, [
			`--timeout=${timeout}`,
			"-K",
			"-m",
			String(id),
			"--3gpp-scan",
		]);
		const networks =
			mmcliParseSep(result.stdout.toString())["modem.3gpp.scan-networks"] ?? [];
		return networks.map((n) => {
			const info = n.split(/, */);
			const output: Record<string, string> = {};
			for (const entry of info) {
				const kv = entry.split(/: */) as [string, string];
				output[kv[0]] = kv[1];
			}
			return output as NetworkScanResult;
		});
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`mmNetworkScan err: ${err.message}`);
		}
	}
}
