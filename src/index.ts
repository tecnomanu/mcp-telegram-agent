#!/usr/bin/env node
import { randomUUID } from "node:crypto";
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

type StartCommand = {
  isStart: boolean;
  payload?: string;
};

type OnboardingMatch = {
  chatId: string;
  messageId?: number;
  text?: string;
  updateId: number;
  username?: string;
};

const SERVER_NAME = "telegram-agent";
const SERVER_VERSION = "0.1.0";
const TELEGRAM_API_BASE_URL_DEFAULT = "https://api.telegram.org";

function parseTimeoutMs(rawTimeoutMs: string | undefined): { timeoutMs?: number; error?: string } {
  const timeoutMs = Number.parseInt(rawTimeoutMs?.trim() || "10000", 10);
  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    return {
      error:
        "Invalid BOT_TELEGRAM_TIMEOUT_MS. Use a positive integer (milliseconds).",
    };
  }
  return { timeoutMs };
}

function getTelegramApiBaseUrl(): string {
  const baseUrl = process.env.BOT_TELEGRAM_API_BASE_URL?.trim();
  if (!baseUrl) {
    return TELEGRAM_API_BASE_URL_DEFAULT;
  }
  return baseUrl.replace(/\/+$/, "");
}

function buildTelegramMethodUrl(token: string, method: string): string {
  return `${getTelegramApiBaseUrl()}/bot${token}/${method}`;
}

function buildTelegramConfigFromToken(
  token: string,
  chatId: string,
  timeoutMs: number,
  threadId?: number,
): TelegramConfig {
  return {
    chatId,
    token,
    timeoutMs,
    threadId,
    url: buildTelegramMethodUrl(token, "sendMessage"),
  };
}

