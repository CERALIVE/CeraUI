import { spyOn } from "bun:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import * as processCleanup from "../../helpers/killall.ts";
import * as preview from "../../mocks/providers/preview.ts";
import { getCellularStack } from "../../modules/cellular/cellular-stack.ts";
import * as cellular from "../../modules/events/cellular-events.ts";
import * as deviceStart from "../../modules/events/device-start.ts";
import * as emitter from "../../modules/events/emit.ts";
import * as modemLoop from "../../modules/modems/modem-update-loop.ts";
import * as modemIdentity from "../../modules/modems/modem-wire-producer.ts";
import { setModemsState } from "../../modules/modems/state/modems-state-cache.ts";
import { getBootReadiness } from "../../modules/system/readiness.ts";
import * as revisions from "../../modules/system/revisions.ts";
import * as updates from "../../modules/system/update-bootstrap.ts";
import * as versionContext from "../../modules/system/version-context.ts";
import * as server from "../../rpc/server.ts";

// The entrypoint runs in its own mock-mode process. Keep sockets, host process
// cleanup and installed updater ownership out of this wiring test.
spyOn(server, "initServer").mockReturnValue(undefined);
spyOn(preview, "startMockPreviewServer").mockReturnValue(null);
spyOn(processCleanup, "default").mockResolvedValue(undefined);
spyOn(updates, "runUpdateBootstrap").mockResolvedValue(undefined);

const revisionRead = Promise.withResolvers<void>();
const logWrite = Promise.withResolvers<void>();
const calls: string[] = [];
spyOn(revisions, "initRevisions").mockImplementation(() => {
	calls.push("read revisions");
	return revisionRead.promise;
});
spyOn(versionContext, "logBootRecord").mockImplementation(async () => {
	calls.push("write version log");
	await logWrite.promise;
	calls.push("version log written");
});
spyOn(deviceStart, "recordDeviceStart").mockImplementation(async () => {
	calls.push("record device start");
	throw new Error("injected device-start write failure");
});

const observe = spyOn(cellular, "initCellularEvents");
const emit = spyOn(emitter, "emitEvent");
spyOn(modemIdentity, "getModemIdPath").mockReturnValue(
	"platform-xhci-hcd.0.auto-usb-0:1.4:1.4",
);
const discovery = spyOn(modemLoop, "initModemUpdateLoop").mockImplementation(
	() => {
		deepStrictEqual(getCellularStack(), {
			backend: "dbus",
			ready: true,
			degraded: false,
		});
		calls.push("discover");
		setModemsState({
			7: {
				ifname: "wwan7",
				name: "First discovered modem",
				sim_network: "Test network",
				network_type: { supported: {}, active: null },
			},
		});
		deepStrictEqual(
			emit.mock.calls.filter(([code]) => code === "modem_added"),
			[
				[
					"modem_added",
					{
						modemKey: "platform-xhci-hcd.0.auto-usb-0:1.4",
						name: "First discovered modem",
					},
				],
			],
		);
		return Promise.resolve();
	},
);

await import("../../main.ts");

strictEqual(discovery.mock.calls.length, 1, "discovery did not run once");
strictEqual(
	observe.mock.calls.length,
	1,
	"cellular observation was not started once",
);
deepStrictEqual(calls, ["read revisions", "discover"]);

revisionRead.resolve();
await setImmediate();
deepStrictEqual(calls, ["read revisions", "discover", "write version log"]);

logWrite.resolve();
await setImmediate();
deepStrictEqual(calls, [
	"read revisions",
	"discover",
	"write version log",
	"version log written",
	"record device start",
]);
strictEqual(
	getBootReadiness().degradedSubsystems.includes("boot-record"),
	true,
);
process.exit(0);
