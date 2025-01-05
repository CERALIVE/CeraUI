import util from "node:util";
import fs from "node:fs";

export const readdirP = util.promisify(fs.readdir);
