const groups: Record<string, string> = {
	"802-11-wireless": "wifi",
	"802-11-wireless-security": "wifi-security",
};
const pmf: Record<string, string> = {
	default: "0",
	disable: "1",
	optional: "2",
	required: "3",
};
const escapeString = (value: string) =>
	value
		.replaceAll("\\", "\\\\")
		.replaceAll(" ", "\\s")
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t");

export function encodeProfile(
	fields: Readonly<Record<string, string>>,
): string {
	const sections = new Map<string, Map<string, string>>();
	for (const [input, raw] of Object.entries(fields)) {
		const field =
			input === "type"
				? "connection.type"
				: input === "ifname"
					? "connection.interface-name"
					: input;
		const dot = field.indexOf(".");
		const prefix = field.slice(0, dot);
		const group = groups[prefix] ?? prefix;
		const key = field.slice(dot + 1);
		let value = raw;
		if (field === "connection.type" && value === "802-11-wireless")
			value = "wifi";
		if (field === "connection.autoconnect")
			value = value === "yes" ? "true" : "false";
		if (field === "802-11-wireless-security.pmf") value = pmf[value] ?? value;
		let section = sections.get(group);
		if (!section) {
			section = new Map();
			sections.set(group, section);
		}
		section.set(key, escapeString(value));
	}
	return [...sections]
		.map(
			([group, fields]) =>
				`[${group}]\n${[...fields].map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
		)
		.join("\n");
}

export function decodeProfile(input: string): Record<string, string> {
	const fields: Record<string, string> = {};
	let group = "";
	for (const line of input.split("\n")) {
		if (line.startsWith("[")) {
			group = line.slice(1, -1);
			continue;
		}
		const equal = line.indexOf("=");
		if (equal < 0 || !group || line.startsWith("#")) continue;
		const setting =
			group === "wifi"
				? "802-11-wireless"
				: group === "wifi-security"
					? "802-11-wireless-security"
					: group;
		const key = `${setting}.${line.slice(0, equal)}`;
		let value = line
			.slice(equal + 1)
			.replace(/\\([snrt\\])/g, (_, escaped: string) => {
				switch (escaped) {
					case "s":
						return " ";
					case "n":
						return "\n";
					case "r":
						return "\r";
					case "t":
						return "\t";
					case "\\":
						return "\\";
					default:
						throw new Error("Invalid fake keyfile escape");
				}
			});
		if (key === "connection.type" && value === "wifi")
			value = "802-11-wireless";
		if (key === "connection.autoconnect")
			value = value === "true" ? "yes" : "no";
		fields[key] = value;
	}
	return fields;
}
