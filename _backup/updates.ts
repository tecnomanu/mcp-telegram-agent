import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildTelegramConfig, getTelegramUpdates, parseTimeoutMs } from "../telegram.js";

export function registerUpdatesTools(server: McpServer): void {
  server.registerTool(
    "telegram_get_updates",
    {
      description: "Get recent Telegram updates to discover chat_id and message_id.",
      inputSchema: {
        botToken: z.string().min(10).optional(),
        fromUpdateId: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).default(10),
        waitSeconds: z.number().int().min(0).max(50).default(0),
      },
    },
    async ({ botToken, fromUpdateId, limit, waitSeconds }) => {
      let tokenToUse: string | undefined;
      let timeoutToUse: number | undefined;

      if (botToken) {
        tokenToUse = botToken.trim();
        const timeoutResult = parseTimeoutMs(process.env.BOT_TELEGRAM_TIMEOUT_MS);
        timeoutToUse = timeoutResult.timeoutMs;
        if (!timeoutToUse) {
          return {
            content: [{ type: "text", text: `Invalid configuration: ${timeoutResult.error}` }],
            isError: true,
          };
        }
      } else {
        const { config, error } = buildTelegramConfig();
        if (!config) {
          return {
            content: [{ type: "text", text: `Invalid configuration: ${error}` }],
            isError: true,
          };
        }

        if (!config.token) {
          return {
            content: [
              {
                type: "text",
                text: "telegram_get_updates requires BOT_TELEGRAM_TOKEN (not only BOT_TELEGRAM_URL).",
              },
            ],
            isError: true,
          };
        }
        tokenToUse = config.token;
        timeoutToUse = config.timeoutMs;
      }

      try {
        const updates = await getTelegramUpdates(tokenToUse, timeoutToUse, limit, {
          offset:
            typeof fromUpdateId === "number" ? fromUpdateId + 1 : undefined,
          waitSeconds,
        });
        if (updates.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No updates found. Send a message to your bot in Telegram and run this tool again.",
              },
            ],
          };
        }

        const summary = updates
          .map((item) => {
            const chatId = item.message?.chat?.id;
            const messageId = item.message?.message_id;
            const username = item.message?.chat?.username;
            const text = item.message?.text;
            return `update_id=${item.update_id}, chat_id=${chatId ?? "n/a"}, message_id=${messageId ?? "n/a"}, username=${username ?? "n/a"}, text=${text ?? "n/a"}`;
          })
          .join("\n");

        return {
          content: [{ type: "text", text: summary }],
        };
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : "Unknown error while reading updates.";
        return {
          content: [{ type: "text", text: `Failed to read updates: ${messageText}` }],
          isError: true,
        };
      }
    },
  );
}
