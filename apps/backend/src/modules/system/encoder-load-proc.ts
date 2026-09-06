import {
	type EncoderCoreReading,
	type MediaBlockLoad,
	type MediaCoreLoad,
	type MppBlock,
	type MppSessionOwner,
	mppSessionOwnerSchema,
} from "@ceraui/rpc";

type MppLoadRow = Readonly<
	Pick<MediaCoreLoad, "core" | "load" | "utilization">
>;
const DEVICE_NAME = /^([0-9a-f]{1,16})\.([a-z0-9_-]+)$/i;

function parseDriverPercent(raw: string | undefined): number | null {
	if (raw === undefined || !/^\d+(?:\.\d{1,2})?$/.test(raw.trim())) return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

export function parseLoadPercent(raw: string): number | null {
	const value = parseDriverPercent(raw);
	return value !== null && value <= 100 ? value : null;
}

export function parseMppLoadRows(text: string): MppLoadRow[] {
	const rows = new Map<string, MppLoadRow>();
	for (const line of text.split("\n")) {
		const core = line.trim().split(/\s/, 1)[0]?.toLowerCase();
		if (!core || !DEVICE_NAME.test(core) || !/\bload:/.test(line)) continue;
		const duplicate = rows.has(core);
		rows.set(core, {
			core,
			load: duplicate
				? null
				: parseDriverPercent(
						line.match(/\bload:\s*([^%\s]+)\s*%(?=\s|$)/)?.[1],
					),
			utilization: duplicate
				? null
				: parseDriverPercent(
						line.match(/\butilization:\s*([^%\s]+)\s*%(?=\s|$)/)?.[1],
					),
		});
	}
	return [...rows.values()].sort((a, b) => {
		const left = BigInt(`0x${a.core.split(".")[0]}`);
		const right = BigInt(`0x${b.core.split(".")[0]}`);
		return left < right ? -1 : left > right ? 1 : a.core.localeCompare(b.core);
	});
}

export function mppBlockForDevice(
	core: string,
	compatible = "",
): MppBlock | null {
	const name = DEVICE_NAME.exec(core)?.[2];
	if (name === undefined) return null;
	if (/^rkvenc-core\d*$/.test(name)) return "rkvenc";
	if (/^rkvdec[\w-]*$/.test(name)) return "rkvdec";
	if (/^(?:jpegd|jpgdec)(?:-core)?\d*$/.test(name)) return "jpgdec";
	// Generic video-codec names are not decoder evidence; the OF binding is.
	if (compatible.split("\0").includes("rockchip,rkv-decoder-v2"))
		return "rkvdec";
	return null;
}

export function parseMppLoad(text: string): (number | null)[] {
	return parseMppLoadRows(text)
		.filter((row) => mppBlockForDevice(row.core) === "rkvenc")
		.map((row) =>
			row.load === null ? null : parseLoadPercent(String(row.load)),
		);
}

export function parseMppDecodeLoad(text: string): (number | null)[] {
	return parseMppLoadRows(text)
		.filter((row) => mppBlockForDevice(row.core) === "rkvdec")
		.map((row) =>
			row.load === null ? null : parseLoadPercent(String(row.load)),
		);
}

export function legacyCoreReadings(
	percents: readonly (number | null)[],
	prefix: string,
): EncoderCoreReading[] {
	return percents.map((percent, index) =>
		percent === null
			? { core: `${prefix}${index}`, kind: "unavailable" }
			: { core: `${prefix}${index}`, kind: "percent", percent },
	);
}

export function decodeCoreReadings(
	percents: readonly (number | null)[],
): EncoderCoreReading[] {
	return legacyCoreReadings(percents, "rkvdec");
}

/** null withholds the entire ownership snapshot when a stanza is incomplete. */
export function parseMppSessions(
	text: string,
): ReadonlyMap<string, MppSessionOwner[]> | null {
	const owners = new Map<string, MppSessionOwner[]>();
	const seen = new Set<string>();
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim() ?? "";
		if (!line.startsWith("session:")) continue;
		const header = /^session: pid=(\d+) index=(\d+)$/.exec(line);
		const device = /^ device: (\S+)\s*$/
			.exec(lines[i + 1] ?? "")?.[1]
			?.toLowerCase();
		const memory = /^ memory: \d+ MiB\s*$/.test(lines[i + 2] ?? "");
		const owner = mppSessionOwnerSchema.safeParse({
			pid: Number(header?.[1]),
			index: Number(header?.[2]),
		});
		if (!owner.success || !device || !DEVICE_NAME.test(device) || !memory)
			return null;
		const key = `${owner.data.pid}:${owner.data.index}`;
		if (seen.has(key)) return null;
		seen.add(key);
		const current = owners.get(device) ?? [];
		current.push(owner.data);
		owners.set(device, current);
	}
	if (text.trim() && seen.size === 0) return null;
	return owners;
}

type RgaCoreLoad = Extract<
	MediaBlockLoad,
	{ source: "rkrga" }
>["cores"][number];

export function parseRgaLoad(text: string): RgaCoreLoad[] {
	const header = /^num of scheduler = (\d+)$/m.exec(text);
	if (!header) return [];
	const expected = Number(header[1]);
	const rows = new Map<number, RgaCoreLoad>();
	const lines = text.split("\n<session>", 1)[0]?.split("\n") ?? [];
	for (let i = 0; i < lines.length; i++) {
		const scheduler = /^scheduler\[(\d+)\]: ([a-z0-9_-]+)\s*$/i.exec(
			lines[i] ?? "",
		);
		if (!scheduler) continue;
		const index = Number(scheduler[1]);
		if (!Number.isSafeInteger(index) || rows.has(index)) return [];
		const load = /^\s+load = ([^%\s]+)%\s*$/.exec(lines[i + 1] ?? "")?.[1];
		rows.set(index, {
			core: `scheduler[${index}]: ${scheduler[2]}`,
			load: load === undefined ? null : parseLoadPercent(load),
			utilization: null,
			sessions: null,
		});
	}
	const ordered = [...rows.entries()].sort(([a], [b]) => a - b);
	if (
		rows.size !== expected ||
		ordered.some(([index], position) => index !== position)
	)
		return [];
	return ordered.map(([, row]) => row);
}
