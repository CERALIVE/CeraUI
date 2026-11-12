/// <reference types="bun" />
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { wifiInterfaceSchema } from "@ceraui/rpc/schemas";
import { z } from "zod";

export type TokenRow = {
	readonly ifname: string;
	readonly hasToken: boolean;
	readonly degraded_reason: string | null;
	readonly supports_hotspot: boolean;
};
export type TokenPoll = {
	readonly atS: number;
	readonly rows: readonly TokenRow[];
	readonly error?: string;
};

export function evaluateLiveness(
	polls: readonly TokenPoll[],
	earlyClientTokenS: number | null,
) {
	const late = polls.filter((poll) => poll.atS >= 30);
	const eligible = (row: TokenRow) => row.supports_hotspot && !row.degraded_reason;
	const tokenAbsentPolls = late.filter((poll) =>
		poll.rows.some((row) => eligible(row) && !row.hasToken),
	).length;
	const noEligibleRowPolls = late.filter((poll) => !poll.rows.some(eligible)).length;
	return {
		pass:
			late.length > 0 &&
			tokenAbsentPolls === 0 &&
			noEligibleRowPolls === 0 &&
			earlyClientTokenS !== null &&
			late.every((poll) => !poll.error && poll.rows.length > 0),
		tokenFirstSeenS:
			polls.find((poll) => poll.rows.some((row) => row.hasToken))?.atS ?? null,
		tokenAbsentPolls,
		noEligibleRowPolls,
	};
}

class ProbeError extends Error {
	constructor(message: string, readonly loginAccepted = false) {
		super(message);
	}
}

export function serializeEvidence(
	evidence: unknown,
	secrets: readonly string[],
): string {
	// Only string values are redacted: keys, numbers and booleans stay valid JSON.
	const redact = (value: unknown): unknown => {
		if (typeof value === "string")
			return secrets.reduce(
				(text, secret) => text.replaceAll(secret, "<redacted>"),
				value,
			);
		if (Array.isArray(value)) return value.map(redact);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, redact(item)]),
			);
		return value;
	};
	return `${JSON.stringify(redact(evidence), null, 2)}\n`;
}

export async function publishEvidence(
	out: string,
	temporary: string,
	json: string,
	signal: AbortSignal,
): Promise<void> {
	await mkdir(dirname(out), { recursive: true });
	signal.throwIfAborted();
	try {
		await rm(temporary, { force: true });
	} catch (error) {
		if (error instanceof Error)
			throw new ProbeError("cannot remove stale temporary result file");
		throw error;
	}
	// Bun.write ignores the mode for string writes; an exclusive create never reuses a broader file.
	try {
		await writeFile(temporary, json, { mode: 0o600, flag: "wx" });
	} catch (error) {
		if (error instanceof Error)
			throw new ProbeError("cannot create temporary result file");
		throw error;
	}
	signal.throwIfAborted();
	await rename(temporary, out);
}

export function parsePassFile(text: string): string {
	// sshpass -f keeps trailing spaces, so only the terminal line ending is dropped.
	const pass = text.replace(/\r?\n$/, "");
	if (!pass || /[\r\n]/.test(pass)) throw new ProbeError("invalid SSH pass file");
	return pass;
}
const cycleKind = z.enum(["cold", "restart", "nm-restart"]);
type CycleKind = z.infer<typeof cycleKind>;
const rowSchema = wifiInterfaceSchema
	.pick({
		ifname: true,
		incarnation: true,
		degraded_reason: true,
		supports_hotspot: true,
	})
	.extend({ ifname: z.string().regex(/^[a-zA-Z0-9_.:-]{1,32}$/) });
const statusSchema = z.object({
	wifi: z.record(z.string(), rowSchema).optional(),
	is_streaming: z.boolean().optional(),
});
const credsSchema = z.object({
	BOARD_IP: z.ipv4(),
	BOARD_SSH_USER: z.string().regex(/^[a-z_][a-z0-9_-]*[$]?$/i),
	BOARD_SSH_PASS_FILE: z.string().min(1),
	UI_PASS: z.string().min(1),
});
type Credentials = z.infer<typeof credsSchema>;

