import { expect, test } from "bun:test";
import {
	inNamespace,
	isKernelChild,
	kernelReceipt,
	preflight,
} from "./helpers/kernel-namespace.ts";

const file = import.meta.filename;
const child = isKernelChild(file);

test("missing unshare fails preflight with explicit detail", async () => {
	const result = await preflight("/nonexistent/ceralive-unshare");
	expect(result.ok).toBe(false);
	expect(result.detail).toMatch(/ENOENT/);
});

test("denied namespaces fail preflight", async () => {
	expect((await preflight("/bin/false")).ok).toBe(false);
});

test("real kernel preflight supports all required operations", async () => {
	const result = await preflight();
	expect(result.ok, result.detail).toBe(true);
});

test("exit zero without receipt is rejected", async () => {
	if (child) {
		expect(true).toBe(true);
		return;
	}
	await expect(
		inNamespace(file, "exit zero without receipt is rejected"),
	).rejects.toThrow("missing or duplicate kernel receipt");
});

test("receipt after child assertions is accepted", async () => {
	const scenario = "receipt after child assertions is accepted";
	if (child) {
		expect((await preflight()).ok).toBe(true);
		console.log(kernelReceipt(file, scenario));
		return;
	}
	await inNamespace(file, scenario);
});
