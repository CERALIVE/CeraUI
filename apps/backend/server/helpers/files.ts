import fs from "node:fs";
import util from "node:util";

export const readdirP = util.promisify(fs.readdir);
