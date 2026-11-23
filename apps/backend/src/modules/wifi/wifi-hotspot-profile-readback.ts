import type { NmProfileReadTrace } from "../network/network-manager-profile-diagnostics.ts";
import {
	type NmProfileInstance,
	sameNmProfileResource,
} from "../network/network-manager-profile-instance.ts";
import {
	openNmProfileFile,
	readNmProfileFd,
} from "../network/network-manager-profile-write.ts";
import type { HotspotProfileOperation } from "./wifi-hotspot-profile-operation.ts";

type ProfileWriteWitness = {
	readonly kind: HotspotProfileOperation["kind"];
	readonly before: NmProfileInstance | null | undefined;
	readonly held: Awaited<ReturnType<typeof openNmProfileFile>>;
	readonly predicted: Buffer | undefined;
	readonly acknowledged: boolean;
	readonly fields: Readonly<Record<string, string>>;
};

type ProfileReadback = {
	readonly checked: boolean;
	readonly instance: NmProfileInstance | null | undefined;
	readonly exit: string | undefined;
};

/** Remove only one canonical timestamp from one connection group; all other bytes survive. */
function withoutActivationTimestamp(
	bytes: Buffer,
):
	| { readonly bytes: Buffer; readonly timestamp: string | undefined }
	| undefined {
	const text = bytes.toString();
	if (!Buffer.from(text).equals(bytes)) return undefined;
	let connectionGroups = 0;
	let group: string | undefined;
	let timestamp: string | undefined;
	let offset = 0;
	let start = 0;
	let end = 0;
	for (const line of text.split("\n")) {
		const header = /^\[([^\]]+)\]$/.exec(line);
		if (header) {
			group = header[1];
			if (group === "connection" && ++connectionGroups > 1) return undefined;
		}
		if (group === "connection" && line.startsWith("timestamp=")) {
			if (timestamp !== undefined) return undefined;
			timestamp = line.slice("timestamp=".length);
			if (
				!/^(?:0|[1-9]\d{0,19})$/.test(timestamp) ||
				BigInt(timestamp) > 18446744073709551615n
			)
				return undefined;
			start = offset;
			end = Math.min(text.length, offset + line.length + 1);
		}
		offset += line.length + 1;
	}
	return {
		bytes: Buffer.from(text.slice(0, start) + text.slice(end)),
		timestamp,
	};
}

/** Read-only comparison; dispatch, retirement and record updates belong to the operation owner. */
export async function classifyHotspotProfileReadback(
	witness: ProfileWriteWitness,
	after: NmProfileInstance | null | undefined,
	trace: NmProfileReadTrace,
): Promise<ProfileReadback> {
	const { kind, before, held, predicted, acknowledged, fields } = witness;
	const unchangedBytes = async (): Promise<ProfileReadback> => {
		if (!held || !sameNmProfileResource(before, after))
			return {
				checked: false,
				instance: before,
				exit: `${kind}-settings-or-file-changed`,
			};
		const current = await openNmProfileFile(after?.file, trace);
		try {
			const checked = Boolean(current?.bytes.equals(held.bytes));
			return {
				checked,
				instance: before,
				exit: checked
					? undefined
					: current
						? `${kind}-bytes-changed`
						: `${kind}-file-unreadable`,
			};
		} finally {
			await current?.handle.close();
		}
	};
	switch (kind) {
		case "add":
			return {
				checked: before === null && Boolean(after?.file),
				instance: after,
				exit: undefined,
			};
		case "modify": {
			// shortcut: byte-identical writes after NM's rename and whole-file replacement before its rename remain indistinguishable.
			if (!before?.runId || !after?.file || !held || !predicted)
				return {
					checked: false,
					instance: after,
					exit: acknowledged
						? "modify-success-readback-unverified"
						: "modify-failure-readback-unverified",
				};
			const original = await readNmProfileFd(held.handle);
			const current = await openNmProfileFile(after.file, trace);
			try {
				if (!acknowledged) {
					const unchanged = Boolean(
						sameNmProfileResource(before, after) &&
							original?.equals(held.bytes) &&
							current?.bytes.equals(held.bytes),
					);
					return {
						checked: unchanged,
						instance: unchanged ? before : undefined,
						exit: unchanged ? undefined : "modify-failure-changed",
					};
				}
				if (
					before.runId !== after.runId ||
					before.path !== after.path ||
					before.file?.filename !== after.file.filename
				)
					return {
						checked: false,
						instance: after,
						exit: "modify-success-continuity-lost",
					};
				let matches = Boolean(current?.bytes.equals(predicted));
				if (
					!matches &&
					current &&
					trace.activationTimestamp !== undefined &&
					fields["connection.timestamp"] === undefined
				) {
					const expected = withoutActivationTimestamp(predicted);
					const observed = withoutActivationTimestamp(current.bytes);
					matches = Boolean(
						expected &&
							observed?.timestamp !== undefined &&
							observed.timestamp === trace.activationTimestamp &&
							observed.bytes.equals(expected.bytes),
					);
				}
				const checked = Boolean(original?.equals(held.bytes) && matches);
				return {
					checked,
					instance: after,
					exit: checked
						? undefined
						: !original
							? "modify-held-fd-unreadable"
							: !original.equals(held.bytes)
								? "modify-prewrite-inode-edited"
								: !current
									? "modify-postwrite-file-unreadable"
									: "modify-prediction-mismatch",
				};
			} finally {
				await current?.handle.close();
			}
		}
		case "up":
		case "down":
			return unchangedBytes();
		case "delete":
			return after === null
				? { checked: true, instance: null, exit: undefined }
				: unchangedBytes();
		default:
			throw new TypeError(
				`Unexpected NM profile operation: ${kind satisfies never}`,
			);
	}
}
