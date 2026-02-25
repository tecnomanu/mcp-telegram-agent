#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SERVER_NAME } from './constants.js';
import { createServer } from './server.js';
import { registerAll } from './tools/index.js';

const server = createServer();
registerAll(server);

async function main(): Promise<void> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`[${SERVER_NAME}] fatal error: ${message}`);
	process.exit(1);
});
