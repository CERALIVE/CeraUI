import { join } from "node:path";
import type { SpawnWithTimeoutResult } from "../../helpers/spawn-policy.ts";

// Fixture headers document identity substitutions; payload whitespace is retained.

export async function realDeviceSection(
	board:
		| "rock"
		| "opi"
		| "rock-guardian"
		| "rock-guardian2"
		| "rock-readonly"
		| "rock-nmcli",
	section: string,
): Promise<string> {
	const capture = await Bun.file(
		join(import.meta.dir, `../fixtures/real-device/${board}-systemd257.txt`),
	).text();
	const start = `##### ${section}\n`;
	const payload = capture.split(start)[1];
	if (payload === undefined)
		throw new Error(`Missing capture section ${section}`);
	return payload.split("\n##### ")[0]?.replace(/\n\n$/, "\n") ?? "";
}

export async function realDeviceReply(
	board: "rock-guardian" | "rock-guardian2" | "rock-readonly" | "rock-nmcli",
	section: string,
): Promise<SpawnWithTimeoutResult> {
	return {
		stdout: await realDeviceSection(board, section),
		stderr: await realDeviceSection(board, `${section}-stderr`),
		exitCode: Number(await realDeviceSection(board, `${section}-exit`)),
	};
}
