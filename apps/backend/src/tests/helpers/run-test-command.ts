export async function runTestCommand(
	cmd: string[],
	opts: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	// #40078 is fixed in Bun 1.4.3; keep async spawn so tests do not block the event loop.
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
