import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	handleTerminationSignal,
	resetShutdownForTest,
} from "../helpers/shutdown.ts";

const root = resolve(import.meta.dir, "../../../..");
const shutdown = join(root, "apps/backend/src/helpers/shutdown.ts");
const observation = join(
	root,
	"apps/backend/src/modules/wifi/wifi-radio-observation.ts",
);
const identity = join(
	root,
	"apps/backend/src/modules/wifi/wifi-radio-identity.ts",
);

async function standalone(source: string, cwd: string) {
	const child = Bun.spawn([process.execPath, "--eval", source], {
		cwd,
		env: process.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 15_000,
		killSignal: "SIGTERM",
	});
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exit };
}

test.each(["repository root", "empty directory"] as const)(
	"shutdown imports and exits naturally without application preload from %s",
	async (location) => {
		const empty = await mkdtemp(join(tmpdir(), "shutdown-import-"));
		try {
			// The empty cwd guarantees that no image-baked setup.json is available.
			const result = await standalone(
				`await import(${JSON.stringify(shutdown)}); console.log("IMPORTED");`,
				location === "repository root" ? root : empty,
			);
			expect(result).toEqual({
				stdout: "IMPORTED\n",
				stderr: "",
				exit: 0,
			});
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
	},
);

test("shutdown invokes its injected Wi-Fi termination before ingest cleanup", async () => {
	resetShutdownForTest();
	const exited = Promise.withResolvers<number>();
	let terminated = false;
	let terminatedBeforeIngest = false;
	try {
		handleTerminationSignal("SIGTERM", {
			terminateWifiObservation: () => {
				terminated = true;
			},
			stopSrtIngest: async () => {
				terminatedBeforeIngest = terminated;
			},
			stopDmesgWatchers: () => undefined,
			gracefulShutdown: async () => undefined,
			exit: (code) => exited.resolve(code),
		});
		expect(await exited.promise).toBe(0);
		expect(terminated).toBe(true);
		expect(terminatedBeforeIngest).toBe(true);
	} finally {
		resetShutdownForTest();
	}
});

test.each(["retry", "queued"] as const)(
	"real observation %s timers do not retain a process with a held reader",
	async (mode) => {
		const source = `
import { plugin } from "bun";
plugin({
  name: "isolated-radio-registry",
  setup(builder) {
    builder.onLoad({filter:/\\/wifi-connections\\.ts$/}, () => ({
      loader:"ts",
      contents:"export const getWifiInterfacesByMacAddress = () => ({});"
    }));
  }
});
const {WifiRadioObservation} = await import(${JSON.stringify(observation)});
const {WifiRadioIdentityProducer} = await import(${JSON.stringify(identity)});
const nativeTimeout = globalThis.setTimeout;
const nativeInterval = globalThis.setInterval;
const readStarted = Promise.withResolvers();
const captured = Promise.withResolvers();
let starts = 0;
globalThis.setTimeout = (callback, delay, ...args) => {
  const timer = nativeTimeout(callback, delay, ...args);
  if (delay === 0) starts++;
  const continuation = delay === 0 && starts === 2;
  queueMicrotask(() => {
    console.log("REF " + JSON.stringify({delay,hasRef:timer.hasRef()}));
    if ((${JSON.stringify(mode)} === "retry" && delay === 250) ||
        (${JSON.stringify(mode)} === "queued" && continuation)) captured.resolve();
  });
  return timer;
};
const producer = new WifiRadioIdentityProducer({
  readText() { readStarted.resolve(); return new Promise(() => {}); },
  realpath() { return Promise.resolve(undefined); }
});
const owner = new WifiRadioObservation(producer);
// This driver belongs to the probe, not observation; remove it after capture.
const driver = nativeInterval(() => {}, 50);
owner.enqueue([{ifname:"wlan0"}], producer.captureObservation());
await readStarted.promise;
console.log("READ_STARTED");
if (${JSON.stringify(mode)} === "queued")
  owner.enqueue([], producer.captureObservation());
await captured.promise;
clearInterval(driver);
console.log("MAIN_FINISHED");
`;
		const result = await standalone(source, root);
		const lines = result.stdout.trim().split("\n");
		expect(result.exit).toBe(0);
		expect(result.stderr).toBe("");
		expect(lines).toContain("READ_STARTED");
		expect(lines).toContain("MAIN_FINISHED");
		for (const line of lines.filter((line) => line.startsWith("REF ")))
			expect(JSON.parse(line.slice(4))).toMatchObject({ hasRef: false });
	},
);
