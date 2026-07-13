import { describe, expect, it } from "vitest";

import {
	E2E_WORKER_PROXY_SECRET_HEADER,
	permitsE2eWorkerUpgrade,
} from "../rpc/e2e-worker-admission.ts";

const proxySecret = "a".repeat(64);

function requestWithSecret(secret?: string): Request {
	const headers = new Headers();
	if (secret !== undefined) headers.set(E2E_WORKER_PROXY_SECRET_HEADER, secret);
	return new Request("http://localhost/ws", { headers });
}

describe("E2E worker proxy admission", () => {
	it("stays disabled when no worker secret is configured", () => {
		expect(permitsE2eWorkerUpgrade(requestWithSecret(), undefined)).toBe(true);
	});

	it("requires the exact configured secret", () => {
		expect(
			permitsE2eWorkerUpgrade(requestWithSecret(proxySecret), proxySecret),
		).toBe(true);
		for (const supplied of [
			undefined,
			"b".repeat(64),
			proxySecret.toUpperCase(),
		]) {
			expect(
				permitsE2eWorkerUpgrade(requestWithSecret(supplied), proxySecret),
			).toBe(false);
		}
	});

	it("fails closed for malformed configuration and duplicate headers", () => {
		expect(
			permitsE2eWorkerUpgrade(requestWithSecret(proxySecret), "not-a-secret"),
		).toBe(false);

		const headers = new Headers();
		headers.append(E2E_WORKER_PROXY_SECRET_HEADER, proxySecret);
		headers.append(E2E_WORKER_PROXY_SECRET_HEADER, proxySecret);
		const request = new Request("http://localhost/ws", { headers });
		expect(permitsE2eWorkerUpgrade(request, proxySecret)).toBe(false);
	});
});
