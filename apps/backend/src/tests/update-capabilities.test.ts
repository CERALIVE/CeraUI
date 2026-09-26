import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { readUpdateCapabilities } from "../modules/system/update-capabilities.ts";
import { getUpdateCapabilitiesProcedure } from "../rpc/procedures/system.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const dir = mkdtempSync(join(tmpdir(), "ceraui-update-capabilities-"));
const file = join(dir, "update-capabilities.json");
const context = {
	ws: {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: () => {},
	} as unknown as AppWebSocket,
	isAuthenticated: () => true,
	authenticate: () => {},
	deauthenticate: () => {},
	markActive: () => {},
	getLastActive: () => 0,
	setSenderId: () => {},
	getSenderId: () => undefined,
	clearSenderId: () => {},
} satisfies RPCContext;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("image update capabilities", () => {
	test("missing file is legacy without OS or slot-sync features", async () => {
		// Given no image capability file, when read, then the legacy set applies.
		expect(await readUpdateCapabilities(file)).toEqual({
			mode: "legacy",
			features: [],
		});
	});

	test("invalid content is legacy without advertising unsupported features", async () => {
		// Given a malformed schema carrying a tempting feature, when read.
		writeFileSync(
			file,
			JSON.stringify({
				schema: 2,
				features: ["slot-sync", "apt-all-packages"],
			}),
		);
		// Then neither feature may reach the operator.
		expect(await readUpdateCapabilities(file)).toEqual({
			mode: "legacy",
			features: [],
		});
	});

	test("an unknown feature token is invalid rather than silently advertised", async () => {
		// Given an unrecognised feature beside apt-all-packages, when read, then legacy wins.
		writeFileSync(
			file,
			JSON.stringify({
				schema: 1,
				features: ["apt-all-packages", "future-unreviewed-feature"],
				ota_uid: 999,
				apt_uid: 42,
			}),
		);
		expect(await readUpdateCapabilities(file)).toEqual({
			mode: "legacy",
			features: [],
		});
	});

	test("the current image empty feature array stays legacy-equivalent", async () => {
		// Given the image's honest early carrier, when read, then no agent is enabled.
		writeFileSync(
			file,
			JSON.stringify({ schema: 1, features: [], ota_uid: 999, apt_uid: 42 }),
		);
		expect(await readUpdateCapabilities(file)).toEqual({
			mode: "legacy",
			features: [],
		});
	});

	test("a partial feature file without apt-all-packages cannot advertise slot-sync", async () => {
		// Given a staged image with only a slot-sync token, when read, then legacy wins.
		writeFileSync(
			file,
			JSON.stringify({
				schema: 1,
				features: ["slot-sync"],
				ota_uid: 999,
				apt_uid: 42,
			}),
		);
		expect(await readUpdateCapabilities(file)).toEqual({
			mode: "legacy",
			features: [],
		});
	});

	test("only an apt-all-packages image can leave the legacy roster", async () => {
		// Given a valid partial image, when read, then named capabilities are preserved.
		writeFileSync(
			file,
			JSON.stringify({
				schema: 1,
				features: ["apt-all-packages", "slot-sync"],
				ota_uid: 999,
				apt_uid: 42,
			}),
		);
		expect(await readUpdateCapabilities(file)).toEqual({
			mode: "capable",
			features: ["apt-all-packages", "slot-sync"],
		});
	});

	test("authenticated RPC reports the same legacy decision", async () => {
		// Given the dev host without the image file, when queried by the RPC.
		// Then no OS or slot-sync capability is asserted.
		expect(
			await call(getUpdateCapabilitiesProcedure, undefined, { context }),
		).toEqual({ mode: "legacy", features: [] });
	});
});
