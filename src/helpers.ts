import { randomUUID } from "node:crypto";
import type { OnboardingMatch, StartCommand, TelegramUpdate } from "./types.js";

export function extractTokenFromElicitationResult(
  content: Record<string, unknown> | undefined,
): string | undefined {
  const token = content?.botToken;
  if (typeof token !== "string") {
    return undefined;
  }
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function maskToken(token: string): string {
  if (token.length <= 10) {
    return "**********";
  }
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

export function parseStartCommand(text: string | undefined): StartCommand {
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

export function generateSetupCode(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

export function buildMcpConfigSnippet(
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

export function findOnboardingMessageMatches(
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

export function formatOnboardingCandidates(matches: OnboardingMatch[]): string {
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

