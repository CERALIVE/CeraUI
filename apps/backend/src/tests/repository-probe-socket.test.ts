import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithTimeout } from "../helpers/spawn-policy.ts";
import { probeAptReachability } from "../modules/system/apt-reachability.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

test("real device-bound curl distinguishes HTTP, verified TLS, and invalid certificates", async () => {
	// Given: isolated local HTTP/TLS listeners and an ephemeral trusted fixture cert.
	const ifname = Object.entries(networkInterfaces()).find(([, addresses]) =>
		addresses?.some(
			(address) => address.internal && address.address === "127.0.0.1",
		),
	)?.[0];
	if (!ifname) throw new Error("local loopback interface unavailable");
	const root = await mkdtemp(join(tmpdir(), "ceraui-repository-tls-"));
	try {
		const key = join(root, "key.pem");
		const cert = join(root, "cert.pem");
		const generated = await runTestCommand([
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			key,
			"-out",
			cert,
			"-days",
			"1",
			"-subj",
			"/CN=127.0.0.1",
			"-addext",
			"subjectAltName=IP:127.0.0.1",
		]);
		expect(generated.code).toBe(0);
		const methods: string[] = [];
		const tls = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: { key: Bun.file(key), cert: Bun.file(cert) },
			fetch: (request) => {
				methods.push(request.method);
				return new Response(null, { status: 403 });
			},
		});
		const plain = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(null, { status: 204 }),
		});
		try {
			const probe = (url: string, device = ifname) =>
				probeAptReachability({
					ifname: device,
					readSources: async () => `URIs: ${url}\nSuites: stable`,
					runProbe: (argv) =>
						spawnWithTimeout(
							[
								argv[0] ?? "curl",
								...argv.slice(1, -1),
								"--cacert",
								cert,
								argv.at(-1) ?? "",
							],
							{ timeoutMs: 4_000 },
						),
				});
			// When: the production probe talks to real sockets, with no TLS bypass.
			const http = await spawnWithTimeout(
				[
					"curl",
					"-q",
					"--noproxy",
					"*",
					"--max-time",
					"3",
					"-sS",
					"-I",
					"-o",
					"/dev/null",
					"-w",
					"%{http_code}",
					`http://127.0.0.1:${plain.port}`,
				],
				{ timeoutMs: 4_000 },
			);
			const verified = await probe(`https://127.0.0.1:${tls.port}`);
			const tlsFailure = await probe(`https://127.0.0.1:${plain.port}`);
			const wrongHostname = await probe(`https://localhost:${tls.port}`);
			const missingDevice = await probe(
				`https://127.0.0.1:${tls.port}`,
				"cera-missing",
			);
			// Then: HTTP cannot vouch for TLS; neither bad identity nor missing binding passes.
			expect(http).toMatchObject({ exitCode: 0, stdout: "204" });
			expect(verified.ipv4).toBe("ok");
			expect(methods).toContain("HEAD");
			expect(tlsFailure.verdict).toBe("unreachable");
			expect(wrongHostname.verdict).toBe("unreachable");
			expect(missingDevice.verdict).toBe("unreachable");
		} finally {
			tls.stop(true);
			plain.stop(true);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
