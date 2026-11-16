import { basename } from "node:path";
import { runTestCommand } from "./run-test-command.ts";

export async function preflight(unshare = "unshare") {
	try {
		const result = await runTestCommand([
			unshare,
			"-Urn",
			"sh",
			"-ec",
			"ip link add probe0 type dummy; nft add table inet probe; ip rule add priority 100 from 192.0.2.1 lookup 30001; ip rule show; ip route show",
		]);
		return { ok: result.code === 0, detail: result.stdout + result.stderr };
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return {
			ok: false,
			detail: `kernel namespace preflight: ${error.message}`,
		};
	}
}

export function isKernelChild(file: string): boolean {
	return process.env.CERALIVE_KERNEL_CHILD === file;
}

export function kernelReceipt(file: string, scenario: string): string {
	return `KERNEL_RECEIPT ${JSON.stringify({ file: basename(file), scenario })}`;
}

export async function inNamespace(
	file: string,
	scenario: string,
): Promise<void> {
	const result = await runTestCommand(
		[
			"unshare",
			"-Urn",
			process.execPath,
			"test",
			file,
			"--test-name-pattern",
			`${scenario.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
		],
		{ env: { CERALIVE_KERNEL_CHILD: file } },
	);
	const output = result.stdout + result.stderr;
	if (result.code !== 0)
		throw new Error(`kernel scenario failed: ${scenario}\n${output}`);
	const receipt = kernelReceipt(file, scenario);
	if (
		result.stdout.split(/\r?\n/).filter((line) => line === receipt).length !== 1
	)
		throw new Error(
			`missing or duplicate kernel receipt: ${receipt}\n${output}`,
		);
	// biome-ignore lint/suspicious/noConsole: expose verified child evidence in CI logs
	console.log(output);
}
