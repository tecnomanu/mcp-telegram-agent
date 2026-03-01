import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SERVER_NAME } from "../constants.js";
import type { MediaPayload } from "../types.js";
import {
  buildTelegramConfig,
  editTelegramMessage,
  getTelegramUpdates,
  sendTelegramMedia,
  sendTelegramMessage,
} from "../telegram.js";
import { getLastUpdateId, setLastUpdateId } from "./polling.js";

const DEFAULT_WAIT_TIMEOUT_S = 18000; // 5 hours

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const mediaSchema = z
  .object({
    type: z.enum(["photo", "audio", "document"]).describe(
      "'photo' for images (jpg/png/gif/webp), 'audio' for music/voice (mp3/ogg/wav), 'document' for any file (pdf, zip, etc.).",
    ),
    url: z.string().optional().describe("Public URL pointing directly to the file. Telegram will download it."),
    base64Data: z.string().optional().describe("Base64-encoded file content. Use when the file is local or generated in-memory."),
    filename: z.string().optional().describe('Suggested filename (e.g. "report.pdf"). Recommended for documents and audio.'),
    mimeType: z.string().optional().describe('MIME type (e.g. "image/png", "audio/mpeg"). Recommended when using base64Data.'),
  })
  .refine((m) => m.url || m.base64Data, {
    message: "Media requires either 'url' or 'base64Data'.",
  })
  .optional()
  .describe(
    "Attach a photo, audio file, or document to the message. Supply either a public url OR base64Data (not both).",
  );

export function registerAwaitReplyTools(server: McpServer): void {
  server.registerTool(
    "telegram_send_and_wait_reply",
    {
      description: [
        "Send a message to Telegram and block until a reply arrives in the same chat.",
        "Supports: plain text, photo, audio, or document — with an optional caption.",
        "You can send text only, media only, or media + caption together.",
        "For media: provide a media object with type and either a public url or base64Data.",
        "Sends an instant ACK back to Telegram when a reply is received.",
        "Returns reply text + ack_message_id so you can later edit the ACK with your final response.",
      ].join(" "),
      inputSchema: {
        message: z
          .string()
          .max(3500)
          .optional()
          .describe("Message text to send (or caption when media is attached). Required if no media."),
        waitTimeoutSeconds: z
          .number()
          .min(10)
          .max(43200)
          .default(DEFAULT_WAIT_TIMEOUT_S)
          .optional()
          .describe("Max seconds to wait for a reply (default 18000 = 5h)"),
        parseMode: z.enum(["HTML", "Markdown", "MarkdownV2"]).optional(),
        ackText: z
          .string()
          .max(500)
          .default("✅ Recibido, procesando...")
          .optional()
          .describe("ACK message sent immediately upon receiving a reply"),
        media: mediaSchema,
      },
    },
    async ({ message, waitTimeoutSeconds, parseMode, ackText, media }) => {
      if (!media && !message) {
        return {
          content: [{ type: "text", text: "Either message or media must be provided." }],
          isError: true,
        };
      }

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

      let sendResult: { messageId?: number; ok: boolean; statusCode: number };

      if (media) {
        sendResult = await sendTelegramMedia(config, {
          media: media as MediaPayload,
          caption: message,
          parseMode,
        });
      } else {
        sendResult = await sendTelegramMessage(config, {
          message: message as string,
          parseMode,
        });
      }

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

              // Send instant ACK as reply to the user's message
              let ackMsgId: number | undefined;
              try {
                const ackResult = await sendTelegramMessage(config, {
                  message: ackText ?? "✅ Recibido, procesando...",
                  replyToMessageId: msg.message_id,
                });
                ackMsgId = ackResult.messageId;
                console.error(
                  `[${SERVER_NAME}] ACK sent (msg_id=${ackMsgId})`,
                );
              } catch {
                console.error(`[${SERVER_NAME}] ACK send failed`);
              }

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
                      `ack_message_id: ${ackMsgId ?? "n/a"}`,
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

  server.registerTool(
    "telegram_edit_message",
    {
      description:
        "Edit a previously sent Telegram message by its message_id. Use to replace the ACK with a final response.",
      inputSchema: {
        messageId: z.number().int().min(1).describe("ID of the message to edit"),
        text: z.string().min(1).max(4096).describe("New message text"),
        parseMode: z.enum(["HTML", "Markdown", "MarkdownV2"]).optional(),
      },
    },
    async ({ messageId, text, parseMode }) => {
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

      try {
        await editTelegramMessage(
          config.token,
          config.chatId,
          messageId,
          text,
          config.timeoutMs,
          parseMode,
        );
        return {
          content: [
            { type: "text", text: `Message ${messageId} edited successfully.` },
          ],
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text", text: `Failed to edit message: ${detail}` },
          ],
          isError: true,
        };
      }
    },
  );
}
