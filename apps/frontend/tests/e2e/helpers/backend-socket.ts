export function isBackendSocket(url: URL): boolean {
	return (
		/^(3002|31\d\d|8090|8091)$/.test(url.port) ||
		url.port === (process.env.E2E_PORT ?? "6173")
	);
}
