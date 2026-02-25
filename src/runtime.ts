import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { extractTokenFromElicitationResult } from "./helpers.js";
import type { ResolveBotTokenResult } from "./types.js";

export async function resolveBotTokenWithElicitationFallback(
  server: McpServer,
  botToken: string | undefined,
): Promise<ResolveBotTokenResult> {
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
