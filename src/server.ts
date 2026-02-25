import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";

export function createServer(): McpServer {
  return new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        logging: {},
      },
      instructions:
        "If user asks to install/configure this MCP, execute onboarding tools (do not only describe). First ensure MCP is active in client, then run telegram_onboarding_prepare, request setup code message in bot chat, run telegram_onboarding_verify to collect candidates, ask user to confirm expected chat_id, then finalize verification and optional test notification.",
    },
  );
}
