import { beforeEach, describe, expect, it, vi } from "vitest";

const { dismissRpc } = vi.hoisted(() => ({
	dismissRpc: vi.fn(async () => ({ success: true })),
}));
vi.mock("$lib/rpc", () => ({
	rpc: { notifications: { dismiss: dismissRpc } },
}));

import { dismissPersistentNotification } from "./notification-presentation";

describe("dismissPersistentNotification", () => {
	beforeEach(() => {
		dismissRpc.mockClear();
	});

	it("tells the device which shown release the operator dismissed", async () => {
		await dismissPersistentNotification({
			name: "ceralive_update",
			revision: 7,
			publisher: "backend-a",
		});

		expect(dismissRpc).toHaveBeenCalledWith({
			name: "ceralive_update",
			revision: 7,
			publisher: "backend-a",
		});
	});

	it("dismisses a notice without a revision by name, as before", async () => {
		await dismissPersistentNotification({ name: "hdmi_error" });

		expect(dismissRpc).toHaveBeenCalledWith({ name: "hdmi_error" });
	});
});
