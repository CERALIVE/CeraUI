import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { logger } from "../../helpers/logger.ts";
import { run, runWithStdin } from "../../helpers/run.ts";
import type { NmProfileReadTrace } from "./network-manager-profile-diagnostics.ts";
import { readNmProfileFileSecret } from "./network-manager-profile-file.ts";
import {
	readNmProfileInstance,
	sameNmProfileResource,
} from "./network-manager-profile-instance.ts";
import { openNmProfileFile } from "./network-manager-profile-write.ts";

/** Secret-display placeholders are unavailable reads, never credentials. */
export function isNmWifiSecretAvailable(
	value: string | undefined,
): value is string {
	return value !== undefined && value !== "" && value !== "<hidden>";
}

/** NM owns encoding/normalization; secret values reach it only on stdin. */
export async function serializeNmProfileModify(
	before: string,
	fields: Readonly<Record<string, string>>,
): Promise<string> {
	const password = fields["802-11-wireless-security.psk"];
	let input = before;
	if (password !== undefined) {
		const escaped = password
			.replaceAll("\\", "\\\\")
			.replaceAll(" ", "\\s")
			.replaceAll("\n", "\\n")
			.replaceAll("\r", "\\r")
			.replaceAll("\t", "\\t");
		input += `\n[wifi-security]\npsk=${escaped}\npsk-flags=0\n`;
	}
	const ordinary = Object.entries(fields).filter(
		([key]) =>
			key !== "802-11-wireless-security.psk" &&
			(password === undefined || key !== "802-11-wireless-security.psk-flags"),
	);
	return runWithStdin(
		"nmcli",
		["--offline", "connection", "modify", ...ordinary.flat()],
		input,
		{ timeout: 10000, maxBuffer: 1024 * 1024 },
	);
}

/** Display values are hints; only a coherent read matching persistent bytes hydrates a credential. */
export async function readVerifiedNmWifiSecret(
	uuid: string,
	settings: Readonly<Record<string, string>>,
): Promise<string | undefined> {
	try {
		const instance = await readNmProfileInstance(uuid, {
			...settings,
			"802-11-wireless.mode": "ap",
			"802-11-wireless-security.psk-flags": "0",
		});
		const password = (await readNmProfileFileSecret(instance?.file))?.password;
		if (password === undefined || password === "") return undefined;
		const held = await openNmProfileFile(instance?.file);
		if (!held) return undefined;
		try {
			const baseline = await serializeNmProfileModify(held.bytes.toString(), {
				"802-11-wireless-security.psk-flags": "0",
			});
			const predicted = await serializeNmProfileModify(held.bytes.toString(), {
				"802-11-wireless-security.psk": password,
			});
			const current = await openNmProfileFile(instance?.file);
			try {
				return current?.bytes.equals(held.bytes) && predicted === baseline
					? password
					: undefined;
			} finally {
				await current?.handle.close();
			}
		} finally {
			await held.handle.close();
		}
	} catch (error: unknown) {
		if (!(error instanceof Error)) throw error;
		return undefined;
	}
}

/** Keep credentials in stdin and mode-0600 keyfiles, never the process table. */
export async function writeNmWifiSecret(
	uuid: string,
	fields: Readonly<Record<string, string>>,
	permit?: () => Promise<boolean>,
): Promise<boolean> {
	const reject = (
		reason:
			| "pre-read-unverified"
			| "pre-read-fields-unreadable"
			| "pre-file-unreadable"
			| "serialization-failed"
			| "pre-write-resource-changed"
			| "file-publish-failed"
			| "load-failed"
			| "post-read-fields-unreadable"
			| "post-read-submitted-mismatch"
			| "post-read-secret-unreadable"
			| "post-read-unverified"
			| "post-read-failed"
			| "post-file-unreadable"
			| "post-run-changed"
			| "post-path-changed",
	): false => {
		logger.warn("NM profile write rejected", { reason });
		return false;
	};
	const beforeTrace: NmProfileReadTrace = {};
	const before = await readNmProfileInstance(uuid, undefined, beforeTrace);
	if (!before)
		return reject(
			beforeTrace.exit === "fields-unreadable"
				? "pre-read-fields-unreadable"
				: "pre-read-unverified",
		);
	if (!before.file) return reject("pre-file-unreadable");
	const filename = before.file.filename;
	const held = await openNmProfileFile(before.file);
	if (!held) return reject("pre-file-unreadable");
	let output: string;
	try {
		output = await serializeNmProfileModify(held.bytes.toString(), fields);
	} catch (error: unknown) {
		if (!(error instanceof Error)) throw error;
		return reject("serialization-failed");
	} finally {
		await held.handle.close();
	}
	const temporary = join(
		dirname(filename),
		`.${basename(filename)}.${crypto.randomUUID()}.tmp`,
	);
	let stage: "file-publish-failed" | "load-failed" | "post-read-failed" =
		"file-publish-failed";
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(output);
			await file.sync();
		} finally {
			await file.close();
		}
		if (permit && !(await permit())) return false;
		if (!sameNmProfileResource(before, await readNmProfileInstance(uuid)))
			return reject("pre-write-resource-changed");
		await rename(temporary, filename);
		stage = "load-failed";
		await run("nmcli", ["connection", "load", filename]);
		stage = "post-read-failed";
		const trace: NmProfileReadTrace = {};
		const after = await readNmProfileInstance(
			uuid,
			{
				...fields,
				"802-11-wireless-security.psk-flags": "0",
			},
			trace,
		);
		if (!after)
			return reject(
				trace.exit === "fields-unreadable"
					? "post-read-fields-unreadable"
					: trace.exit === "submitted-settings-mismatch"
						? "post-read-submitted-mismatch"
						: trace.exit === "persistent-secret-unreadable"
							? "post-read-secret-unreadable"
							: "post-read-unverified",
			);
		if (!after.file) return reject("post-file-unreadable");
		if (after.runId !== before.runId) return reject("post-run-changed");
		if (after.path !== before.path) return reject("post-path-changed");
		return true;
	} catch (error: unknown) {
		if (!(error instanceof Error)) throw error;
		return reject(stage);
	} finally {
		await rm(temporary, { force: true });
	}
}
