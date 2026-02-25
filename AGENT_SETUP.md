# MCP Telegram Agent - Setup Command Guide

Reusable onboarding workflow for AI agents (Cursor, Codex, Claude Code, etc.).

## Command

Use this command in chat:

`/setup-mcp-telegram-agent`

## Goal

Install and configure `mcp-telegram-agent` for the user with minimum manual work.
Do not stop at explanation: execute the workflow.

## Required MCP Tools

- `telegram_onboarding_prepare`
- `telegram_onboarding_verify`

## Expected Flow for Agents

1. Ensure MCP is installed and active in the IDE/client first.
   - Minimal activation config (no token required yet):
   - `command: npx`
   - `args: ["-y", "mcp-telegram-agent"]`
2. Ask the user for a Telegram bot token.
   - If they do not have a bot yet, send them to: `https://telegram.me/BotFather#`
   - If client supports elicitation, you may call onboarding tool without `botToken` and let MCP request secure input.
   - If elicitation is not supported, request token in chat and pass `botToken` explicitly.
3. Call `telegram_onboarding_prepare` with:
   - `botToken` = user token
   - `serverName` = `telegram-agent` (or user preference)
   - `packageName` = `mcp-telegram-agent`
4. Read the returned setup code and ask user to:
   - press Start in the bot chat if needed
   - send `<SETUP_CODE>` as a plain message to the bot
5. Ask user to confirm they already sent that message.
6. Call `telegram_onboarding_verify` with:
   - same `botToken`
   - same `setupCode`
   - `requireChatIdConfirmation = true`
   - no `expectedChatId` yet (this returns chat candidates)
7. Ask user to confirm which `chat_id` to use.
8. Call `telegram_onboarding_verify` again with:
   - same `botToken`
   - same `setupCode`
   - `expectedChatId` = user-confirmed value
   - `sendTestMessage = true`
9. Use the returned JSON snippet to update the user's MCP config file.
10. Confirm success and suggest a quick test call.

## Optional Control Loop (Reply-Based)

After major checkpoints:
1. Send `telegram_send_control_checkpoint` with:
   - clear `title`
   - short `summary`
   - stable `instanceId` (for multi-IDE isolation)
   - generated or provided `controlCode`
2. Poll with `telegram_poll_control_replies` using:
   - `replyToMessageId`
   - `instanceId`
   - `controlCode`
   - `fromUpdateId` from previous poll
3. Execute mapped action and send result using `telegram_ack_control_reply`.

## Security Rules for Setup

- Never print full tokens unless user explicitly requests it.
- Prefer masked output in chat.
- If verification fails, ask user to resend `<SETUP_CODE>` exactly.
- Never auto-pick a `chat_id` without explicit user confirmation.