function maskToken(token: string): string {
  if (token.length <= 10) {
    return "**********";
  }
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function parseStartCommand(text: string | undefined): StartCommand {
  if (!text) {
    return { isStart: false };
  }

  const match = text.match(/^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/);
  if (!match) {
    return { isStart: false };
  }

  const payload = match[1]?.trim();
  return {
    isStart: true,
    payload: payload && payload.length > 0 ? payload : undefined,
  };
}

function generateSetupCode(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

function buildMcpConfigSnippet(
  packageName: string,
  serverName: string,
  token: string,
  chatId: string,
): string {
  return JSON.stringify(
    {
      mcpServers: {
        [serverName]: {
          command: "npx",
          args: ["-y", packageName],
          env: {
            BOT_TELEGRAM_TOKEN: token,
            BOT_TELEGRAM_CHAT_ID: chatId,
          },
        },
      },
    },
    null,
    2,
  );
}

function findOnboardingMessageMatch(
  updates: TelegramUpdate[],
  setupCode: string,
): OnboardingMatch | null {
  const normalizedCode = setupCode.trim();
  for (const item of [...updates].reverse()) {
    const message = item.message;
    const rawText = message?.text?.trim() || "";
    const isExactCodeMessage = rawText === normalizedCode;
    const start = parseStartCommand(message?.text);
    const payload = start.payload || "";
    const isStartWithCode =
      start.isStart &&
      (payload === normalizedCode ||
        payload.split(/\s+/).includes(normalizedCode));

    if (!isExactCodeMessage && !isStartWithCode) {
      continue;
    }

    const chatId = message?.chat?.id;
    if (typeof chatId !== "number") {
      continue;
    }

    return {
      chatId: String(chatId),
      messageId: message?.message_id,
      text: message?.text,
      updateId: item.update_id,
      username: message?.chat?.username,
    };
  }
  return null;
}

function buildTelegramConfig(): { config?: TelegramConfig; error?: string } {
  const token = process.env.BOT_TELEGRAM_TOKEN?.trim();
  const urlFromEnv = process.env.BOT_TELEGRAM_URL?.trim();
  const chatId =
    process.env.BOT_TELEGRAM_CHAT_ID?.trim() ||
    process.env.BOT_TELEGRAM_ID?.trim();
  const timeoutResult = parseTimeoutMs(process.env.BOT_TELEGRAM_TIMEOUT_MS);
  const timeoutMs = timeoutResult.timeoutMs;
  const threadIdRaw = process.env.BOT_TELEGRAM_THREAD_ID?.trim();
  const threadId = threadIdRaw ? Number.parseInt(threadIdRaw, 10) : undefined;

  if (!chatId) {
    return {
      error:
        "Missing chat ID. Set BOT_TELEGRAM_CHAT_ID or BOT_TELEGRAM_ID in the MCP server env config.",
    };
  }

  if (!timeoutMs) {
    return { error: timeoutResult.error };
  }

  if (threadIdRaw && Number.isNaN(threadId)) {
    return {
      error:
        "Invalid BOT_TELEGRAM_THREAD_ID. Use an integer topic/thread ID.",
    };
  }

  if (token) {
    return {
      config: buildTelegramConfigFromToken(token, chatId, timeoutMs, threadId),
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
      `${buildTelegramMethodUrl(token, "getUpdates")}?limit=${limit}`,
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
  "telegram_onboarding_prepare",
  "Prepare onboarding instructions to link a Telegram bot and auto-generate MCP config.",
  {
    botToken: z.string().min(10, "botToken is too short."),
    packageName: z.string().min(1).max(120).default("mcp-telegram-agent"),
    serverName: z.string().min(1).max(120).default("telegram-agent"),
    setupCode: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  },
  async ({ botToken, packageName, serverName, setupCode }) => {
    const code = setupCode || generateSetupCode();
    const masked = maskToken(botToken.trim());

    const guidance = [
      "Onboarding prepared successfully.",
      `Token received (masked): ${masked}`,
      `Setup code: ${code}`,
      "",
      "If you still need a bot, create it first via BotFather: https://telegram.me/BotFather#",
      "",
      "Next steps:",
      "1) Press Start in your bot chat if not started yet.",
      `2) Send exactly this message to your bot chat: ${code}`,
      "3) Confirm to your agent that you already sent it.",
      "Note: /start <code> also works, but plain code is recommended.",
      `4) Then call tool telegram_onboarding_verify with botToken + setupCode=${code}.`,
      "",
      "Target MCP config template (chat ID will be auto-detected in verify step):",
      "```json",
      buildMcpConfigSnippet(
        packageName,
        serverName,
        "<YOUR_BOT_TOKEN>",
        "<CHAT_ID_FROM_VERIFY>",
      ),
      "```",
    ].join("\n");

    return {
      content: [{ type: "text", text: guidance }],
    };
  },
);

server.tool(
  "telegram_onboarding_verify",
  "Verify /start <setupCode> in Telegram updates, discover chat_id, generate ready MCP config, and optionally send a test message.",
  {
    botToken: z.string().min(10, "botToken is too short."),
    limit: z.number().int().min(1).max(100).default(60),
    packageName: z.string().min(1).max(120).default("mcp-telegram-agent"),
    sendTestMessage: z.boolean().default(true),
    serverName: z.string().min(1).max(120).default("telegram-agent"),
    setupCode: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    testMessage: z.string().min(1).max(3500).optional(),
  },
  async ({
    botToken,
    limit,
    packageName,
    sendTestMessage,
    serverName,
    setupCode,
    testMessage,
  }) => {
    const timeoutResult = parseTimeoutMs(process.env.BOT_TELEGRAM_TIMEOUT_MS);
    if (!timeoutResult.timeoutMs) {
      return {
        content: [{ type: "text", text: `Invalid configuration: ${timeoutResult.error}` }],
        isError: true,
      };
    }

    try {
      const normalizedToken = botToken.trim();
      const updates = await getTelegramUpdates(
        normalizedToken,
        timeoutResult.timeoutMs,
        limit,
      );
      const match = findOnboardingMessageMatch(updates, setupCode);

      if (!match) {
        return {
          content: [
            {
              type: "text",
              text: `No matching setup code "${setupCode}" found in the last ${limit} updates. Send exactly "${setupCode}" (or "/start ${setupCode}") to your bot and retry.`,
            },
          ],
          isError: true,
        };
      }

      const configJson = buildMcpConfigSnippet(
        packageName,
        serverName,
        normalizedToken,
        match.chatId,
      );

      let testStatus = "Skipped";
      if (sendTestMessage) {
        const config = buildTelegramConfigFromToken(
          normalizedToken,
          match.chatId,
          timeoutResult.timeoutMs,
        );
        const text =
          testMessage ||
          `✅ MCP Telegram Agent linked successfully.\nsetup_code=${setupCode}`;
        const sent = await sendTelegramMessage(config, { message: text });
        testStatus = `Sent (status ${sent.statusCode}${sent.messageId ? `, message_id=${sent.messageId}` : ""})`;
      }

      const responseText = [
        "Onboarding verified successfully.",
        `chat_id=${match.chatId}`,
        `message_id=${match.messageId ?? "n/a"}`,
        `update_id=${match.updateId}`,
        `username=${match.username ?? "n/a"}`,
        `test_message=${testStatus}`,
        "",
        "Use this MCP config:",
        "```json",
        configJson,
        "```",
      ].join("\n");

      return {
        content: [{ type: "text", text: responseText }],
      };
    } catch (err) {
      const messageText =
        err instanceof Error ? err.message : "Unknown error while verifying onboarding.";
      return {
        content: [{ type: "text", text: `Failed onboarding verification: ${messageText}` }],
        isError: true,
      };
    }
  },
);

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
    botToken: z.string().min(10).optional(),
    limit: z.number().int().min(1).max(100).default(10),
  },
  async ({ botToken, limit }) => {
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
      const updates = await getTelegramUpdates(tokenToUse, timeoutToUse, limit);
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
