export async function standalone(
	source: string,
	cwd: string,
): Promise<{
	readonly stdout: string;
	readonly stderr: string;
	readonly exit: number;
}> {
	const child = Bun.spawn([process.execPath, "--eval", source], {
		cwd,
		env: process.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 15_000,
		killSignal: "SIGTERM",
	});
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exit };
}
