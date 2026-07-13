import { afterEach, describe, expect, it } from "vitest";

import viteConfig, {
	applyPreviewWebSocketRoute,
	DEVICE_WS_PROXY_CONTEXT,
	resolvePreviewWebSocketRoute,
} from "../../vite.config";

const originalDeviceHost = process.env.VITE_DEVICE_HOST;
const originalDevicePort = process.env.VITE_DEVICE_PORT;
const originalCi = process.env.CI;
const proxySecret = "a".repeat(64);

afterEach(() => {
	if (originalDeviceHost === undefined) delete process.env.VITE_DEVICE_HOST;
	else process.env.VITE_DEVICE_HOST = originalDeviceHost;
	if (originalDevicePort === undefined) delete process.env.VITE_DEVICE_PORT;
	else process.env.VITE_DEVICE_PORT = originalDevicePort;
	if (originalCi === undefined) delete process.env.CI;
	else process.env.CI = originalCi;
});

async function previewProxy() {
	process.env.VITE_DEVICE_HOST = "127.0.0.1";
	process.env.VITE_DEVICE_PORT = "3002";
	if (typeof viteConfig !== "function") {
		throw new TypeError("Vite config must be environment-aware");
	}
	const config = await viteConfig({
		command: "serve",
		mode: "production",
		isSsrBuild: false,
		isPreview: true,
	});
	return config.preview?.proxy;
}

describe("production preview device proxy", () => {
	it("proxies only the exact WebSocket application paths", async () => {
		const proxyConfig = await previewProxy();
		const proxy = proxyConfig?.[DEVICE_WS_PROXY_CONTEXT];
		if (typeof proxy !== "object" || proxy === null) {
			throw new TypeError(
				`preview.proxy[${DEVICE_WS_PROXY_CONTEXT}] must be a WebSocket proxy`,
			);
		}

		expect(proxyConfig?.["/"]).toBeUndefined();
		expect(proxy.target).toBe("ws://127.0.0.1:3002");
		expect(proxy.ws).toBe(true);
		expect(proxy.bypass).toBeTypeOf("function");
		expect(proxy.configure).toBeTypeOf("function");

		const routePattern = new RegExp(DEVICE_WS_PROXY_CONTEXT);
		expect(routePattern.test("/ws")).toBe(true);
		expect(routePattern.test("/ws?token=preview-token")).toBe(true);
		expect(routePattern.test("/preview")).toBe(true);
		expect(routePattern.test("/preview?token=preview-token")).toBe(true);
		for (const rejectedPath of [
			"/",
			"/arbitrary",
			"/ws/child",
			"/preview/child",
			"/ws-attacker",
		]) {
			expect(routePattern.test(rejectedPath), rejectedPath).toBe(false);
		}
	});

	it("accepts only an exact CI routing cookie in the worker port range", () => {
		const defaultTarget = "ws://127.0.0.1:3002";
		const validRoute = `3107.${proxySecret}`;
		expect(
			resolvePreviewWebSocketRoute(
				defaultTarget,
				{
					url: "/ws",
					headers: {
						cookie: `session=abc; ceraui_e2e_backend_port=${validRoute}; theme=dark`,
					},
				},
				true,
			),
		).toEqual({
			target: "ws://127.0.0.1:3107",
			workerPort: 3107,
			workerSecret: proxySecret,
			forwardedCookie: "session=abc; theme=dark",
		});

		for (const rejectedCookie of [
			undefined,
			"session=abc",
			"ceraui_e2e_backend_port=",
			`ceraui_e2e_backend_port=310.${proxySecret}`,
			`ceraui_e2e_backend_port=3107x.${proxySecret}`,
			`ceraui_e2e_backend_port=3099.${proxySecret}`,
			`ceraui_e2e_backend_port=3200.${proxySecret}`,
			`ceraui_e2e_backend_port=${validRoute}; ceraui_e2e_backend_port=3108.${proxySecret}`,
			`ceraui_e2e_backend_port=${validRoute}; ceraui_e2e_backend_port=${validRoute}`,
			`ceraui_e2e_backend_port =${validRoute}`,
			`ceraui_e2e_backend_port=${validRoute} `,
			`ceraui_e2e_backend_port=%33%31%30%37.${proxySecret}`,
			`ceraui%5fe2e_backend_port=${validRoute}`,
			`ceraui_e2e_backend_port=${validRoute}; ceraui%5fe2e_backend_port=${validRoute}`,
			`xceraui_e2e_backend_port=${validRoute}`,
			"ceraui_e2e_backend_port=3107",
			`ceraui_e2e_backend_port=3107.${"a".repeat(63)}`,
			`ceraui_e2e_backend_port=3107.${"A".repeat(64)}`,
			`ceraui_e2e_backend_port=3107.%61${"a".repeat(62)}`,
		]) {
			expect(
				resolvePreviewWebSocketRoute(
					defaultTarget,
					{ url: "/ws", headers: { cookie: rejectedCookie } },
					true,
				),
				rejectedCookie,
			).toBeNull();
		}

		expect(
			resolvePreviewWebSocketRoute(
				defaultTarget,
				{
					url: "/ws?ceraui_e2e_backend_port=3108",
					headers: {
						cookie: `ceraui_e2e_backend_port=${validRoute}`,
						"x-ceraui-e2e-backend-port": "3108",
					},
				},
				false,
			),
		).toEqual({ target: defaultTarget });
	});

	it("rejects non-exact paths and explicit CI steering attempts", () => {
		const defaultTarget = "ws://127.0.0.1:3002";
		const cookie = `ceraui_e2e_backend_port=3107.${proxySecret}`;
		for (const request of [
			{ url: "/", headers: { cookie } },
			{ url: "/arbitrary", headers: { cookie } },
			{ url: "/ws/child", headers: { cookie } },
			{ url: "/w%73", headers: { cookie } },
			{ url: "/ws/../preview", headers: { cookie } },
			{ url: "/ws/%2e%2e/preview", headers: { cookie } },
			{ url: "/preview/./", headers: { cookie } },
			{ url: "//evil/ws", headers: { cookie } },
			{ url: "http://evil/ws", headers: { cookie } },
			{ url: "/ws#fragment", headers: { cookie } },
			{
				url: "/ws?ceraui_e2e_backend_port=3108",
				headers: { cookie },
			},
			{
				url: "/ws?ceraui%5fe2e_backend_port=3108",
				headers: { cookie },
			},
			{
				url: "/ws",
				headers: { cookie, "x-ceraui-e2e-backend-port": "3108" },
			},
			{
				url: "/ws",
				headers: { cookie, "x-ceraui-e2e-proxy-auth": "attacker" },
			},
		]) {
			expect(
				resolvePreviewWebSocketRoute(defaultTarget, request, true),
				request.url,
			).toBeNull();
		}
	});

	it("strips the routing cookie and injects only the fixture secret", () => {
		const request = {
			url: "/ws",
			headers: {
				cookie: `session=abc; ceraui_e2e_backend_port=3107.${proxySecret}; theme=dark`,
			},
		};
		const route = resolvePreviewWebSocketRoute(
			"ws://127.0.0.1:3002",
			request,
			true,
		);
		if (route === null) throw new TypeError("valid worker route must resolve");

		applyPreviewWebSocketRoute(request, route);

		expect(request.headers).toEqual({
			cookie: "session=abc; theme=dark",
			"x-ceraui-worker-secret": proxySecret,
		});
	});
});
