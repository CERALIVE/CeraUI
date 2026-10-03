import { afterEach, describe, expect, test } from "bun:test";
import { fetchAsOta } from "../modules/system/update-orchestrator/os-agent.ts";
import {
	checkOsManifestResult,
	checkUpdatesNow,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { selectUpdateTransport } from "../modules/system/update-transport/executor.ts";
import { getPersistentNotifications } from "../modules/ui/notifications.ts";
import { candidate, setup } from "./helpers/os-agent-runtime-harness.ts";

afterEach(() => resetOrchestratorRuntimeForTest());

describe("OS channel publication over a healthy transport", () => {
	async function checkFromHttp(status: number, signatureStatus = status) {
		const urls: string[] = [];
		const check = async () => {
			const base =
				"https://images.ceralive.tv/channels/stable/rock-5b-plus.json";
			const selection = await selectUpdateTransport(
				{ profile: "os", board: "rock-5b-plus", channel: "stable" },
				{
					listIfnames: () => ["eth0"],
					readSources: async () => "",
					credentials: async () => undefined,
					mmIfnames: () => [],
					routerIfnames: () => [],
					dongleIfnames: () => [],
					run: async (argv) => {
						if (argv[0] === "nmcli")
							return {
								exitCode: 0,
								stdout:
									"GENERAL.DEVICE:eth0\nGENERAL.TYPE:ethernet\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:no (guessed)",
								stderr: "",
							};
						if (argv[0] === "resolvectl")
							return argv.includes("-6")
								? { exitCode: 1, stdout: "", stderr: "no IPv6 route" }
								: {
										exitCode: 0,
										stdout: `${argv.at(-1)}: 192.0.2.1`,
										stderr: "",
									};
						const code = argv.at(-1)?.endsWith("/generate_204")
							? 204
							: signatureStatus === 404 || signatureStatus === 410
								? signatureStatus
								: status === 404 || status === 410
									? status
									: 200;
						return {
							exitCode: 0,
							stdout: `\n<<<update-probe>>>${code} 0.01`,
							stderr: "",
						};
					},
				},
			);
			if (selection.status !== "selected")
				throw new Error("OS channel has no healthy uplink");
			const fetchDeps = {
				readUid: async () => "987",
				run: async (argv: string[]) => {
					const url = argv.at(-1) ?? "";
					urls.push(url);
					const code = url.endsWith(".sig") ? signatureStatus : status;
					return {
						exitCode: code === 200 ? 0 : 22,
						stdout: String(code),
						stderr: code === 200 ? "" : `curl: (22) HTTP ${code}`,
					};
				},
			};
			if (!(await fetchAsOta(base, "/tmp/manifest.json", 987, fetchDeps)))
				return undefined;
			if (
				!(await fetchAsOta(`${base}.sig`, "/tmp/manifest.sig", 987, fetchDeps))
			)
				return undefined;
			return candidate;
		};
		setup({
			runPackageCheck: async () => null,
			getPackageInstallWireState: () => ({ kind: "idle" }),
			checkOsManifest: (channel) =>
				checkOsManifestResult(channel ?? "stable", check),
		});
		setOrchestratorStateForTest(initialOrchestratorState(0));
		const outcome = await checkUpdatesNow();
		return { outcome, state: getOrchestratorState(), urls };
	}

	test.each([404, 410])(
		"an unpublished channel object (%i) completes the OS check with nothing available",
		async (status) => {
			const refusedBefore = getPersistentNotifications(true).show.filter(
				(item) => item.name.startsWith("update:refused:os-check:"),
			).length;
			const { outcome, state, urls } = await checkFromHttp(status);
			expect(outcome).toEqual({ started: true });
			expect(state.phase).toBe("idle");
			expect(state.failureReason).toBeNull();
			expect(state.osCheck.consecutiveFailures).toBe(0);
			expect(state.osCheck.lastSuccessAt).not.toBeNull();
			expect(urls).toEqual([
				"https://images.ceralive.tv/channels/stable/rock-5b-plus.json",
			]);
			await checkUpdatesNow();
			expect(getOrchestratorState().failureReason).toBeNull();
			expect(
				getPersistentNotifications(true).show.filter((item) =>
					item.name.startsWith("update:refused:os-check:"),
				).length,
			).toBe(refusedBefore);
		},
	);

	test("a missing signature beside a published JSON is also not available", async () => {
		const { state, urls } = await checkFromHttp(200, 404);
		expect(state.phase).toBe("idle");
		expect(state.failureReason).toBeNull();
		expect(state.osCheck.consecutiveFailures).toBe(0);
		expect(state.osCheck.lastSuccessAt).not.toBeNull();
		expect(urls).toEqual([
			"https://images.ceralive.tv/channels/stable/rock-5b-plus.json",
			"https://images.ceralive.tv/channels/stable/rock-5b-plus.json.sig",
		]);
	});

	test("a published channel still offers the verified candidate", async () => {
		const { state, urls } = await checkFromHttp(200);
		expect(state.phase).toBe("os-available");
		expect(state.osCheck.lastSuccessAt).not.toBeNull();
		expect(urls).toEqual([
			"https://images.ceralive.tv/channels/stable/rock-5b-plus.json",
			"https://images.ceralive.tv/channels/stable/rock-5b-plus.json.sig",
		]);
	});

	test("a 503 object response is an OS check failure, not a missing publication", async () => {
		const { state } = await checkFromHttp(503);
		expect(state.phase).toBe("idle");
		expect(state.failureReason).not.toBeNull();
		expect(state.osCheck.consecutiveFailures).toBe(1);
	});

	test("curl TLS verification failure cannot be mistaken for an unpublished channel", async () => {
		const outcome = await fetchAsOta(
			"https://images.ceralive.tv/channels/stable/rock-5b-plus.json",
			"/tmp/manifest.json",
			987,
			{
				readUid: async () => "987",
				run: async () => ({ exitCode: 60, stdout: "404", stderr: "TLS" }),
			},
		).then(
			() => "resolved",
			(error: unknown) => error,
		);
		expect(outcome).toMatchObject({ reason: "manifest_fetch_failed" });
	});
});
