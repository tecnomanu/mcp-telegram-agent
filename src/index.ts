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
    reply_to_message?: {
      message_id?: number;
      text?: string;
    };
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

type ControlAction = "continue" | "stop" | "rerun" | "status" | "unknown";

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

function extractTokenFromElicitationResult(
  content: Record<string, unknown> | undefined,
): string | undefined {
  const token = content?.botToken;
  if (typeof token !== "string") {
    return undefined;
  }
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

function generateControlCode(): string {
  return randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
}

function getDefaultAgentInstanceId(): string | undefined {
  return (
    process.env.MCP_AGENT_INSTANCE_ID?.trim() ||
    process.env.AGENT_INSTANCE_ID?.trim() ||
    undefined
  );
}

function resolveAgentInstanceId(instanceId: string | undefined): { value?: string; error?: string } {
  const resolved = instanceId?.trim() || getDefaultAgentInstanceId();
  if (!resolved) {
    return {
      error:
        "Missing instance identifier. Pass instanceId or set MCP_AGENT_INSTANCE_ID/AGENT_INSTANCE_ID.",
    };
  }
  return { value: resolved };
}

function parseControlAction(text: string | undefined): ControlAction {
  if (!text) {
    return "unknown";
  }
  const first = text.trim().split(/\s+/)[0]?.toLowerCase();
  if (!first) {
    return "unknown";
  }

  if (first === "continue" || first === "continuar" || first === "seguir") {
    return "continue";
  }
  if (first === "stop" || first === "detener" || first === "parar") {
    return "stop";
  }
  if (first === "rerun" || first === "retry" || first === "reintentar") {
    return "rerun";
  }
  if (first === "status" || first === "estado") {
    return "status";
  }
  return "unknown";
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

function findOnboardingMessageMatches(
  updates: TelegramUpdate[],
  setupCode: string,
): OnboardingMatch[] {
  const normalizedCode = setupCode.trim();
  const matches: OnboardingMatch[] = [];

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

    matches.push({
      chatId: String(chatId),
      messageId: message?.message_id,
      text: message?.text,
      updateId: item.update_id,
      username: message?.chat?.username,
    });
  }
  return matches;
}

function formatOnboardingCandidates(matches: OnboardingMatch[]): string {
  const unique = new Map<string, OnboardingMatch>();
  for (const match of matches) {
    if (!unique.has(match.chatId)) {
      unique.set(match.chatId, match);
    }
  }
  return [...unique.values()]
    .map((match) => {
      return `- chat_id=${match.chatId}, username=${match.username ?? "n/a"}, message_id=${match.messageId ?? "n/a"}, update_id=${match.updateId}, sample_text=${match.text ?? "n/a"}`;
    })
    .join("\n");
}

function buildCheckpointMessage(payload: {
  controlCode: string;
  instanceId: string;
  sessionId?: string;
  summary: string;
  title: string;
}): string {
  return [
    `🧭 ${payload.title}`,
    payload.summary,
    "",
    `instance_id=${payload.instanceId}`,
    `session_id=${payload.sessionId || "n/a"}`,
    `control_code=${payload.controlCode}`,
    "",
    "Reply to this message with:",
    `- continue ${payload.controlCode}`,
    `- stop ${payload.controlCode}`,
    `- rerun ${payload.controlCode}`,
    `- status ${payload.controlCode}`,
  ].join("\n");
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
    replyToMessageId?: number;
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
        reply_to_message_id: payload.replyToMessageId,
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
  options?: {
    offset?: number;
    waitSeconds?: number;
  },
): Promise<TelegramUpdate[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const search = new URLSearchParams();
    search.set("limit", String(limit));
    if (typeof options?.offset === "number") {
      search.set("offset", String(options.offset));
    }
    if (typeof options?.waitSeconds === "number") {
      search.set("timeout", String(options.waitSeconds));
    }
    const response = await fetch(
      `${buildTelegramMethodUrl(token, "getUpdates")}?${search.toString()}`,
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

type ResolvedRuntimeConfig = {
  chatId: string;
  config: TelegramConfig;
  token: string;
};

async function resolveRuntimeConfigForTools(args: {
  botToken?: string;
  chatId?: string;
}): Promise<{ resolved?: ResolvedRuntimeConfig; error?: string }> {
  const tokenResult = await resolveBotTokenWithElicitationFallback(args.botToken);
  if (tokenResult.mode === "missing") {
    return {
      error: tokenResult.reason,
    };
  }

  const timeoutResult = parseTimeoutMs(process.env.BOT_TELEGRAM_TIMEOUT_MS);
  if (!timeoutResult.timeoutMs) {
    return {
      error: timeoutResult.error,
    };
  }

  const chatId =
    args.chatId?.trim() ||
    process.env.BOT_TELEGRAM_CHAT_ID?.trim() ||
    process.env.BOT_TELEGRAM_ID?.trim();
  if (!chatId) {
    return {
      error:
        "Missing chat_id. Pass chatId to the tool or set BOT_TELEGRAM_CHAT_ID/BOT_TELEGRAM_ID.",
    };
  }

  const threadIdRaw = process.env.BOT_TELEGRAM_THREAD_ID?.trim();
  const threadId = threadIdRaw ? Number.parseInt(threadIdRaw, 10) : undefined;
  if (threadIdRaw && Number.isNaN(threadId)) {
    return {
      error:
        "Invalid BOT_TELEGRAM_THREAD_ID. Use an integer topic/thread ID.",
    };
  }

  const config = buildTelegramConfigFromToken(
    tokenResult.token,
    chatId,
    timeoutResult.timeoutMs,
    threadId,
  );
  return {
    resolved: {
      chatId,
      config,
      token: tokenResult.token,
    },
  };
}

const server = new McpServer(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    instructions:
      "If user asks to install/configure this MCP, execute onboarding tools (do not only describe). First ensure MCP is active in client, then run telegram_onboarding_prepare, request setup code message in bot chat, run telegram_onboarding_verify to collect candidates, ask user to confirm expected chat_id, then finalize verification and optional test notification.",
  },
);

async function resolveBotTokenWithElicitationFallback(
  botToken: string | undefined,
): Promise<
  | { mode: "provided" | "elicited"; token: string }
  | { mode: "missing"; reason: string }
> {
  const provided = botToken?.trim();
  if (provided && provided.length > 0) {
    return { mode: "provided", token: provided };
  }

  try {
    const result = await server.server.elicitInput({
      mode: "form",
      message:
        "Provide BOT_TELEGRAM_TOKEN to continue Telegram MCP onboarding. If you do not have one yet, create a bot at https://telegram.me/BotFather#",
      requestedSchema: {
        type: "object",
        properties: {
          botToken: {
            type: "string",
            title: "BOT_TELEGRAM_TOKEN",
            description: "Telegram bot token from BotFather.",
            minLength: 10,
          },
        },
        required: ["botToken"],
      },
    });

    if (result.action !== "accept") {
      return {
        mode: "missing",
        reason:
          "Token input was declined/cancelled. Please call again with botToken in chat parameters.",
      };
    }

    const token = extractTokenFromElicitationResult(result.content);
    if (!token) {
      return {
        mode: "missing",
        reason:
          "Invalid token from elicitation input. Please call again with botToken in chat parameters.",
      };
    }

    return { mode: "elicited", token };
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : "Client does not support elicitation.";
    return {
      mode: "missing",
      reason: `Elicitation unavailable (${detail}). Please provide botToken in the tool call.`,
    };
  }
}

server.registerPrompt(
  "agent-install-and-onboard",
  {
    title: "Install + Onboard MCP Telegram Agent",
    description:
      "Operational protocol for agents to install, activate, and execute secure onboarding with chat_id confirmation.",
  },
  async () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Agent protocol:",
            "1) Ensure MCP is installed and activated first (npx mcp-telegram-agent).",
            "2) Ask for bot token (or send user to https://telegram.me/BotFather#).",
            "3) Run telegram_onboarding_prepare.",
            "4) Ask user to send setup code as plain message in bot chat.",
            "5) Run telegram_onboarding_verify without expectedChatId to list candidates.",
            "6) Ask user to confirm exact chat_id.",
            "7) Run telegram_onboarding_verify again with expectedChatId and optional test message.",
            "8) Return final MCP config snippet.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.tool(
  "telegram_onboarding_prepare",
  "Prepare onboarding instructions to link a Telegram bot and auto-generate MCP config.",
  {
    botToken: z.string().min(10, "botToken is too short.").optional(),
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
    const resolvedToken = await resolveBotTokenWithElicitationFallback(botToken);
    if (resolvedToken.mode === "missing") {
      return {
        content: [
          {
            type: "text",
            text: [
              "Onboarding cannot continue without bot token.",
              resolvedToken.reason,
              "If you still need a bot, create it first via BotFather: https://telegram.me/BotFather#",
            ].join("\n"),
          },
        ],
        isError: true,
      };
    }

    const code = setupCode || generateSetupCode();
    const masked = maskToken(resolvedToken.token);
    const tokenSource =
      resolvedToken.mode === "elicited" ? "secure input prompt" : "tool arguments";

    const guidance = [
      "Onboarding prepared successfully.",
      `Token source: ${tokenSource}`,
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
  "Verify setup code in Telegram updates, require explicit chat_id confirmation, generate ready MCP config, and optionally send a test message.",
  {
    botToken: z.string().min(10, "botToken is too short.").optional(),
    expectedChatId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(60),
    packageName: z.string().min(1).max(120).default("mcp-telegram-agent"),
    requireChatIdConfirmation: z.boolean().default(true),
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
    expectedChatId,
    limit,
    packageName,
    requireChatIdConfirmation,
    sendTestMessage,
    serverName,
    setupCode,
    testMessage,
  }) => {
    const resolvedToken = await resolveBotTokenWithElicitationFallback(botToken);
    if (resolvedToken.mode === "missing") {
      return {
        content: [
          {
            type: "text",
            text: [
              "Onboarding verification cannot continue without bot token.",
              resolvedToken.reason,
              "You can create/retrieve token via BotFather: https://telegram.me/BotFather#",
            ].join("\n"),
          },
        ],
        isError: true,
      };
    }

    const timeoutResult = parseTimeoutMs(process.env.BOT_TELEGRAM_TIMEOUT_MS);
    if (!timeoutResult.timeoutMs) {
      return {
        content: [{ type: "text", text: `Invalid configuration: ${timeoutResult.error}` }],
        isError: true,
      };
    }

    try {
      const normalizedToken = resolvedToken.token;
      const updates = await getTelegramUpdates(
        normalizedToken,
        timeoutResult.timeoutMs,
        limit,
      );
      const matches = findOnboardingMessageMatches(updates, setupCode);

      if (matches.length === 0) {
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

      const selectedMatch = expectedChatId
        ? matches.find((match) => match.chatId === expectedChatId)
        : matches[0];

      if (expectedChatId && !selectedMatch) {
        const candidates = formatOnboardingCandidates(matches);
        return {
          content: [
            {
              type: "text",
              text: `Expected chat_id "${expectedChatId}" was not found for setup code "${setupCode}". Available candidates:\n${candidates}`,
            },
          ],
          isError: true,
        };
      }

      if (requireChatIdConfirmation && !expectedChatId) {
        const candidates = formatOnboardingCandidates(matches);
        return {
          content: [
            {
              type: "text",
              text: [
                `Setup code "${setupCode}" was found, but chat_id confirmation is required.`,
                "Candidate chats:",
                candidates,
                'Call telegram_onboarding_verify again with "expectedChatId" set to the confirmed chat ID.',
              ].join("\n"),
            },
          ],
        };
      }

      if (!selectedMatch) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to select a chat candidate for onboarding verification.",
            },
          ],
          isError: true,
        };
      }

      const configJson = buildMcpConfigSnippet(
        packageName,
        serverName,
        normalizedToken,
        selectedMatch.chatId,
      );

      let testStatus = "Skipped";
      if (sendTestMessage) {
        const config = buildTelegramConfigFromToken(
          normalizedToken,
          selectedMatch.chatId,
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
        `chat_id=${selectedMatch.chatId}`,
        `message_id=${selectedMatch.messageId ?? "n/a"}`,
        `update_id=${selectedMatch.updateId}`,
        `username=${selectedMatch.username ?? "n/a"}`,
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
  "telegram_send_control_checkpoint",
  "Send a structured checkpoint message that users can reply to with control actions.",
  {
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
    const instanceIdValue = resolvedInstance.value;

    const runtime = await resolveRuntimeConfigForTools({ botToken, chatId });
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
      const sent = await sendTelegramMessage(runtime.resolved.config, {
        message,
        parseMode,
      });

      const responseText = [
        "Control checkpoint sent.",
        `chat_id=${runtime.resolved.chatId}`,
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

server.tool(
  "telegram_poll_control_replies",
  "Poll Telegram replies for a checkpoint message and extract control actions (continue/stop/rerun/status).",
  {
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

    const runtime = await resolveRuntimeConfigForTools({ botToken, chatId });
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

server.tool(
  "telegram_ack_control_reply",
  "Send an acknowledgement reply to a control message to confirm action status.",
  {
    botToken: z.string().min(10).optional(),
    chatId: z.string().min(1).optional(),
    replyToMessageId: z.number().int().min(1),
    status: z.enum(["accepted", "completed", "rejected", "needs_input"]),
    summary: z.string().min(1).max(2500),
    title: z.string().min(2).max(140),
  },
  async ({ botToken, chatId, replyToMessageId, status, summary, title }) => {
    const runtime = await resolveRuntimeConfigForTools({ botToken, chatId });
    if (!runtime.resolved) {
      return {
        content: [{ type: "text", text: `Configuration error: ${runtime.error}` }],
        isError: true,
      };
    }

    const text = [
      `📌 ${title}`,
      `status=${status}`,
      summary,
    ].join("\n");

    try {
      const sent = await sendTelegramMessage(runtime.resolved.config, {
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

server.tool(
  "telegram_get_updates",
  "Get recent Telegram updates to discover chat_id and message_id.",
  {
    botToken: z.string().min(10).optional(),
    fromUpdateId: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(100).default(10),
    waitSeconds: z.number().int().min(0).max(50).default(0),
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
