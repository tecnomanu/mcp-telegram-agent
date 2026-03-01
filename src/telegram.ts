import {
  DEFAULT_TIMEOUT_MS,
  TELEGRAM_API_BASE_URL_DEFAULT,
} from "./constants.js";
import type { MediaPayload, MediaType, TelegramApiResponse, TelegramConfig, TelegramUpdate } from "./types.js";

const MEDIA_METHOD: Record<MediaType, { method: string; field: string }> = {
  photo: { method: "sendPhoto", field: "photo" },
  audio: { method: "sendAudio", field: "audio" },
  document: { method: "sendDocument", field: "document" },
};

export function parseTimeoutMs(rawTimeoutMs: string | undefined): { timeoutMs?: number; error?: string } {
  const timeoutMs = Number.parseInt(rawTimeoutMs?.trim() || String(DEFAULT_TIMEOUT_MS), 10);
  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    return {
      error:
        "Invalid BOT_TELEGRAM_TIMEOUT_MS. Use a positive integer (milliseconds).",
    };
  }
  return { timeoutMs };
}

export function getTelegramApiBaseUrl(): string {
  const baseUrl = process.env.BOT_TELEGRAM_API_BASE_URL?.trim();
  if (!baseUrl) {
    return TELEGRAM_API_BASE_URL_DEFAULT;
  }
  return baseUrl.replace(/\/+$/, "");
}

export function buildTelegramMethodUrl(token: string, method: string): string {
  return `${getTelegramApiBaseUrl()}/bot${token}/${method}`;
}

export function buildTelegramConfigFromToken(
  token: string,
  chatId: string,
  timeoutMs: number,
  threadId?: number,
): TelegramConfig {
  return {
    chatId,
    token,
    timeoutMs,
    threadId,
    url: buildTelegramMethodUrl(token, "sendMessage"),
  };
}

export function buildTelegramConfig(): { config?: TelegramConfig; error?: string } {
  const token = process.env.BOT_TELEGRAM_TOKEN?.trim();
  const urlFromEnv = process.env.BOT_TELEGRAM_URL?.trim();
  const chatId =
    process.env.BOT_TELEGRAM_CHAT_ID?.trim() ||
    process.env.BOT_TELEGRAM_ID?.trim();
  const timeoutResult = parseTimeoutMs(process.env.BOT_TELEGRAM_TIMEOUT_MS);
  const timeoutMs = timeoutResult.timeoutMs;
  const threadIdRaw = process.env.BOT_TELEGRAM_THREAD_ID?.trim();
  const threadId = threadIdRaw ? Number.parseInt(threadIdRaw, 10) : undefined;

  if (!chatId) {
    return {
      error:
        "Missing chat ID. Set BOT_TELEGRAM_CHAT_ID or BOT_TELEGRAM_ID in the MCP server env config.",
    };
  }

  if (!timeoutMs) {
    return { error: timeoutResult.error };
  }

  if (threadIdRaw && Number.isNaN(threadId)) {
    return {
      error:
        "Invalid BOT_TELEGRAM_THREAD_ID. Use an integer topic/thread ID.",
    };
  }

  if (token) {
    return {
      config: buildTelegramConfigFromToken(token, chatId, timeoutMs, threadId),
    };
  }

  if (urlFromEnv) {
    return {
      config: {
        chatId,
        timeoutMs,
        threadId,
        url: urlFromEnv,
      },
    };
  }

  if (!token && !urlFromEnv) {
    return {
      error:
        "Missing Telegram endpoint. Set BOT_TELEGRAM_TOKEN (recommended) or BOT_TELEGRAM_URL in the MCP server env config.",
    };
  }
  return { error: "Invalid Telegram configuration." };
}

