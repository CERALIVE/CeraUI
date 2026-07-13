export const E2E_WORKER_PROXY_SECRET_HEADER = "x-ceraui-worker-secret";

const WORKER_PROXY_SECRET = /^[0-9a-f]{64}$/;

/**
 * E2E worker backends accept browser traffic only through the CI preview proxy.
 * This is transport admission; RPC authentication remains independently required.
 */
export function permitsE2eWorkerUpgrade(
	request: Request,
	expectedSecret: string | undefined,
): boolean {
	if (expectedSecret === undefined) return true;
	return (
		WORKER_PROXY_SECRET.test(expectedSecret) &&
		request.headers.get(E2E_WORKER_PROXY_SECRET_HEADER) === expectedSecret
	);
}
