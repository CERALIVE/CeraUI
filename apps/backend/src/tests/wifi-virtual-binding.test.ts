import { afterEach, beforeEach, expect, test } from "bun:test";
import * as connections from "../modules/wifi/wifi-connections.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { isHotspotActive } from "../modules/wifi/wifi-hotspot-types.ts";
import {
	bindingParent,
	bindingVirtual,
	virtualBindingFixture,
} from "./helpers/wifi-virtual-binding-fixture.ts";

let fixture: Awaited<ReturnType<typeof virtualBindingFixture>>;
beforeEach(async () => {
	fixture = await virtualBindingFixture();
});
afterEach(async () => {
	await fixture.close();
});

const sources = ["discovery", "Start-confirmation", "refreshed"] as const;
const events = [
	"disconnected",
	"unavailable",
	"deactivated",
	"rename",
	"replug",
	"disappeared",
	"absent-then-parent",
	"failed-listing",
	"partial-listing",
	"cross-phy",
	"Stop-complete",
	"Start-rollback",
	"confirmation-failure",
	"same-uuid-unreadable-mode",
] as const;
const parents = ["present", "absent", "changed"] as const;

for (const source of sources)
	for (const event of events)
		for (const parent of parents) {
			test(`virtual lifecycle ${source} / ${event} / parent=${parent}`, async () => {
				const virtual =
					source === "Start-confirmation"
						? { ...bindingVirtual, active: "" }
						: bindingVirtual;
				await fixture.discover([bindingParent, virtual]);
				if (source === "Start-confirmation") {
					expect(await fixture.start()).toEqual({ success: true });
					await fixture.confirm();
				} else if (source === "refreshed") {
					await fixture.discover([bindingParent, virtual]);
				}
				expect(fixture.row().hotspot.conn).toBe("old-ap");
				expect(fixture.row().concurrentHotspot?.activeConn).toBe("old-ap");
				if (parent === "changed") {
					await fixture.discover([
						{ ...bindingParent, active: "previous-parent" },
						bindingVirtual,
					]);
				}
				if (
					event === "disconnected" ||
					event === "unavailable" ||
					event === "cross-phy"
				) {
					connections.handleWifiMonitorEvent({
						type: "device-state",
						device: "clap-wlan0",
						state: event === "unavailable" ? "unavailable" : "disconnected",
					});
				} else if (event === "deactivated") {
					connections.handleWifiMonitorEvent({
						type: "connection-state",
						connection: "old-ap",
						state: "deactivated",
					});
				} else if (
					event === "Stop-complete" ||
					event === "Start-rollback" ||
					event === "confirmation-failure"
				) {
					expect(await fixture.stop()).toEqual({ success: true });
					if (event === "Start-rollback") {
						if (parent === "changed") {
							// The independent parent AP is still up after the leg's Down.
							// Move it back to Station so this Start exercises rollback.
							await fixture.discover([
								bindingParent,
								{ ...bindingVirtual, active: "" },
							]);
						}
						expect(await fixture.start(true)).toEqual({
							success: false,
							error: "activation-failed",
						});
					} else if (event === "confirmation-failure") {
						expect(await fixture.start()).toEqual({ success: true });
						await settlePending(fixture.row().ifname, false);
					}
				} else if (event === "absent-then-parent") {
					await fixture.discover([bindingParent]);
				}
				const handoffUuid = parent === "changed" ? "previous-parent" : "old-ap";
				if (event === "same-uuid-unreadable-mode") {
					expect(fixture.row().degradedReason).toBeUndefined();
					expect(fixture.row().hotspot.conn).toBe(handoffUuid);
					fixture.handoffKnownApToParent(handoffUuid);
				}
				const parentUuid =
					parent === "absent"
						? "station"
						: event === "same-uuid-unreadable-mode"
							? handoffUuid
							: parent === "changed"
								? "changed-parent"
								: "parent-ap";
				const nextParent = {
					...bindingParent,
					active: parentUuid,
					...(event === "rename" ? { ifname: "wlmoved" } : {}),
					...(event === "replug" ? { ifindex: 9 } : {}),
				};
				const frame =
					event === "disappeared" ||
					event === "absent-then-parent" ||
					event === "failed-listing" ||
					event === "partial-listing" ||
					event === "same-uuid-unreadable-mode"
						? [nextParent]
						: [
								nextParent,
								event === "cross-phy" || event === "replug"
									? {
											...bindingVirtual,
											phy: 1,
											permanent: "14:ac:60:12:34:56",
											active: "foreign-ap",
										}
									: {
											...bindingVirtual,
											ifname:
												event === "rename" ? "clap-wlmoved" : "clap-wlan0",
											active: "",
										},
							];
				if (event === "failed-listing" || event === "partial-listing") {
					const binding = fixture.row().concurrentHotspot;
					const cached = fixture.row().hotspot.conn;
					await fixture.discover(
						frame,
						event === "failed-listing" ? "failed" : "partial",
					);
					expect(fixture.row().concurrentHotspot).toBe(binding);
					expect(fixture.row().hotspot.conn).toBe(cached);
				}
				await fixture.discover(frame);
				if (event === "same-uuid-unreadable-mode" && parent !== "absent") {
					expect(fixture.row().activeConn).toBe(parentUuid);
					expect(fixture.row().activeMode).toBe("unknown");
				}
				if (parent === "absent")
					expect(isHotspotActive(fixture.row())).toBe(false);
				else expect(fixture.row().hotspot.conn).toBe(parentUuid);
				fixture.down.length = 0;
				expect(await fixture.stop()).toEqual({ success: true });
				expect(fixture.down).toEqual(parent === "absent" ? [] : [parentUuid]);
				expect(fixture.active).toEqual(new Set(["foreign-ap"]));
				expect(fixture.modified.has("foreign-ap")).toBe(false);
			});
		}
