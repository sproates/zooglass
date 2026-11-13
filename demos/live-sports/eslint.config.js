import config from "../../workbench/eslint.config.js";
import globals from "../../workbench/node_modules/globals/index.js";
export default [
  ...config,
  { ignores: ["prototype/**"] },
  { files: ["pages/*.js"], languageOptions: { globals: globals.browser } },
];
