import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BOT_TOKEN = "TEST_TOKEN_123456789";

function createTelegramMock() {
  let nextMessageId = 1;
  const sentMessages = [];
  const updates = [
    {
      update_id: 5001,
      message: {
        message_id: 101,
        text: "SETUP1234",
        chat: {
          id: 889721252,
          type: "private",
          username: "tecnomanu",
        },
      },
    },
  ];

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === `/bot${BOT_TOKEN}/getUpdates`) {
      const limit = Number.parseInt(url.searchParams.get("limit") || "100", 10);
      const result = Number.isNaN(limit) ? updates : updates.slice(-limit);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    if (req.method === "POST" && url.pathname === `/bot${BOT_TOKEN}/sendMessage`) {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk.toString();
      });
      req.on("end", () => {
        const parsed = JSON.parse(raw);
        sentMessages.push(parsed);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              message_id: nextMessageId++,
            },
          }),
        );
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, description: "Not found in mock server" }));
  });

  return {
    updates,
    sentMessages,
    server,
  };
}

test("onboarding + notification tools work end-to-end with token flow", async () => {
  const mock = createTelegramMock();
  await new Promise((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start mock server.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: process.cwd(),
    env: {
      BOT_TELEGRAM_API_BASE_URL: baseUrl,
      BOT_TELEGRAM_CHAT_ID: "889721252",
      BOT_TELEGRAM_TOKEN: BOT_TOKEN,
    },
  });
  const client = new Client({ name: "test-client", version: "0.0.1" });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("telegram_onboarding_prepare"));
    assert.ok(toolNames.includes("telegram_onboarding_verify"));
    assert.ok(toolNames.includes("send_telegram_notification"));

    const prepareResult = await client.callTool({
      name: "telegram_onboarding_prepare",
      arguments: {
        botToken: BOT_TOKEN,
        packageName: "mcp-telegram-agent",
        serverName: "telegram-agent",
        setupCode: "SETUP1234",
      },
    });
    const prepareText = prepareResult.content?.[0]?.type === "text" ? prepareResult.content[0].text : "";
    assert.match(prepareText, /BotFather/);
    assert.match(prepareText, /SETUP1234/);
    assert.match(prepareText, /Send exactly this message/);

    const verifyResult = await client.callTool({
      name: "telegram_onboarding_verify",
      arguments: {
        botToken: BOT_TOKEN,
        setupCode: "SETUP1234",
        limit: 20,
        sendTestMessage: true,
        packageName: "mcp-telegram-agent",
        serverName: "telegram-agent",
      },
    });
    const verifyText = verifyResult.content?.[0]?.type === "text" ? verifyResult.content[0].text : "";
    assert.match(verifyText, /Onboarding verified successfully/);
    assert.match(verifyText, /chat_id=889721252/);
    assert.match(verifyText, /test_message=Sent/);

    assert.equal(mock.sentMessages.length, 1);
    assert.equal(mock.sentMessages[0].chat_id, "889721252");
    assert.match(mock.sentMessages[0].text, /setup_code=SETUP1234/);
    assert.doesNotMatch(mock.sentMessages[0].text, /chat_id=/);

    const sendResult = await client.callTool({
      name: "send_telegram_notification",
      arguments: {
        message: "hello from test",
      },
    });
    const sendText = sendResult.content?.[0]?.type === "text" ? sendResult.content[0].text : "";
    assert.match(sendText, /Notification sent to Telegram/);
    assert.equal(mock.sentMessages.length, 2);
    assert.equal(mock.sentMessages[1].chat_id, "889721252");

    const updatesResult = await client.callTool({
      name: "telegram_get_updates",
      arguments: {
        botToken: BOT_TOKEN,
        limit: 10,
      },
    });
    const updatesText = updatesResult.content?.[0]?.type === "text" ? updatesResult.content[0].text : "";
    assert.match(updatesText, /SETUP1234/);
    assert.match(updatesText, /chat_id=889721252/);
  } finally {
    await transport.close();
    await new Promise((resolve) => mock.server.close(resolve));
  }
});
