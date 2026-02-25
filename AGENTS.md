# MCP Telegram Agent - Agent Command Guide

This file defines a reusable command workflow for AI coding agents (Cursor, Claude Code, Codex, etc.).

## Command

Use this command in chat:

`/setup-mcp-telegram-agent`

## Goal

Install and configure `mcp-telegram-agent` for the current user with minimum manual work.

## Required tools from this MCP

- `telegram_onboarding_prepare`
- `telegram_onboarding_verify`

## Expected flow for the AI agent

1. Ask the user for a Telegram bot token.
   - If they do not have a bot yet, tell them to create it at: `https://telegram.me/BotFather#`
2. Call `telegram_onboarding_prepare` with:
   - `botToken` = user token
   - `serverName` = `telegram-agent` (or user preference)
   - `packageName` = `mcp-telegram-agent`
3. Read the returned setup code and ask user to send:
   - `<SETUP_CODE>` (plain message)
   - If needed, ask user to press Start first in Telegram.
4. Ask user to confirm they sent that command.
5. Call `telegram_onboarding_verify` with:
   - same `botToken`
   - same `setupCode`
   - `sendTestMessage = true`
6. Use the returned JSON snippet to update the user's MCP config file.
7. Confirm success and provide a short test prompt:
   - "send_telegram_notification with message='Hello from MCP'"

## Security rules for agents

- Never print full tokens in final output unless explicitly requested.
- Prefer masked output and write secrets only in config files.
- If verification fails, ask the user to resend `<SETUP_CODE>` exactly.

## Cursor-specific note

If using Cursor project slash commands, map this flow to:
- `.cursor/commands/setup-mcp-telegram-agent.md`
