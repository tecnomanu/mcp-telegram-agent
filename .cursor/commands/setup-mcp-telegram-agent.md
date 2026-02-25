# Setup MCP Telegram Agent

Run a complete onboarding flow for `mcp-telegram-agent`.

## Execute this checklist

1. Ask the user for `BOT_TELEGRAM_TOKEN`.
   - If they do not have a bot yet, send them to: `https://telegram.me/BotFather#`
2. Call tool `telegram_onboarding_prepare` using that token.
3. Extract `setupCode` from the tool output.
4. Ask the user to press Start if needed, then send `<setupCode>` as a plain message to their bot in Telegram.
5. Wait for user confirmation.
6. Call tool `telegram_onboarding_verify` with the same token and setup code.
7. Apply the returned MCP JSON snippet into the user's MCP config.
8. Confirm final status and run one test via `send_telegram_notification`.

## Output style

- Keep responses concise.
- Report exact `chat_id` and test result.
- Mask token when echoing it in chat output.