export async function sendTelegramMessage(
  config: TelegramConfig,
  payload: {
    disableNotification?: boolean;
    message: string;
    parseMode?: "HTML" | "Markdown" | "MarkdownV2";
    replyToMessageId?: number;
  },
): Promise<{ messageId?: number; ok: boolean; statusCode: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: config.chatId,
        disable_notification: payload.disableNotification ?? false,
        message_thread_id: config.threadId,
        parse_mode: payload.parseMode,
        reply_to_message_id: payload.replyToMessageId,
        text: payload.message,
      }),
      signal: controller.signal,
    });

    const rawBody = await response.text();
    let jsonBody: TelegramApiResponse | null = null;

    if (rawBody) {
      try {
        jsonBody = JSON.parse(rawBody) as TelegramApiResponse;
      } catch {
        if (!response.ok) {
          throw new Error(
            `Telegram returned status ${response.status} and a non-JSON body.`,
          );
        }
      }
    }

    if (!response.ok) {
      const description = jsonBody?.description || "Unknown Telegram API error.";
      throw new Error(`Telegram API error (${response.status}): ${description}`);
    }

    if (jsonBody && !jsonBody.ok) {
      throw new Error(
        `Telegram API rejected the message: ${jsonBody.description || "Unknown error."}`,
      );
    }

    return {
      messageId: jsonBody?.result?.message_id,
      ok: true,
      statusCode: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendTelegramMedia(
  config: TelegramConfig,
  payload: {
    media: MediaPayload;
    caption?: string;
    parseMode?: "HTML" | "Markdown" | "MarkdownV2";
    disableNotification?: boolean;
    replyToMessageId?: number;
  },
): Promise<{ messageId?: number; ok: boolean; statusCode: number }> {
  if (!config.token) {
    throw new Error("Media sending requires BOT_TELEGRAM_TOKEN (token-based config).");
  }

  const { media, caption, parseMode, disableNotification, replyToMessageId } = payload;
  const { method, field } = MEDIA_METHOD[media.type];
  const url = buildTelegramMethodUrl(config.token, method);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    let response: Response;

    if (media.url) {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.chatId,
          [field]: media.url,
          caption,
          parse_mode: parseMode,
          disable_notification: disableNotification ?? false,
          message_thread_id: config.threadId,
          reply_to_message_id: replyToMessageId,
        }),
        signal: controller.signal,
      });
    } else if (media.base64Data) {
      const binary = Buffer.from(media.base64Data, "base64");
      const blob = new Blob([binary], { type: media.mimeType ?? "application/octet-stream" });
      const form = new FormData();
      form.append("chat_id", config.chatId);
      form.append(field, blob, media.filename ?? `file.${media.type === "photo" ? "jpg" : "bin"}`);
      if (caption) form.append("caption", caption);
      if (parseMode) form.append("parse_mode", parseMode);
      form.append("disable_notification", String(disableNotification ?? false));
      if (config.threadId) form.append("message_thread_id", String(config.threadId));
      if (replyToMessageId) form.append("reply_to_message_id", String(replyToMessageId));

      response = await fetch(url, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
    } else {
      throw new Error("Media requires either 'url' or 'base64Data'.");
    }

    const rawBody = await response.text();
    let jsonBody: TelegramApiResponse | null = null;

    if (rawBody) {
      try {
        jsonBody = JSON.parse(rawBody) as TelegramApiResponse;
      } catch {
        if (!response.ok) {
          throw new Error(`Telegram returned status ${response.status} and a non-JSON body.`);
        }
      }
    }

    if (!response.ok) {
      const description = jsonBody?.description || "Unknown Telegram API error.";
      throw new Error(`Telegram API error (${response.status}): ${description}`);
    }

    if (jsonBody && !jsonBody.ok) {
      throw new Error(`Telegram API rejected the media: ${jsonBody.description || "Unknown error."}`);
    }

    return {
      messageId: jsonBody?.result?.message_id,
      ok: true,
      statusCode: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function editTelegramMessage(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
  timeoutMs: number,
  parseMode?: "HTML" | "Markdown" | "MarkdownV2",
): Promise<{ ok: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(buildTelegramMethodUrl(token, "editMessageText"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: parseMode,
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    const parsed = raw ? (JSON.parse(raw) as { ok?: boolean; description?: string }) : {};

    if (!response.ok || !parsed.ok) {
      throw new Error(
        `editMessageText failed (${response.status}): ${parsed.description || "Unknown error."}`,
      );
    }

    return { ok: true };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getTelegramUpdates(
  token: string,
  timeoutMs: number,
  limit: number,
  options?: {
    offset?: number;
    waitSeconds?: number;
  },
): Promise<TelegramUpdate[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const search = new URLSearchParams();
    search.set("limit", String(limit));
    if (typeof options?.offset === "number") {
      search.set("offset", String(options.offset));
    }
    if (typeof options?.waitSeconds === "number") {
      search.set("timeout", String(options.waitSeconds));
    }
    const response = await fetch(
      `${buildTelegramMethodUrl(token, "getUpdates")}?${search.toString()}`,
      {
        method: "GET",
        signal: controller.signal,
      },
    );

    const bodyText = await response.text();
    let parsed: { ok?: boolean; result?: TelegramUpdate[]; description?: string } = {};
    if (bodyText) {
      parsed = JSON.parse(bodyText) as {
        ok?: boolean;
        result?: TelegramUpdate[];
        description?: string;
      };
    }

    if (!response.ok || !parsed.ok) {
      throw new Error(
        `Telegram getUpdates failed (${response.status}): ${parsed.description || "Unknown error."}`,
      );
    }

    return parsed.result || [];
  } finally {
    clearTimeout(timeout);
  }
}
