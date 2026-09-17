import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
	connect,
	activeEncodeSchema as producerSchema,
	rpcRequestSchema,
	SCHEMA_VERSION,
	type SessionSwitchTarget,
	switchInputParamsSchema,
} from "@ceralive/cerastream";
import { activeEncodeSchema } from "@ceraui/rpc/schemas";
import { extractActiveEncode } from "../modules/streaming/cerastream-backend.ts";

const encode = { codec: "h264", resolution: "1920x1080", framerate: 30 };
const targets: SessionSwitchTarget[] = [
	{ input_id: "hdmi", kind: "capture" },
	{ input_id: "b", kind: "synthetic" },
];

test.each([{ roster: undefined }, { roster: [] }, { roster: targets }])(
	"JSON and every parsed boundary preserve roster presence: %j",
	({ roster }) => {
		// Given: legacy, explicit-empty and populated producer snapshots.
		const wire = {
			...encode,
			...(roster === undefined ? {} : { switch_targets: roster }),
		};
		// When: the actual producer and consumer parsers both cross a JSON boundary.
		const producer = producerSchema.parse(JSON.parse(JSON.stringify(wire)));
		const extracted = extractActiveEncode({ active_encode: producer });
		const result = activeEncodeSchema.parse(
			JSON.parse(JSON.stringify(extracted)),
		);
		// Then: neither the values nor the absent/empty distinction are stripped.
		expect<readonly SessionSwitchTarget[] | undefined>(
			result.switch_targets,
		).toEqual(roster);
		expect(Object.hasOwn(result, "switch_targets")).toBe(roster !== undefined);
	},
);

test("both consumer packages resolve the exact installed registry version inside this checkout", async () => {
	const root = join(import.meta.dir, "../../../..");
	for (const consumer of ["apps/backend", "packages/rpc"]) {
		const entry = await realpath(
			Bun.resolveSync("@ceralive/cerastream", join(root, consumer)),
		);
		const inModules = relative(join(root, "node_modules"), entry);
		expect(inModules.startsWith("..")).toBe(false);
		const manifest = await Bun.file(
			join(dirname(entry), "../package.json"),
		).json();
		expect(manifest.version).toBe("2026.9.8");
	}
	expect(SCHEMA_VERSION).toBe("0.18.0");
});

test("the registry client sends list-switch-targets and switch-input over real NDJSON/UDS", async () => {
	// Given: a hermetic protocol peer, not a linked producer or a hardware engine.
	const dir = await mkdtemp(join(tmpdir(), "u6-wire-"));
	const socketPath = join(dir, "control.sock");
	const methods: string[] = [];
	const server = Bun.listen<{ pending: string }>({
		unix: socketPath,
		socket: {
			open(socket) {
				socket.data = { pending: "" };
			},
			data(socket, bytes) {
				socket.data.pending += bytes.toString();
				const lines = socket.data.pending.split("\n");
				socket.data.pending = lines.pop() ?? "";
				for (const line of lines) {
					const request = rpcRequestSchema.parse(JSON.parse(line));
					methods.push(request.method);
					let result: unknown;
					switch (request.method) {
						case "hello":
							result = {
								protocol: "cerastream-ipc/1",
								schema_version: SCHEMA_VERSION,
								engine_version: "fixture",
							};
							break;
						case "list-switch-targets":
							result = {
								session_id: "fixture-1",
								active_input: "hdmi",
								switch_targets: targets,
							};
							break;
						case "switch-input":
							result = {
								active_input: switchInputParamsSchema.parse(request.params)
									.input_id,
								mode: "manual",
							};
							break;
						default:
							throw new Error(`Unexpected fixture method: ${request.method}`);
					}
					socket.write(
						`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
					);
				}
			},
		},
	});
	try {
		const client = await connect({ socketPath });
		try {
			// When: the published client queries and selects the synthetic leg.
			const roster = await client.listSwitchTargets();
			const switched = await client.switchInput({
				input_id: "b",
				mode: "manual",
			});
			// Then: exact target fields survive the real transport and client parser.
			expect(roster).toEqual({
				session_id: "fixture-1",
				active_input: "hdmi",
				switch_targets: targets,
			});
			expect(switched.active_input).toBe("b");
			expect(methods).toEqual(["hello", "list-switch-targets", "switch-input"]);
		} finally {
			await client.close();
		}
	} finally {
		server.stop(true);
		await rm(dir, { recursive: true, force: true });
	}
});
