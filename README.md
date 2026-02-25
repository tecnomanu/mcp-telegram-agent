> 🤖 **If you are an AI agent:** read [AGENTS.md](./AGENTS.md) first, then [AGENT_SETUP.md](./AGENT_SETUP.md).

# 🤖 MCP Telegram Agent

Send Telegram notifications directly from any MCP-compatible AI agent.

This project is a **TypeScript MCP server** over `stdio`, designed to be easy to run locally and easy to distribute via **npm + npx**.

## ✨ Features

- ✅ Send a message to Telegram with one MCP tool call
- ✅ Guided onboarding flow: token → `setup code` verification → auto config snippet
- ✅ Validate Telegram config before sending anything
- ✅ Read recent Telegram updates to discover `chat_id` and `message_id`
- ✅ Works with `npx mcp-telegram-agent` in MCP config
- ✅ Token-first setup (safer than hardcoding full API URL)

## 📦 Installation

### Option A: Use directly with npx (recommended for MCP clients)

No local clone required in production:

```bash
npx -y mcp-telegram-agent
```

### Option B: Local development

```bash
npm install
npm run check
npm run build
npm run dev
```

## 🔧 Environment Variables

### Recommended (default behavior)

- `BOT_TELEGRAM_TOKEN` (required)
- `BOT_TELEGRAM_CHAT_ID` (required)

### Compatibility aliases

- `BOT_TELEGRAM_ID` (alias for chat ID)
- `BOT_TELEGRAM_URL` (legacy fallback, full sendMessage URL)

### Optional

- `BOT_TELEGRAM_TIMEOUT_MS` (default: `10000`)
- `BOT_TELEGRAM_THREAD_ID` (for Telegram forum topics)
- `BOT_TELEGRAM_API_BASE_URL` (advanced/testing override, default: `https://api.telegram.org`)

> Security note: Prefer `BOT_TELEGRAM_TOKEN` over `BOT_TELEGRAM_URL` so your secret is managed as a single token value.

## 🧠 MCP Client Configuration

### npx setup (recommended)

```json
{
  "mcpServers": {
    "telegram-agent": {
      "command": "npx",
      "args": ["-y", "mcp-telegram-agent"],
      "env": {
        "BOT_TELEGRAM_TOKEN": "123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "BOT_TELEGRAM_CHAT_ID": "889721252"
      }
    }
  }
}
```

### Local build setup

```json
{
  "mcpServers": {
    "telegram-agent": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/mcp_telegram_agent/dist/index.js"],
      "env": {
        "BOT_TELEGRAM_TOKEN": "123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "BOT_TELEGRAM_CHAT_ID": "889721252"
      }
    }
  }
}
```

## 🛠️ Exposed MCP Tools

### `telegram_onboarding_prepare`

Prepares onboarding for a fresh token and returns:
- a setup code
- exact message to send (plain setup code)
- MCP config template
- if `botToken` is omitted and client supports elicitation, MCP requests secure token input UI

### `telegram_onboarding_verify`

Verifies onboarding by scanning updates for the setup code (plain message, or `/start <code>`) and then:
- discovers `chat_id` + `message_id`
- builds a ready-to-paste MCP config JSON
- optionally sends a test message automatically
- supports cautious mode with explicit `chat_id` confirmation (`requireChatIdConfirmation` + `expectedChatId`)
- if `botToken` is omitted and client supports elicitation, MCP requests secure token input UI

### `send_telegram_notification`

Send a message to your configured Telegram chat.

Input:
- `message` (string, required)
- `parseMode` (`HTML` | `Markdown` | `MarkdownV2`, optional)
- `disableNotification` (boolean, optional)

Output example:
- `Notification sent to Telegram (status 200, message_id=207).`

### `telegram_config_status`

Validate env config and show active source (`BOT_TELEGRAM_TOKEN` vs `BOT_TELEGRAM_URL`).

### `telegram_get_updates`