function parseArgs(args: readonly string[]) {
	const flags = new Map<string, string>();
	for (let i = 0; i < args.length; i += 2) {
		const flag = args[i];
		const value = args[i + 1];
		if (
			!flag ||
			!["--creds", "--cycles", "--window", "--out"].includes(flag) ||
			value === undefined ||
			value.startsWith("--") ||
			flags.has(flag)
		)
			throw new ProbeError("invalid arguments; use --help");
		flags.set(flag, value);
	}
	const cycles: CycleKind[] = [];
	for (const part of (flags.get("--cycles") ?? "").split(",")) {
		const match = /^(cold|restart|nm-restart):([1-9]\d*)$/.exec(part);
		const kind = cycleKind.safeParse(match?.[1]);
		const count = Number(match?.[2]);
		if (!kind.success || !Number.isSafeInteger(count) || count > 100)
			throw new ProbeError("invalid --cycles");
		for (let i = 0; i < count; i++) cycles.push(kind.data);
	}
	const windowText = flags.get("--window") ?? "";
	const windowS = Number(windowText);
	if (!/^\d+$/.test(windowText) || !Number.isSafeInteger(windowS) || windowS < 30)
		throw new ProbeError("invalid --window; expected integer seconds >= 30");
	const creds = flags.get("--creds");
	const out = flags.get("--out");
	if (!creds || !out) throw new ProbeError("--creds and --out are required");
	return { creds, cycles, windowS, out };
}

async function readCredentials(path: string) {
	let text: string;
	try {
		text = await Bun.file(path).text();
	} catch (error) {
		if (error instanceof Error) throw new ProbeError("cannot read credential file");
		throw error;
	}
	const entries = text.split(/\r?\n/).flatMap((line) => {
		const match = /^(?:export\s+)?([A-Z_]+)=(.*)$/.exec(line.trim());
		if (!match?.[1] || match[2] === undefined) return [];
		const value = match[2];
		return [
			[
				match[1],
				/^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value,
			],
		];
	});
	const parsed = credsSchema.safeParse(Object.fromEntries(entries));
	if (!parsed.success) throw new ProbeError("invalid credential file");
	const credentials = {
		...parsed.data,
		BOARD_SSH_PASS_FILE: resolve(dirname(path), parsed.data.BOARD_SSH_PASS_FILE),
	};
	let passText: string;
	try {
		passText = await Bun.file(credentials.BOARD_SSH_PASS_FILE).text();
	} catch (error) {
		if (error instanceof Error) throw new ProbeError("cannot read SSH pass file");
		throw error;
	}
	return { ...credentials, sudoPass: parsePassFile(passText) };
}

async function ssh(
	creds: Credentials,
	script: string,
	signal: AbortSignal,
) {
	const child = Bun.spawn(
		[
			"sshpass", "-f", creds.BOARD_SSH_PASS_FILE, "ssh",
			"-o", "PreferredAuthentications=password",
			"-o", "PubkeyAuthentication=no",
			"-o", "ConnectTimeout=10",
			"-o", "ConnectionAttempts=1",
			"-o", "ServerAliveInterval=5",
			"-o", "ServerAliveCountMax=2",
			`${creds.BOARD_SSH_USER}@${creds.BOARD_IP}`, "bash", "-s",
		],
		{
			env: process.env,
			stdin: new TextEncoder().encode(script),
			stdout: "pipe",
			stderr: "ignore",
			timeout: 20_000,
			killSignal: "SIGKILL",
			signal,
		},
	);
	const [code, text] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
	]);
	return { code, text: text.trim() };
}

async function readBoard(creds: Credentials, script: string, signal: AbortSignal) {
	const result = await ssh(creds, script, signal);
	if (result.code !== 0) throw new ProbeError("ssh-read-failed");
	return result.text;
}

