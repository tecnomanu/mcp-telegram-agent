import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildCheckpointMessage,
  generateControlCode,
  parseControlAction,
  resolveAgentInstanceId,
} from "../helpers.js";
import { resolveRuntimeConfigForTools } from "../runtime.js";
import { getTelegramUpdates, sendTelegramMessage } from "../telegram.js";

export function registerControlTools(server: McpServer): void {
  server.registerTool(
    "telegram_send_control_checkpoint",
    {
      description:
        "Send a structured checkpoint message that users can reply to with control actions.",
      inputSchema: {
        botToken: z.string().min(10).optional(),
        chatId: z.string().min(1).optional(),
        controlCode: z
          .string()
          .min(3)
          .max(32)
          .regex(/^[A-Za-z0-9_-]+$/)
          .optional(),
        instanceId: z.string().min(2).max(80).optional(),
        parseMode: z.enum(["HTML", "Markdown", "MarkdownV2"]).optional(),
        sessionId: z.string().min(1).max(120).optional(),
        summary: z.string().min(1).max(3000),
        title: z.string().min(2).max(140),
      },
    },
    async ({
      botToken,
      chatId,
      controlCode,
      instanceId,
      parseMode,
      sessionId,
      summary,
      title,
    }) => {
      const resolvedInstance = resolveAgentInstanceId(instanceId);
      if (!resolvedInstance.value) {
        return {
          content: [{ type: "text", text: `Invalid instanceId: ${resolvedInstance.error}` }],
          isError: true,
        };
      }

      const runtime = await resolveRuntimeConfigForTools(server, { botToken, chatId });
      if (!runtime.resolved) {
        return {
          content: [{ type: "text", text: `Configuration error: ${runtime.error}` }],
          isError: true,
        };
      }
      const resolvedRuntime = runtime.resolved;

      const code = controlCode || generateControlCode();
      const message = buildCheckpointMessage({
        controlCode: code,
        instanceId: resolvedInstance.value,
        sessionId,
        summary,
        title,
      });

      try {
        const sent = await sendTelegramMessage(resolvedRuntime.config, {
          message,
          parseMode,
        });

        const responseText = [
          "Control checkpoint sent.",
          `chat_id=${resolvedRuntime.chatId}`,
          `message_id=${sent.messageId ?? "n/a"}`,
          `instance_id=${resolvedInstance.value}`,
          `control_code=${code}`,
          "Use telegram_poll_control_replies with these values.",
        ].join("\n");

        return {
          content: [{ type: "text", text: responseText }],
        };
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : "Unknown error while sending checkpoint.";
        return {
          content: [{ type: "text", text: `Failed to send control checkpoint: ${messageText}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "telegram_poll_control_replies",
    {
      description:
        "Poll Telegram replies for a checkpoint message and extract control actions (continue/stop/rerun/status).",
      inputSchema: {
        actionFilter: z.enum(["continue", "stop", "rerun", "status", "unknown"]).optional(),
        botToken: z.string().min(10).optional(),
        chatId: z.string().min(1).optional(),
        controlCode: z
          .string()
          .min(3)
          .max(32)
          .regex(/^[A-Za-z0-9_-]+$/),
        fromUpdateId: z.number().int().min(0).optional(),
        instanceId: z.string().min(2).max(80).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        replyToMessageId: z.number().int().min(1),
        requireReplyToMessage: z.boolean().default(true),
        waitSeconds: z.number().int().min(0).max(50).default(20),
      },
    },
    async ({
      actionFilter,
      botToken,
      chatId,
      controlCode,
      fromUpdateId,
      instanceId,
      limit,
      replyToMessageId,
      requireReplyToMessage,
      waitSeconds,
    }) => {
      const resolvedInstance = resolveAgentInstanceId(instanceId);
      if (!resolvedInstance.value) {
        return {
          content: [{ type: "text", text: `Invalid instanceId: ${resolvedInstance.error}` }],
          isError: true,
        };
      }

      const runtime = await resolveRuntimeConfigForTools(server, { botToken, chatId });
      if (!runtime.resolved) {
        return {
          content: [{ type: "text", text: `Configuration error: ${runtime.error}` }],
          isError: true,
        };
      }
      const resolvedRuntime = runtime.resolved;
      const instanceIdValue = resolvedInstance.value;

      try {
        const updates = await getTelegramUpdates(
          resolvedRuntime.token,
          resolvedRuntime.config.timeoutMs + waitSeconds * 1000 + 1000,
          limit,
          {
            offset:
              typeof fromUpdateId === "number" ? fromUpdateId + 1 : undefined,
            waitSeconds,
          },
        );

        let maxUpdateId = fromUpdateId ?? 0;
        for (const update of updates) {
          if (update.update_id > maxUpdateId) {
            maxUpdateId = update.update_id;
          }
        }

        const filtered = updates
          .map((update) => {
            const message = update.message;
            const text = message?.text?.trim();
            const chat = message?.chat;
            const chatIdMatches =
              typeof chat?.id === "number" &&
              String(chat.id) === resolvedRuntime.chatId;
            if (!chatIdMatches || !text) {
              return null;
            }

            if (
              requireReplyToMessage &&
              message?.reply_to_message?.message_id !== replyToMessageId
            ) {
              return null;
            }

            if (!text.includes(controlCode)) {
              return null;
            }

            const hasInstance = text.includes(instanceIdValue);
            const action = parseControlAction(text);
            if (actionFilter && action !== actionFilter) {
              return null;
            }

            return {
              action,
              chatId: resolvedRuntime.chatId,
              hasInstance,
              messageId: message?.message_id ?? null,
              text,
              updateId: update.update_id,
              username: chat?.username ?? null,
            };
          })
          .filter((item) => item !== null);

        const summaryLines = filtered.map((item) => {
          return `update_id=${item.updateId}, message_id=${item.messageId ?? "n/a"}, action=${item.action}, username=${item.username ?? "n/a"}, instance_match=${item.hasInstance}, text=${item.text}`;
        });

        const responseText = [
          `matches=${filtered.length}`,
          `next_from_update_id=${maxUpdateId}`,
          filtered.length > 0 ? "messages:" : "messages: (none)",
          ...summaryLines,
        ].join("\n");

        return {
          content: [{ type: "text", text: responseText }],
        };
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : "Unknown error while polling replies.";
        return {
          content: [{ type: "text", text: `Failed to poll control replies: ${messageText}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "telegram_ack_control_reply",
    {
      description:
        "Send an acknowledgement reply to a control message to confirm action status.",
      inputSchema: {
        botToken: z.string().min(10).optional(),
        chatId: z.string().min(1).optional(),
        replyToMessageId: z.number().int().min(1),
        status: z.enum(["accepted", "completed", "rejected", "needs_input"]),
        summary: z.string().min(1).max(2500),
        title: z.string().min(2).max(140),
      },
    },
    async ({ botToken, chatId, replyToMessageId, status, summary, title }) => {
      const runtime = await resolveRuntimeConfigForTools(server, { botToken, chatId });
      if (!runtime.resolved) {
        return {
          content: [{ type: "text", text: `Configuration error: ${runtime.error}` }],
          isError: true,
        };
      }
      const resolvedRuntime = runtime.resolved;

      const text = [`📌 ${title}`, `status=${status}`, summary].join("\n");

      try {
        const sent = await sendTelegramMessage(resolvedRuntime.config, {
          message: text,
          replyToMessageId,
        });
        return {
          content: [
            {
              type: "text",
              text: `Ack sent (status ${sent.statusCode}${sent.messageId ? `, message_id=${sent.messageId}` : ""}).`,
            },
          ],
        };
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : "Unknown error while sending ack.";
        return {
          content: [{ type: "text", text: `Failed to send ack: ${messageText}` }],
          isError: true,
        };
      }
    },
  );
}
