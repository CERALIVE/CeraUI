import { afterEach, beforeEach, expect, mock, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnWithTimeoutResult } from "../../helpers/spawn-policy.ts";
import * as gateways from "../../modules/network/gateways.ts";
import type { AptReachability } from "../../modules/system/apt-reachability.ts";
import { setAptTransportDepsForTest } from "../../modules/system/apt-transport.ts";
import * as transaction from "../../modules/system/software-update-process.ts";
import * as updates from "../../modules/system/software-updates.ts";
import { setCeraliveSourcesFileForTest } from "../../modules/system/update-apt-channel.ts";
import { setUpdateCapabilityPathForTest } from "../../modules/system/update-capabilities.ts";
import { setUpdateSettingsFilePathForTest } from "../../modules/system/update-settings.ts";
import {
	rankTransports,
	type TransportSample,
} from "../../modules/system/update-transport/core.ts";
import { updateHarness } from "../software-updates-preflight-harness.ts";
import { PINNED_CAPABILITIES, pinFixture } from "./apt-transport-fixture.ts";

const simulation = "Inst libc6 [1] (2 Debian:13/stable [amd64])\n";
const inventory = `Package files:
 500 https://deb.debian.org/debian trixie/main amd64 Packages
     release o=Debian,n=trixie,l=Debian
     origin deb.debian.org
Pinned packages:
`;
const policy = `libc6:
  Candidate: 2
  Version table:
     2 500
        500 https://deb.debian.org/debian trixie/main amd64 Packages
`;

type Pins = Awaited<ReturnType<typeof pinFixture>>;

/** Real software-updates entry points over a private transport-uidrange image and an argv-only APT port. */
export function aptEntryHarness() {
	const t = {
		dir: "",
		fixture: undefined as Pins | undefined,
		commands: [] as { argv: string[]; pinned: boolean }[],
		download: async (
			_signal?: AbortSignal,
		): Promise<SpawnWithTimeoutResult> => ({
			exitCode: 0,
			stdout: "Get:1 https://deb.debian.org libc6 2 [4 kB]\n",
			stderr: "",
		}),
		legacyProbe: mock(async (): Promise<AptReachability> => {
			throw new Error("the unbound legacy probe must not run");
		}),
	};
	const defaultDownload = t.download;

	beforeEach(async () => {
		t.dir = await mkdtemp(join(tmpdir(), "apt-transport-entry-"));
		setUpdateCapabilityPathForTest(join(t.dir, "caps.json"));
		setCeraliveSourcesFileForTest(join(t.dir, "sources"));
		setUpdateSettingsFilePathForTest(join(t.dir, "settings.json"));
		updates.setAptReachabilityProbeForTest(t.legacyProbe);
		spyOn(gateways, "updateGwWrapper").mockResolvedValue(true);
		t.commands = [];
		t.download = defaultDownload;
		updates.setAptCommandRunnerForTest(async (argv, options) => {
			t.commands.push({
				argv: [...argv],
				pinned: t.fixture?.active() ?? false,
			});
			const stdout =
				argv[1] === "-s"
					? simulation
					: argv[1] === "policy"
						? argv[2]
							? policy
							: inventory
						: "";
			return argv[1] === "-d"
				? t.download(options?.signal)
				: { exitCode: 0, stdout, stderr: "" };
		});
	});

	afterEach(async () => {
		setAptTransportDepsForTest(null);
		updates.setAptCommandRunnerForTest(null);
		updates.resetAptReachabilityProbeForTest();
		updates.resetSoftwareUpdateSizeRunner();
		updates.resetSoftwareUpdateCheckRunner();
		updates.resetSoftwareUpdateState();
		setUpdateCapabilityPathForTest(null);
		setCeraliveSourcesFileForTest(null);
		setUpdateSettingsFilePathForTest(null);
		t.legacyProbe.mockClear();
		t.fixture = undefined;
		mock.restore();
		await rm(t.dir, { recursive: true, force: true });
	});

	async function pinned(
		samples: readonly TransportSample[],
		features: readonly string[] = PINNED_CAPABILITIES.features,
	): Promise<Pins> {
		await writeFile(
			join(t.dir, "caps.json"),
			JSON.stringify({ ...PINNED_CAPABILITIES, features }),
		);
		const pins = await pinFixture();
		t.fixture = pins;
		setAptTransportDepsForTest({
			select: async () => rankTransports(samples),
			pin: pins.pin,
			ownership: pins.ownership,
		});
		return pins;
	}

	async function install(samples: readonly TransportSample[]) {
		const pins = await pinned(samples);
		const h = await updateHarness();
		t.commands = [];
		const launches: boolean[] = [];
		spyOn(transaction, "runDetachedAptAll").mockImplementation(
			async (_args, _verdict, handlers) => {
				launches.push(pins.active());
				handlers.onStderr("fixture transaction failure");
				return 100;
			},
		);
		let callback:
			| Parameters<
					Parameters<typeof updates.setSoftwareUpdateCheckRunner>[0]
			  >[0]
			| undefined;
		updates.setSoftwareUpdateCheckRunner((cb) => {
			callback = cb;
			return true;
		});
		expect(updates.startSoftwareUpdate()).toEqual({ started: true });
		return { h, pins, launches, run: async () => callback?.(null, 0) };
	}

	return { t, pinned, install };
}
