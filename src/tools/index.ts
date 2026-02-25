import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAwaitReplyTools } from "./await-reply.js";
import { registerNotificationTools } from "./notifications.js";
import { registerOnboardingPrompt, registerOnboardingTools } from "./onboarding.js";

export function registerAll(server: McpServer): void {
  registerOnboardingPrompt(server);
  registerOnboardingTools(server);
  registerNotificationTools(server);
  registerAwaitReplyTools(server);
}
