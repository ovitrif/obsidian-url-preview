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
			"obsidianmd/ui/sentence-case": [
				"error",
				{
					acronyms: [
						"API", "HTTP", "HTTPS", "URL", "DNS", "TCP", "IP", "SSH", "TLS", "SSL",
						"FTP", "SFTP", "SMTP", "JSON", "XML", "HTML", "CSS", "PDF", "CSV",
						"YAML", "SQL", "PNG", "JPG", "JPEG", "GIF", "SVG", "2FA", "MFA",
						"OAuth", "JWT", "LDAP", "SAML", "SDK", "IDE", "CLI", "GUI", "CRUD",
						"REST", "SOAP", "CPU", "GPU", "RAM", "SSD", "USB", "UI", "OK",
						"RSS", "S3", "WebDAV", "ID", "UUID", "GUID", "SHA", "MD5",
						"ASCII", "UTF-8", "UTF-16", "DOM", "CDN", "FAQ", "AI", "ML", "PR",
					],
				},
			],
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
