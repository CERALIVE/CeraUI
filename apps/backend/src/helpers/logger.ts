import winston from "winston";

export const logger = winston.createLogger({
	format: winston.format.simple(),
	defaultMeta: {},
	transports: [
		new winston.transports.Console({ level: "warn" }),
		new winston.transports.File({
			filename: "debug.log",
			level: "debug",
		}),
	],
});