async function connect(
	creds: Credentials,
	signal: AbortSignal,
	onRows: (rows: readonly TokenRow[], acceptedAt: number) => void = () => {},
	timeoutMs = 15_000,
) {
	const socket = new WebSocket(`ws://${creds.BOARD_IP}/ws`);
	let acceptedAt: number | null = null;
	let alive = true;
	let lastFrame = performance.now();
	let hydrated = false;
	const ready = Promise.withResolvers<{
		rows: readonly TokenRow[];
		isStreaming: boolean;
		acceptedAt: number;
	}>();
	const close = () => {
		alive = false;
		clearTimeout(timeout);
		clearInterval(heartbeat);
		signal.removeEventListener("abort", abort);
		socket.close();
	};
	const fail = (code: string) => {
		ready.reject(new ProbeError(code, acceptedAt !== null));
		close();
	};
	const abort = () => fail("interrupted");
	const timeout = setTimeout(() => fail("socket-timeout"), timeoutMs);
	const heartbeat = setInterval(() => {
		if (performance.now() - lastFrame >= 30_000) fail("socket-stalled");
		else if (socket.readyState === WebSocket.OPEN)
			socket.send(JSON.stringify({ keepalive: null }));
	}, 10_000);
	signal.addEventListener("abort", abort, { once: true });
	socket.onopen = () => {
		if (signal.aborted) return abort();
		socket.send(
			JSON.stringify({
				id: "l1",
				path: ["auth", "login"],
				input: { password: creds.UI_PASS },
			}),
		);
	};
	socket.onclose = () => fail("socket-closed");
	socket.onerror = () => fail("socket-error");
	socket.onmessage = (event) => {
		lastFrame = performance.now();
		try {
			const frame: unknown = JSON.parse(String(event.data));
			const envelope = z
				.object({ id: z.string().optional(), status: z.unknown().optional(),
					ping: z.unknown().optional(), result: z.unknown().optional(),
					error: z.unknown().optional() })
				.parse(frame);
			if (envelope.ping !== undefined)
				socket.send(JSON.stringify({ pong: true }));
			if (envelope.id === "l1") {
				const login = z.object({ success: z.boolean() }).safeParse(envelope.result);
				if (!login.success || !login.data.success) return fail("login-refused");
				acceptedAt = performance.now();
			}
			if (envelope.status === undefined || acceptedAt === null) return;
			const status = statusSchema.parse(envelope.status);
			if (!status.wifi) return;
			const rows = Object.values(status.wifi).map((row) => ({
				ifname: row.ifname,
				hasToken: Boolean(row.incarnation),
				degraded_reason: row.degraded_reason ?? null,
				supports_hotspot: row.supports_hotspot === true,
			}));
			onRows(rows, acceptedAt);
			if (!hydrated && status.is_streaming !== undefined) {
				hydrated = true;
				clearTimeout(timeout);
				ready.resolve({ rows, isStreaming: status.is_streaming, acceptedAt });
			}
		} catch (error) {
			if (error instanceof Error) fail("invalid-status-frame");
			else throw error;
		}
	};
	if (signal.aborted) abort();
	try {
		return { ...(await ready.promise), close, isAlive: () => alive };
	} catch (error) {
		close();
		throw error;
	}
}

const bootScript = "cat /proc/sys/kernel/random/boot_id\n";
const versionScript = "dpkg-query -W ceralive-device\n";
const addressSchema = z.array(
	z.object({
		ifname: z.string(),
		addr_info: z.array(z.object({ local: z.string() })),
	}),
);

