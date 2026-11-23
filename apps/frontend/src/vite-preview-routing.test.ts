import { describe, expect, it, vi } from "vitest";

import {
	buildDevicePreview,
	E2E_BACKEND_PORT_COOKIE,
	E2E_WORKER_SECRET_HEADER,
} from "../vite-preview-routing.ts";

const workerSecret = "a".repeat(64);
const routingCookie = `${E2E_BACKEND_PORT_COOKIE}=3117.${workerSecret}`;

function getLogProxy(path: string) {
	const preview = buildDevicePreview(
		{ VITE_DEVICE_HOST: "device.local", VITE_DEVICE_PORT: "8080" },
		true,
	);
	const match = Object.entries(preview.proxy).find(([context]) =>
		new RegExp(context).test(path),
	);
	if (!match) throw new Error(`No preview proxy matched ${path}`);
	return { preview, proxyOptions: match[1] };
}

describe("preview device log routing", () => {
	it.each(["export", "bundle"])(
		"forwards the %s ticket request to its issuing backend",
		(endpoint) => {
			const path = `/api/logs/${endpoint}?ticket=ticket-1`;
			const { proxyOptions } = getLogProxy(path);
			const forwardHttp = vi.fn();
			const proxy = { web: forwardHttp };
			proxyOptions.configure?.(proxy as never, {} as never);

			const request: { url: string; headers: Record<string, string> } = {
				url: path,
				headers: {
					cookie: `session=active; ${routingCookie}`,
				},
			};
			proxy.web(request, {} as never);

			expect(forwardHttp).toHaveBeenCalledWith(
				request,
				expect.anything(),
				expect.objectContaining({ target: "http://127.0.0.1:3117" }),
			);
			expect(request.url).toBe(path);
			expect(request.headers.cookie).toBe("session=active");
			expect(request.headers[E2E_WORKER_SECRET_HEADER]).toBe(workerSecret);
		},
	);

	it("refuses a ticket request without a routing cookie", () => {
		const { proxyOptions } = getLogProxy("/api/logs/export?ticket=ticket-1");
		const forwardHttp = vi.fn();
		const proxy = { web: forwardHttp };
		proxyOptions.configure?.(proxy as never, {} as never);

		const response = { writeHead: vi.fn(), end: vi.fn() };
		response.writeHead.mockReturnValue(response as never);
		proxy.web(
			{ url: "/api/logs/export?ticket=ticket-1", headers: {} },
			response as never,
		);

		expect(response.writeHead).toHaveBeenCalledWith(403);
		expect(response.end).toHaveBeenCalledOnce();
		expect(forwardHttp).not.toHaveBeenCalled();
	});

	it("leaves unrelated paths outside the device log proxy", () => {
		const { preview } = getLogProxy("/api/logs/export?ticket=ticket-1");
		const contexts = Object.keys(preview.proxy).map(
			(context) => new RegExp(context),
		);

		expect(contexts.some((context) => context.test("/api/logs/clear"))).toBe(
			false,
		);
		expect(contexts.some((context) => context.test("/api/health"))).toBe(false);
	});
});
