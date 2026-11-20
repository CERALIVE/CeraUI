import { stat } from "node:fs/promises";
import { nmConnsGet, nmcliParseSep } from "./network-manager.ts";
import type { NmProfileReadTrace } from "./network-manager-profile-diagnostics.ts";
import type { NmProfileInstance } from "./network-manager-profile-instance.ts";
import {
	nmProfileStat,
	openNmProfileFile,
} from "./network-manager-profile-write.ts";

/** Secret authority comes from the guarded keyfile, never nmcli display visibility. */
export async function readNmProfileFileSecret(
	file: NmProfileInstance["file"],
	trace?: NmProfileReadTrace,
): Promise<{ readonly password: string | undefined } | undefined> {
	const held = await openNmProfileFile(file, trace);
	if (!held) return undefined;
	try {
		let security = false;
		let password: string | undefined;
		const text = new TextDecoder("utf-8", { fatal: true }).decode(held.bytes);
		for (const raw of text.split("\n")) {
			const line = raw.replace(/\r$/, "").trimStart();
			const group = /^\[([^\]]+)\]\s*$/.exec(line);
			if (group) {
				security =
					group[1] === "wifi-security" ||
					group[1] === "802-11-wireless-security";
				continue;
			}
			if (!security) continue;
			const value = /^psk\s*=\s*(.*)$/.exec(line)?.[1];
			if (value === undefined) continue;
			password = value.replace(/\\([\s\S]?)/g, (_, escaped: string) => {
				switch (escaped) {
					case "s":
						return " ";
					case "n":
						return "\n";
					case "r":
						return "\r";
					case "t":
						return "\t";
					case "\\":
						return "\\";
					default:
						throw new Error("Invalid persistent secret encoding");
				}
			});
		}
		return { password };
	} catch (error: unknown) {
		if (!(error instanceof Error)) throw error;
		if (trace) trace.fileReason = "secret-unreadable";
		return undefined;
	} finally {
		await held.handle.close();
	}
}

export async function observeNmProfileFile(
	uuid: string,
	trace: NmProfileReadTrace,
	slot: "firstStat" | "secondStat",
): Promise<NmProfileInstance["file"]> {
	trace[slot] = null;
	const rows = await nmConnsGet("uuid,filename");
	const row = rows
		?.filter(Boolean)
		.map(nmcliParseSep)
		.find(([id]) => id === uuid);
	const filename = row?.length === 2 ? row[1] : undefined;
	if (!filename?.startsWith("/")) {
		trace.fileReason = "filename-unreadable";
		return undefined;
	}
	try {
		const info = await stat(filename, { bigint: true });
		trace[slot] = nmProfileStat(info);
		if (!info.isFile()) {
			trace.fileReason = "not-regular";
			return undefined;
		}
		return {
			filename,
			device: String(info.dev),
			inode: String(info.ino),
			ctime: String(info.ctimeNs),
		};
	} catch (error: unknown) {
		if (error instanceof Error) {
			trace.fileReason =
				"code" in error && error.code === "ENOENT"
					? "vanished"
					: "stat-unreadable";
			return undefined;
		}
		throw error;
	}
}
