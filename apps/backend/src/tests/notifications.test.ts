import { afterEach, describe, expect, it } from "bun:test";
import type WebSocket from "ws";
import {
	buildNotificationMsg,
	notificationRemove,
	notificationSend,
	notificationSendPersistent,
} from "../modules/ui/notifications.ts";

type WireShow = Record<string, unknown> & { name: string };

function captureConn(sink: string[]): WebSocket {
	return { send: (m: string) => sink.push(m) } as unknown as WebSocket;
}

const emitted = new Set<string>();

// Emit a persistent notification (the real hardware path) and read back the exact
// wire entry the persistent replay sends to a freshly connected client.
function emitPersistent(
	name: string,
	type: "success" | "warning" | "error",
	msg: string,
	key?: string,
	params?: Record<string, unknown>,
): WireShow {
	emitted.add(name);
	notificationSend(undefined, name, type, msg, 0, true, false, true, key, params);

	const sink: string[] = [];
	notificationSendPersistent(captureConn(sink), true);
	const parsed = JSON.parse(sink[0]) as {
		notification: { show: WireShow[] };
	};
	const show = parsed.notification.show.find((s) => s.name === name);
	if (!show) throw new Error(`notification ${name} not replayed`);
	return show;
}

afterEach(() => {
	for (const name of emitted) notificationRemove(name);
	emitted.clear();
});

describe("notification i18n key emission", () => {
	it("bootconfig replay carries notifications.bootconfigUpdating + msg fallback", () => {
		const msg =
			"Don't reset or unplug the system. The bootloader is being updated...";
		const show = emitPersistent(
			"bootconfig",
			"warning",
			msg,
			"notifications.bootconfigUpdating",
		);
		expect(show.key).toBe("notifications.bootconfigUpdating");
		expect(show.msg).toBe(msg);
	});

	it("undervoltage replay carries notifications.jetsonUndervoltage + msg fallback", () => {
		const msg = "System undervoltage detected.";
		const show = emitPersistent(
			"jetson_undervoltage",
			"error",
			msg,
			"notifications.jetsonUndervoltage",
		);
		expect(show.key).toBe("notifications.jetsonUndervoltage");
		expect(show.msg).toBe(msg);
	});

	it("hdmi replay carries notifications.hdmiError + msg fallback", () => {
		const msg = "HDMI signal issues detected.";
		const show = emitPersistent(
			"hdmi_error",
			"error",
			msg,
			"notifications.hdmiError",
		);
		expect(show.key).toBe("notifications.hdmiError");
		expect(show.msg).toBe(msg);
	});

	it("forwards params alongside the key", () => {
		const show = emitPersistent(
			"with_params",
			"warning",
			"fallback",
			"notifications.someKey",
			{ count: 3 },
		);
		expect(show.key).toBe("notifications.someKey");
		expect(show.params).toEqual({ count: 3 });
	});

	it("is backward compatible: no key/params omits both, keeps msg", () => {
		const show = emitPersistent("legacy", "success", "plain message");
		expect(show.msg).toBe("plain message");
		expect(show.key).toBeUndefined();
		expect(show.params).toBeUndefined();
	});

	it("buildNotificationMsg includes key/params only when present", () => {
		const withKey = buildNotificationMsg(
			{
				name: "n",
				type: "warning",
				msg: "m",
				key: "notifications.bootconfigUpdating",
				params: { a: 1 },
				isDismissable: false,
				isPersistent: true,
				duration: 0,
				authedOnly: false,
			},
			0,
		);
		expect(withKey.key).toBe("notifications.bootconfigUpdating");
		expect(withKey.params).toEqual({ a: 1 });

		const withoutKey = buildNotificationMsg(
			{
				name: "n",
				type: "warning",
				msg: "m",
				isDismissable: false,
				isPersistent: false,
				duration: 0,
				authedOnly: false,
			},
			0,
		);
		expect("key" in withoutKey).toBe(false);
		expect("params" in withoutKey).toBe(false);
	});
});
