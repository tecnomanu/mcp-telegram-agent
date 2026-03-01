import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MediaPayload } from '../types.js';
import { buildTelegramConfig, sendTelegramMedia, sendTelegramMessage } from '../telegram.js';

const mediaSchema = z
	.object({
		type: z.enum(['photo', 'audio', 'document']),
		url: z.string().optional(),
		base64Data: z.string().optional(),
		filename: z.string().optional(),
		mimeType: z.string().optional(),
	})
	.refine((m) => m.url || m.base64Data, {
		message: "Media requires either 'url' or 'base64Data'.",
	})
	.optional()
	.describe(
		'Optional media attachment (photo, audio, or document). Provide a public url OR base64Data.',
	);

export function registerNotificationTools(server: McpServer): void {
	server.registerTool(
		'send_telegram_notification',
		{
			description:
				'Send a notification to the configured Telegram chat. Supports text-only or media (photo/audio/document) with an optional caption.',
			inputSchema: {
				disableNotification: z.boolean().optional(),
				message: z
					.string()
					.max(3500, 'Message is too long for Telegram.')
					.optional()
					.describe('Text body (or caption when media is attached). Required if no media is provided.'),
				parseMode: z
					.enum(['HTML', 'Markdown', 'MarkdownV2'])
					.optional(),
				media: mediaSchema,
			},
		},
		async ({ disableNotification, message, parseMode, media }) => {
			if (!media && !message) {
				return {
					content: [{ type: 'text', text: 'Either message or media must be provided.' }],
					isError: true,
				};
			}

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
				let result: { messageId?: number; ok: boolean; statusCode: number };

				if (media) {
					result = await sendTelegramMedia(config, {
						media: media as MediaPayload,
						caption: message,
						parseMode,
						disableNotification,
					});
				} else {
					result = await sendTelegramMessage(config, {
						disableNotification,
						message: message as string,
						parseMode,
					});
				}

				const kind = media ? `${media.type} notification` : 'Notification';
				return {
					content: [
						{
							type: 'text',
							text: `${kind} sent to Telegram (status ${result.statusCode}${result.messageId ? `, message_id=${result.messageId}` : ''}).`,
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
