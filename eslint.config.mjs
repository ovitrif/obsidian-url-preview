import globals from "globals";
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: { project: "./tsconfig.json" },
			globals: {
				...globals.browser,
				// Obsidian globals
				createEl: "readonly",
				createDiv: "readonly",
				createSpan: "readonly",
				createFragment: "readonly",
			},
		},
		rules: {
			"obsidianmd/sample-names": "off",
		},
	},
	{
		files: ["**/*.mjs"],
		languageOptions: {
			globals: globals.node,
		},
	},
	{
		ignores: ["node_modules/", "main.js", "dist/"],
	},
]);
