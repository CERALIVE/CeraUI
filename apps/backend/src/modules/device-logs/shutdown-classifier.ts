import type { DeviceEvent, LogBootInfo } from "@ceraui/rpc/schemas";
import type { RawJournalRecord } from "./parse.ts";

export function classifyBoot(input: {
	readonly isCurrent: boolean;
	/** Newest first, in journal traversal order, never sorted by timestamps. */
	readonly tail: readonly RawJournalRecord[];
	readonly nextBootHead: readonly RawJournalRecord[];
	readonly storeEvents: readonly DeviceEvent[];
}): Pick<LogBootInfo, "shutdown" | "evidence"> {
	if (input.isCurrent) return { shutdown: "current", evidence: [] };
	if (
		input.tail.some(
			(record) =>
				record.pid === 1 &&
				[
					"shutdown.target",
					"reboot.target",
					"poweroff.target",
					"final.target",
				].includes(record.unitField ?? ""),
		)
	)
		return { shutdown: "clean", evidence: ["shutdown_target"] };
	const lifecycle = input.tail.find(
		(record) =>
			record.messageId === "d93fb3c9c24d451a97cea615ce59c00b" ||
			record.messageId === "f77379a8490b408bbe5f6940505a777b",
	);
	if (lifecycle?.messageId === "d93fb3c9c24d451a97cea615ce59c00b")
		return { shutdown: "clean", evidence: ["journal_stopped"] };
	if (
		input.nextBootHead.some(
			(record) =>
				record.unit === "systemd-journald" &&
				(record.message.includes("uncleanly shut down") ||
					record.message.includes("corrupted")),
		)
	)
		return { shutdown: "unclean", evidence: ["next_boot_unclean_journal"] };
	if (input.tail.length >= 20)
		return {
			shutdown: "unclean",
			evidence: [
				"no_shutdown_markers",
				...(input.storeEvents.some(
					(event) => event.code === "shutdown_requested",
				)
					? ["shutdown_requested_event"]
					: []),
			],
		};
	return {
		shutdown: "unknown",
		evidence: [input.tail.length === 0 ? "no_entries" : "too_few_entries"],
	};
}
