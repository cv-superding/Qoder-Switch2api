import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

export const APP_VERSION = pkg.version;
export const APP_NAME = "Qoder-Switch2api";
