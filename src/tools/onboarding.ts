import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildMcpConfigSnippet,
  findOnboardingMessageMatches,
  formatOnboardingCandidates,
  generateSetupCode,
  maskToken,
} from "../helpers.js";
import { resolveBotTokenWithElicitationFallback } from "../runtime.js";
import {
  buildTelegramConfigFromToken,
  getTelegramUpdates,
  parseTimeoutMs,
  sendTelegramMessage,
} from "../telegram.js";

export function registerOnboardingPrompt(server: McpServer): void {
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
}

export function registerOnboardingTools(server: McpServer): void {
  server.registerTool(
    "telegram_onboarding_prepare",
    {
      description:
        "Prepare onboarding instructions to link a Telegram bot and auto-generate MCP config.",
      inputSchema: {
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
    },
    async ({ botToken, packageName, serverName, setupCode }) => {
      const resolvedToken = await resolveBotTokenWithElicitationFallback(
        server,
        botToken,
      );
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

  server.registerTool(
    "telegram_onboarding_verify",
    {
      description:
        "Verify setup code in Telegram updates, require explicit chat_id confirmation, generate ready MCP config, and optionally send a test message.",
      inputSchema: {
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
      const resolvedToken = await resolveBotTokenWithElicitationFallback(
        server,
        botToken,
      );
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
}
