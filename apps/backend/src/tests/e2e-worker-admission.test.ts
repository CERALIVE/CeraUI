import { describe, expect, it } from "bun:test";

import {
	E2E_WORKER_PROXY_SECRET_HEADER,
	permitsE2eWorkerProxyRequest,
} from "../rpc/e2e-worker-admission.ts";

const proxySecret = "a".repeat(64);

function requestWithSecret(secret?: string): Request {
	const headers = new Headers();
	if (secret !== undefined) headers.set(E2E_WORKER_PROXY_SECRET_HEADER, secret);
	return new Request("http://localhost/ws", { headers });
}

describe("E2E worker proxy admission", () => {
	it("stays disabled when no worker secret is configured", () => {
		expect(permitsE2eWorkerProxyRequest(requestWithSecret(), undefined)).toBe(
			true,
		);
	});

	it("requires the exact configured secret", () => {
		expect(
			permitsE2eWorkerProxyRequest(requestWithSecret(proxySecret), proxySecret),
		).toBe(true);
		for (const supplied of [
			undefined,
			"b".repeat(64),
			proxySecret.toUpperCase(),
		]) {
			expect(
				permitsE2eWorkerProxyRequest(requestWithSecret(supplied), proxySecret),
			).toBe(false);
		}
	});

	it("fails closed for malformed configuration and duplicate headers", () => {
		expect(
			permitsE2eWorkerProxyRequest(
				requestWithSecret(proxySecret),
				"not-a-secret",
			),
		).toBe(false);

		const headers = new Headers();
		headers.append(E2E_WORKER_PROXY_SECRET_HEADER, proxySecret);
		headers.append(E2E_WORKER_PROXY_SECRET_HEADER, proxySecret);
		const request = new Request("http://localhost/ws", { headers });
		expect(permitsE2eWorkerProxyRequest(request, proxySecret)).toBe(false);
	});
});
