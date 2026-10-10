import { expect, test } from "bun:test";
import { aptClientTlsFor } from "../modules/addons/apt-client-tls.ts";

test("the fleet certificate is presented only to the exact first-party hostname", async () => {
	const urls = [
		"https://images.ceralive.tv/addons/a.raw",
		"https://example.com/a.raw",
		"https://apt.ceralive.tv.evil.test/a.raw",
	];
	const packageFiles = (path: string) =>
		path.startsWith("/usr/share/ceralive/apt-credentials/");
	const both = await aptClientTlsFor(
		"https://apt.ceralive.tv/addons/a.raw",
		() => true,
	);
	expect(both?.tls.cert.name).toBe(
		"/usr/share/ceralive/apt-credentials/client.crt",
	);
	expect(both?.tls.key.name).toBe(
		"/usr/share/ceralive/apt-credentials/client.key",
	);
	expect(both?.tls.cert.size).toBeGreaterThanOrEqual(0);
	const legacy = await aptClientTlsFor(
		"https://apt.ceralive.tv/a.raw",
		(path) => path.startsWith("/etc/apt/certs/"),
	);
	expect(legacy?.tls.cert.name).toBe("/etc/apt/certs/client.crt");
	expect(
		await aptClientTlsFor("https://apt.ceralive.tv/a.raw", () => false),
	).toBeUndefined();
	for (const url of urls)
		expect(await aptClientTlsFor(url, packageFiles)).toBeUndefined();
	const requests: RequestInit[] = [];
	const fetchSpy = async (_url: string, init?: RequestInit) => {
		requests.push(init ?? {});
		return new Response(null, { status: 200 });
	};
	await fetchSpy(
		"https://apt.ceralive.tv/a.raw",
		await aptClientTlsFor("https://apt.ceralive.tv/a.raw", packageFiles),
	);
	await fetchSpy(
		urls[2] ?? "",
		await aptClientTlsFor(urls[2] ?? "", packageFiles),
	);
	expect(requests[0]).toHaveProperty("tls");
	expect(requests[1]).not.toHaveProperty("tls");
});

test("both add-on fetch sites pass the exact-host TLS option through", async () => {
	const manager = await Bun.file(
		`${import.meta.dir}/../modules/addons/manager.ts`,
	).text();
	const reconciler = await Bun.file(
		`${import.meta.dir}/../modules/addons/reconciler.ts`,
	).text();
	expect(manager).toContain("fetch(url, await aptClientTlsFor(url))");
	expect(reconciler).toContain("...(await aptClientTlsFor(url))");
});