Fetch recent updates from Telegram to inspect:
- `chat_id`
- `message_id`
- message text
- username

Useful when you are still wiring your bot and need IDs.

## 🧭 Agent Command (`/setup-mcp-telegram-agent`)

This repository ships:
- `AGENTS.md`
- `AGENT_SETUP.md`
- `.cursor/commands/setup-mcp-telegram-agent.md`

Suggested chat command:

```text
/setup-mcp-telegram-agent
```

Expected flow:
1. Install/activate MCP first with `npx -y mcp-telegram-agent` (no token required yet)
2. Ask for bot token (or direct user to create one at `https://telegram.me/BotFather#`)
3. Run `telegram_onboarding_prepare`
4. Ask user to send `<code>` (plain message) to the bot
5. Run `telegram_onboarding_verify` in confirmation mode to list candidates
6. Ask user to confirm exact `chat_id`
7. Run `telegram_onboarding_verify` again with `expectedChatId`
8. Apply generated MCP config
9. Send one test notification

## 📲 Telegram Bot Setup (BotFather)

### 1) Open BotFather

Search for **@BotFather** in Telegram and open it.

![BotFather setup example](docs/images/botfather-start.svg)

### 2) Create a new bot

Send:

```text
/newbot
```

Then follow prompts:
1. Bot display name (example: `My MCP Notifier`)
2. Bot username ending in `bot` (example: `my_mcp_notifier_bot`)

BotFather returns your token:

```text
123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Save it securely as `BOT_TELEGRAM_TOKEN`.

### 3) Start a chat with your bot

Open your new bot and click **Start** (or send any message).

### 4) Get your `chat_id` and `message_id`

Call:

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates"
```

Then look for:
- `message.chat.id` → this is your `chat_id`
- `message.message_id` → this is the message ID

Visual guide:

![Get chat id and message id](docs/images/get-chat-id.svg)

## 🧪 Quick Test

Use your real values:

```bash
curl -sS -X POST "https://api.telegram.org/bot<YOUR_TOKEN>/sendMessage" \
  -H "Content-Type: application/json" \
  -d '{"chat_id":"<YOUR_CHAT_ID>","text":"✅ MCP test message"}'
```

## 🚀 Publish to npm

Publishing is automated with GitHub Actions + `semantic-release`.

After the first release, users can run:

```bash
npx -y mcp-telegram-agent
```

## ⚙️ GitHub Actions Auto Publish

This repository includes:
- `.github/workflows/release.yml`
- `.releaserc.json`

Behavior:
1. Runs on each push to `main`
2. Uses Conventional Commits to decide release type (`fix` = patch, `feat` = minor, `BREAKING CHANGE` = major)
3. Creates GitHub release + publishes to npm

Required GitHub secret:
- `NPM_TOKEN` (npm automation token with publish permissions)

Required commit style examples:

```bash
fix: first automated release setup
feat: add support for telegram topics
```

First release target (`v0.0.1`):
1. Create and push baseline tag `v0.0.0` once.
2. Push a `fix:` commit to `main`.
3. Action will publish `v0.0.1`.

Commands:

```bash
git tag v0.0.0
git push origin v0.0.0
git commit --allow-empty -m "fix: bootstrap first semantic release"
git push origin main
```

## 🧩 GitHub Repository Setup

If this is a fresh local directory:

```bash
git init
git add .
git commit -m "Initial MCP telegram agent server"
git branch -M main
git remote add origin https://github.com/tecnomanu/mcp-telegram-agent.git
git push -u origin main
```

## ⚠️ Troubleshooting

- `chat not found`:
  - Ensure you started chat with the bot first.
  - Re-check `BOT_TELEGRAM_CHAT_ID` from `getUpdates`.
- `401 Unauthorized`:
  - Token is invalid, regenerated, or malformed.
- No updates in `getUpdates`:
  - Send a message to your bot, then retry.

## 📄 License

MIT
