import winston from "winston";

const isDev = process.env.NODE_ENV === "development";

export const logger = winston.createLogger({
	format: winston.format.simple(),
	defaultMeta: {},
	transports: [
		new winston.transports.Console({ level: isDev ? "info" : "warn" }),
		new winston.transports.File({
			filename: "debug.log",
			level: "debug",
		}),
	],
});
