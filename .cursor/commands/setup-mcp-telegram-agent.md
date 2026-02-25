# Setup MCP Telegram Agent

Run a complete onboarding flow for `mcp-telegram-agent`.
Follow repository rules in `AGENTS.md` first.

## Execute this checklist

1. Ensure MCP server is installed/active first:
   - `command: npx`
   - `args: ["-y", "mcp-telegram-agent"]`
2. Ask the user for `BOT_TELEGRAM_TOKEN`.
   - If they do not have a bot yet, send them to: `https://telegram.me/BotFather#`
   - If client supports secure input (elicitation), you can omit token args and let MCP prompt it.
3. Call tool `telegram_onboarding_prepare` using that token.
4. Extract `setupCode` from the tool output.
5. Ask the user to press Start if needed, then send `<setupCode>` as a plain message to their bot in Telegram.
6. Wait for user confirmation.
7. Call tool `telegram_onboarding_verify` with:
   - same token + setupCode
   - `requireChatIdConfirmation=true`
   - no `expectedChatId` yet
8. Show candidates and ask user to confirm exact `chat_id`.
9. Call `telegram_onboarding_verify` again with confirmed `expectedChatId`.
10. Apply the returned MCP JSON snippet into the user's MCP config.
11. Confirm final status and run one test via `send_telegram_notification`.
12. Optional: send `telegram_send_control_checkpoint` so user can reply with continue/stop/rerun commands.

## Output style

- Keep responses concise.
- Report exact `chat_id` and test result.
- Mask token when echoing it in chat output.
