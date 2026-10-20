export const validCapabilities =
	'{"schema":1,"features":[],"ota_uid":999,"apt_uid":42}';
export const capabilityVariants = [
	["EIO", validCapabilities],
	["EACCES", validCapabilities],
	["ELOOP", validCapabilities],
	["oversize", `${" ".repeat(16_385)}${validCapabilities}`],
	[
		"duplicate",
		'{"schema":1,"features":[],"features":["apt-all-packages"],"ota_uid":999,"apt_uid":42}',
	],
	[
		"escaped-duplicate",
		'{"schema":1,"features":[],"featur\\u0065s":[],"ota_uid":999,"apt_uid":42}',
	],
	["invalid-utf8", Buffer.from([0xff])],
	["schema", '{"schema":2,"features":[],"ota_uid":999,"apt_uid":42}'],
	["truncated", '{"schema":1'],
] as const;