async function cycle(
	kind: CycleKind,
	creds: Awaited<ReturnType<typeof readCredentials>>,
	windowS: number,
	signal: AbortSignal,
) {
	const polls: TokenPoll[] = [];
	let bootIdChanged = false;
	let earlyClientTokenS: number | null = null;
	let early: Awaited<ReturnType<typeof connect>> | undefined;
	try {
		const check = await connect(creds, signal);
		check.close();
		if (check.isStreaming) throw new ProbeError("precondition-streaming");
		const devices = await readBoard(creds, "nmcli -t -f DEVICE,STATE device\n", signal);
		const addresses = addressSchema.parse(
			JSON.parse(await readBoard(creds, "ip -j address\n", signal)),
		);
		const holdsAddress = (ifname: string) =>
			addresses.some((row) => row.ifname === ifname &&
				row.addr_info.some((address) => address.local === creds.BOARD_IP));
		if (!devices.split("\n").includes("eth0:connected") ||
			!holdsAddress("eth0") || holdsAddress("wlan0"))
			throw new ProbeError("precondition-ethernet-address");
		const bootId = z.uuid().parse(await readBoard(creds, bootScript, signal));
		const action = {
			cold: "reboot",
			restart: "restart ceralive",
			"nm-restart": "restart NetworkManager",
		}[kind];
		const delimiter = `CERA_${crypto.randomUUID().replaceAll("-", "")}`;
		const result = await ssh(creds,
			`sudo -S -p '' systemctl ${action} <<'${delimiter}'\n${creds.sudoPass}\n${delimiter}\n`,
			signal);
		if (result.code !== 0 && !(kind === "cold" && result.code === 255))
			throw new ProbeError("cycle-action-failed");
		const deadline = performance.now() + 300_000;
		while (!early && performance.now() < deadline) {
			signal.throwIfAborted();
			try {
				const recoverySignal = AbortSignal.any([
					signal,
					AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))),
				]);
				const current = z.uuid().parse(await readBoard(creds, bootScript, recoverySignal));
				bootIdChanged = current !== bootId;
				if (kind === "cold" && !bootIdChanged) {
					await delay(1000, undefined, { signal });
					continue;
				}
				early = await connect(creds, signal, (rows, acceptedAt) => {
					if (earlyClientTokenS === null && rows.some((row) => row.hasToken))
						earlyClientTokenS = (performance.now() - acceptedAt) / 1000;
				}, Math.max(1, Math.min(15_000, deadline - performance.now())));
			} catch (error) {
				if (performance.now() >= deadline) throw new ProbeError("login-deadline");
				if (!(error instanceof ProbeError)) throw error;
				if (error.loginAccepted) throw error;
				await delay(1000, undefined, { signal });
			}
		}
		if (!early) throw new ProbeError("login-deadline");
		for (let tick = 0; tick <= windowS; tick += 5) {
			const wait = early.acceptedAt + tick * 1000 - performance.now();
			if (wait > 0) await delay(wait, undefined, { signal });
			signal.throwIfAborted();
			try {
				const fresh = await connect(creds, signal);
				polls.push({ atS: (performance.now() - early.acceptedAt) / 1000, rows: fresh.rows });
				fresh.close();
			} catch (error) {
				if (!(error instanceof ProbeError)) throw error;
				polls.push({ atS: (performance.now() - early.acceptedAt) / 1000, rows: [], error: error.message });
			}
		}
		const verdict = evaluateLiveness(polls, earlyClientTokenS);
		return { kind, bootId, bootIdChanged, polls, earlyClientTokenS,
			earlyClientStayedConnected: early.isAlive(), ...verdict,
			pass: verdict.pass && early.isAlive() };
	} catch (error) {
		signal.throwIfAborted();
		if (!(error instanceof ProbeError || error instanceof z.ZodError)) throw error;
		return { kind, bootIdChanged, polls, earlyClientTokenS,
			...evaluateLiveness(polls, earlyClientTokenS), pass: false,
			error: error instanceof ProbeError ? error.message : "invalid-board-data" };
	} finally {
		early?.close();
	}
}

async function main() {
	if (Bun.argv.slice(2).length === 1 && Bun.argv[2] === "--help") {
		console.log(
			"Usage: bun token-liveness.ts --creds <env file> --cycles cold:<n>,restart:<n>,nm-restart:<n> --window <seconds> --out <json file>",
		);
		return;
	}
	const options = parseArgs(Bun.argv.slice(2));
	const creds = await readCredentials(options.creds);
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	const temporary = `${options.out}.${process.pid}.tmp`;
	try {
		const before = await readBoard(creds, versionScript, controller.signal);
		const reg = await readBoard(creds, "/usr/sbin/iw reg get\n", controller.signal);
		const cycles = [];
		for (const [index, kind] of options.cycles.entries()) {
			console.log(`cycle ${index + 1}/${options.cycles.length} ${kind}: started`);
			const result = await cycle(kind, creds, options.windowS, controller.signal);
			cycles.push(result);
			console.log(`cycle ${index + 1}/${options.cycles.length} ${kind}: pass=${result.pass}, absent=${result.tokenAbsentPolls}`);
		}
		const after = await readBoard(creds, versionScript, controller.signal);
		const evidence = {
			recordedAt: new Date().toISOString(), windowS: options.windowS,
			packageBefore: before, packageAfter: after, iwReg: reg, cycles,
			pass: before === after && cycles.every((entry) => entry.pass),
		};
		const json = serializeEvidence(evidence, [
			creds.UI_PASS,
			creds.sudoPass,
			creds.BOARD_IP,
		]);
		await publishEvidence(options.out, temporary, json, controller.signal);
		process.exitCode = evidence.pass ? 0 : 1;
	} finally {
		controller.abort();
		await rm(temporary, { force: true });
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(`token-liveness: ${error instanceof ProbeError ? error.message : "probe aborted or failed"}`);
		process.exitCode = 2;
	}
}
