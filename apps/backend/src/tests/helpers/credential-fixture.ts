import { X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function credentialFixture() {
	const root = await mkdtemp(join(tmpdir(), "credential-public-test-"));
	const path = join(root, "synthetic.crt");
	const child = Bun.spawn(
		[
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:P-256",
			"-nodes",
			"-keyout",
			"/dev/null",
			"-out",
			path,
			"-days",
			"365",
			"-set_serial",
			"1001",
			"-subj",
			"/CN=synthetic-expiry-fixture",
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	if ((await child.exited) !== 0)
		throw new Error("synthetic certificate generation failed");
	const pem = Buffer.from(await Bun.file(path).arrayBuffer());
	const cert = new X509Certificate(pem);
	const command = Bun.spawn(
		["openssl", "x509", "-in", path, "-enddate", "-noout"],
		{
			stdout: "pipe",
			stderr: "ignore",
		},
	);
	const text = await new Response(command.stdout).text();
	if ((await command.exited) !== 0)
		throw new Error("synthetic public date read failed");
	const expiresAt = Date.parse(text.trim().replace("notAfter=", ""));
	const der = cert.raw;
	const replacement = Buffer.from(der);
	const serial = replacement.indexOf(Buffer.from([2, 2, 3, 233]));
	if (serial < 0) throw new Error("synthetic serial missing");
	replacement[serial + 3] = 234;
	return {
		root,
		pem,
		der,
		replacement,
		expiresAt,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}
