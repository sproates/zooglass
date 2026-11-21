import config from "../../workbench/eslint.config.js";
import globals from "../../workbench/node_modules/globals/index.js";
export default [
  ...config,
  {
    files: ["pages/continuous/*.js"],
    languageOptions: { globals: globals.browser },
  },
];
