import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildTelegramConfig, sendTelegramMessage } from '../telegram.js';

export function registerNotificationTools(server: McpServer): void {
	server.registerTool(
		'send_telegram_notification',
		{
			description:
				'Send a simple notification message to the configured Telegram chat.',
			inputSchema: {
				disableNotification: z.boolean().optional(),
				message: z
					.string()
					.min(1, 'Message cannot be empty.')
					.max(3500, 'Message is too long for Telegram.'),
				parseMode: z
					.enum(['HTML', 'Markdown', 'MarkdownV2'])
					.optional(),
			},
		},
		async ({ disableNotification, message, parseMode }) => {
			const { config, error } = buildTelegramConfig();

			if (!config) {
				return {
					content: [
						{ type: 'text', text: `Configuration error: ${error}` },
					],
					isError: true,
				};
			}

			try {
				const result = await sendTelegramMessage(config, {
					disableNotification,
					message,
					parseMode,
				});

				return {
					content: [
						{
							type: 'text',
							text: `Notification sent to Telegram (status ${result.statusCode}${result.messageId ? `, message_id=${result.messageId}` : ''}).`,
						},
					],
				};
			} catch (err) {
				const messageText =
					err instanceof Error
						? err.message
						: 'Unknown error while sending message.';
				return {
					content: [
						{
							type: 'text',
							text: `Failed to send Telegram message: ${messageText}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		'telegram_config_status',
		{
			description:
				'Check whether Telegram configuration is valid for this MCP server.',
			inputSchema: {},
		},
		async () => {
			const { config, error } = buildTelegramConfig();
			if (!config) {
				return {
					content: [
						{
							type: 'text',
							text: `Invalid configuration: ${error}`,
						},
					],
					isError: true,
				};
			}

			const urlSource = process.env.BOT_TELEGRAM_TOKEN
				? 'BOT_TELEGRAM_TOKEN'
				: 'BOT_TELEGRAM_URL';

			return {
				content: [
					{
						type: 'text',
						text: `Configuration is valid. URL source: ${urlSource}. Chat ID configured: ${config.chatId}. Timeout: ${config.timeoutMs}ms.`,
					},
				],
			};
		},
	);
}
