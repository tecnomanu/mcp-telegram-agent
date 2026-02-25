export type TelegramConfig = {
  chatId: string;
  token?: string;
  timeoutMs: number;
  threadId?: number;
  url: string;
};

export type TelegramApiResponse = {
  ok: boolean;
  description?: string;
  result?: {
    message_id?: number;
  };
};

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id?: number;
    text?: string;
    reply_to_message?: {
      message_id?: number;
      text?: string;
    };
    chat?: {
      id?: number;
      type?: string;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
  };
};

export type StartCommand = {
  isStart: boolean;
  payload?: string;
};

export type OnboardingMatch = {
  chatId: string;
  messageId?: number;
  text?: string;
  updateId: number;
  username?: string;
};

export type ResolveBotTokenResult =
  | { mode: "provided" | "elicited"; token: string }
  | { mode: "missing"; reason: string };

export type ResolvedRuntimeConfig = {
  chatId: string;
  config: TelegramConfig;
  token: string;
};
