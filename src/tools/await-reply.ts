import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SERVER_NAME } from "../constants.js";
import {
  buildTelegramConfig,
  getTelegramUpdates,
  sendTelegramMessage,
} from "../telegram.js";
import { getLastUpdateId, setLastUpdateId } from "./polling.js";

const DEFAULT_WAIT_TIMEOUT_S = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerAwaitReplyTools(server: McpServer): void {
  server.registerTool(
    "telegram_send_and_wait_reply",
    {
      description: [
        "Send a message to Telegram and block until a reply arrives in the same chat.",
        "Returns the reply text so you can act on it.",
      ].join(" "),
      inputSchema: {
        message: z.string().min(1).describe("Message text to send"),
        waitTimeoutSeconds: z
          .number()
          .min(10)
          .max(600)
          .default(DEFAULT_WAIT_TIMEOUT_S)
          .optional()
          .describe("Max seconds to wait for a reply (default 120)"),
        parseMode: z.enum(["HTML", "Markdown", "MarkdownV2"]).optional(),
      },
    },
    async ({ message, waitTimeoutSeconds, parseMode }) => {
      const { config, error } = buildTelegramConfig();
      if (!config?.token) {
        return {
          content: [
            {
              type: "text",
              text: `Config error: ${error ?? "BOT_TELEGRAM_TOKEN required"}`,
            },
          ],
          isError: true,
        };
      }

      const token = config.token;
      const chatId = config.chatId;
      const timeoutMs = config.timeoutMs;
      const maxWaitMs = (waitTimeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_S) * 1000;

      const sendResult = await sendTelegramMessage(config, {
        message,
        parseMode,
      });

      if (!sendResult.ok || !sendResult.messageId) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to send message (status=${sendResult.statusCode})`,
            },
          ],
          isError: true,
        };
      }

      const sentMsgId = sendResult.messageId;
      console.error(
        `[${SERVER_NAME}] Sent msg_id=${sentMsgId}, waiting up to ${maxWaitMs / 1000}s for reply...`,
      );

      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        try {
          const currentOffset = getLastUpdateId();
          const updates = await getTelegramUpdates(token, timeoutMs, 10, {
            offset: currentOffset > 0 ? currentOffset + 1 : undefined,
            waitSeconds: 5,
          });

          for (const update of updates) {
            if (update.update_id > getLastUpdateId()) {
              setLastUpdateId(update.update_id);
            }

            const msg = update.message;
            if (!msg || String(msg.chat?.id) !== chatId) continue;

            const isDirectReply =
              msg.reply_to_message?.message_id === sentMsgId;
            const isNewMessage =
              msg.message_id !== undefined && msg.message_id > sentMsgId;

            if (isDirectReply || isNewMessage) {
              const replyText = msg.text ?? "(no text)";
              const from =
                msg.chat?.username ?? msg.chat?.first_name ?? "unknown";

              console.error(
                `[${SERVER_NAME}] Reply from ${from}: "${replyText.slice(0, 80)}"`,
              );

              return {
                content: [
                  {
                    type: "text",
                    text: [
                      `reply_from: ${from}`,
                      `chat_id: ${msg.chat?.id}`,
                      `is_direct_reply: ${isDirectReply}`,
                      `msg_id: ${msg.message_id}`,
                      `sent_msg_id: ${sentMsgId}`,
                      "",
                      replyText,
                    ].join("\n"),
                  },
                ],
              };
            }
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          console.error(`[${SERVER_NAME}] await-reply poll error: ${detail}`);
          await sleep(2000);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Timeout: no reply received within ${maxWaitMs / 1000}s (sent_msg_id=${sentMsgId}).`,
          },
        ],
      };
    },
  );
}
