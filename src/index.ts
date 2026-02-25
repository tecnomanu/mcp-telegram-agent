#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type TelegramConfig = {
  chatId: string;
  token?: string;
  timeoutMs: number;
  threadId?: number;
  url: string;
};

type TelegramApiResponse = {
  ok: boolean;
  description?: string;
  result?: {
    message_id?: number;
  };
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: {
      id?: number;
      type?: string;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
  };
};

const SERVER_NAME = "telegram-agent";
const SERVER_VERSION = "0.1.0";

function buildTelegramConfig(): { config?: TelegramConfig; error?: string } {
  const token = process.env.BOT_TELEGRAM_TOKEN?.trim();
  const urlFromEnv = process.env.BOT_TELEGRAM_URL?.trim();
  const chatId =
    process.env.BOT_TELEGRAM_CHAT_ID?.trim() ||
    process.env.BOT_TELEGRAM_ID?.trim();
  const timeoutMs = Number.parseInt(
    process.env.BOT_TELEGRAM_TIMEOUT_MS?.trim() || "10000",
    10,
  );
  const threadIdRaw = process.env.BOT_TELEGRAM_THREAD_ID?.trim();
  const threadId = threadIdRaw ? Number.parseInt(threadIdRaw, 10) : undefined;

  if (!chatId) {
    return {
      error:
        "Missing chat ID. Set BOT_TELEGRAM_CHAT_ID or BOT_TELEGRAM_ID in the MCP server env config.",
    };
  }

  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    return {
      error:
        "Invalid BOT_TELEGRAM_TIMEOUT_MS. Use a positive integer (milliseconds).",
    };
  }

  if (threadIdRaw && Number.isNaN(threadId)) {
    return {
      error:
        "Invalid BOT_TELEGRAM_THREAD_ID. Use an integer topic/thread ID.",
    };
  }

  if (token) {
    return {
      config: {
        chatId,
        token,
        timeoutMs,
        threadId,
        url: `https://api.telegram.org/bot${token}/sendMessage`,
      },
    };
  }

  if (urlFromEnv) {
    return {
      config: {
        chatId,
        timeoutMs,
        threadId,
        url: urlFromEnv,
      },
    };
  }

  if (!token && !urlFromEnv) {
    return {
      error:
        "Missing Telegram endpoint. Set BOT_TELEGRAM_TOKEN (recommended) or BOT_TELEGRAM_URL in the MCP server env config.",
    };
  }
  return { error: "Invalid Telegram configuration." };
}

async function sendTelegramMessage(
  config: TelegramConfig,
  payload: {
    disableNotification?: boolean;
    message: string;
    parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  },
): Promise<{ messageId?: number; ok: boolean; statusCode: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: config.chatId,
        disable_notification: payload.disableNotification ?? false,
        message_thread_id: config.threadId,
        parse_mode: payload.parseMode,
        text: payload.message,
      }),
      signal: controller.signal,
    });

    const rawBody = await response.text();
    let jsonBody: TelegramApiResponse | null = null;

    if (rawBody) {
      try {
        jsonBody = JSON.parse(rawBody) as TelegramApiResponse;
      } catch {
        if (!response.ok) {
          throw new Error(
            `Telegram returned status ${response.status} and a non-JSON body.`,
          );
        }
      }
    }

    if (!response.ok) {
      const description = jsonBody?.description || "Unknown Telegram API error.";
      throw new Error(`Telegram API error (${response.status}): ${description}`);
    }

    if (jsonBody && !jsonBody.ok) {
      throw new Error(
        `Telegram API rejected the message: ${jsonBody.description || "Unknown error."}`,
      );
    }

    return {
      messageId: jsonBody?.result?.message_id,
      ok: true,
      statusCode: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getTelegramUpdates(
  token: string,
  timeoutMs: number,
  limit: number,
): Promise<TelegramUpdate[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?limit=${limit}`,
      {
        method: "GET",
        signal: controller.signal,
      },
    );

    const bodyText = await response.text();
    let parsed: { ok?: boolean; result?: TelegramUpdate[]; description?: string } = {};
    if (bodyText) {
      parsed = JSON.parse(bodyText) as {
        ok?: boolean;
        result?: TelegramUpdate[];
        description?: string;
      };
    }

    if (!response.ok || !parsed.ok) {
      throw new Error(
        `Telegram getUpdates failed (${response.status}): ${parsed.description || "Unknown error."}`,
      );
    }

    return parsed.result || [];
  } finally {
    clearTimeout(timeout);
  }
}

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

server.tool(
  "send_telegram_notification",
  "Send a simple notification message to the configured Telegram chat.",
  {
    disableNotification: z.boolean().optional(),
    message: z
      .string()
      .min(1, "Message cannot be empty.")
      .max(3500, "Message is too long for Telegram."),
    parseMode: z.enum(["HTML", "Markdown", "MarkdownV2"]).optional(),
  },
  async ({ disableNotification, message, parseMode }) => {
    const { config, error } = buildTelegramConfig();

    if (!config) {
      return {
        content: [{ type: "text", text: `Configuration error: ${error}` }],
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
            type: "text",
            text: `Notification sent to Telegram (status ${result.statusCode}${result.messageId ? `, message_id=${result.messageId}` : ""}).`,
          },
        ],
      };
    } catch (err) {
      const messageText =
        err instanceof Error ? err.message : "Unknown error while sending message.";
      return {
        content: [{ type: "text", text: `Failed to send Telegram message: ${messageText}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "telegram_get_updates",
  "Get recent Telegram updates to discover chat_id and message_id.",
  {
    limit: z.number().int().min(1).max(100).default(10),
  },
  async ({ limit }) => {
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

    try {
      const updates = await getTelegramUpdates(config.token, config.timeoutMs, limit);
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

server.tool(
  "telegram_config_status",
  "Check whether Telegram configuration is valid for this MCP server.",
  {},
  async () => {
    const { config, error } = buildTelegramConfig();
    if (!config) {
      return {
        content: [{ type: "text", text: `Invalid configuration: ${error}` }],
        isError: true,
      };
    }

    const urlSource = process.env.BOT_TELEGRAM_TOKEN
      ? "BOT_TELEGRAM_TOKEN"
      : "BOT_TELEGRAM_URL";

    return {
      content: [
        {
          type: "text",
          text: `Configuration is valid. URL source: ${urlSource}. Chat ID configured: ${config.chatId}. Timeout: ${config.timeoutMs}ms.`,
        },
      ],
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${SERVER_NAME}] fatal error: ${message}`);
  process.exit(1);
});
