export async function runTestCommand(
	cmd: string[],
	opts: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	// Bun 1.4.2 spawnSync can corrupt its private loop during GC (oven-sh/bun#40078).
	await using proc = Bun.spawn(cmd, {
		...opts,
		env: { ...process.env, ...opts.env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		proc.stdout.text(),
		proc.stderr.text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}
