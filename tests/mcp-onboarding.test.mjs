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
      const offset = Number.parseInt(url.searchParams.get("offset") || "0", 10);
      const limit = Number.parseInt(url.searchParams.get("limit") || "100", 10);
      let result = updates;
      if (!Number.isNaN(offset) && offset > 0) {
        result = result.filter((item) => item.update_id >= offset);
      }
      if (!Number.isNaN(limit)) {
        result = result.slice(-limit);
      }
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

    const mediaRoutes = [
      `/bot${BOT_TOKEN}/sendPhoto`,
      `/bot${BOT_TOKEN}/sendAudio`,
      `/bot${BOT_TOKEN}/sendDocument`,
    ];
    if (req.method === "POST" && mediaRoutes.includes(url.pathname)) {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk.toString();
      });
      req.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { _raw: raw, _multipart: true };
        }
        sentMessages.push({ ...parsed, _mediaRoute: url.pathname });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: nextMessageId++ },
          }),
        );
      });
      return;
    }

    if (req.method === "POST" && url.pathname === `/bot${BOT_TOKEN}/editMessageText`) {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk.toString();
      });
      req.on("end", () => {
        const parsed = JSON.parse(raw);
        sentMessages.push({ ...parsed, _edited: true });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: parsed.message_id } }));
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

test("onboarding + notification + await-reply tools work end-to-end", async () => {
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
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      USER: process.env.USER || "",
      BOT_TELEGRAM_API_BASE_URL: baseUrl,
      BOT_TELEGRAM_CHAT_ID: "889721252",
      BOT_TELEGRAM_TOKEN: BOT_TOKEN,
    },
  });
  const client = new Client({ name: "test-client", version: "0.0.1" });

  try {
    await client.connect(transport);

    // -- Verify exactly 5 tools are registered --
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("telegram_onboarding_prepare"));
    assert.ok(toolNames.includes("telegram_onboarding_verify"));
    assert.ok(toolNames.includes("send_telegram_notification"));
    assert.ok(toolNames.includes("telegram_config_status"));
    assert.ok(toolNames.includes("telegram_send_and_wait_reply"));
    assert.ok(toolNames.includes("telegram_edit_message"));
    assert.equal(toolNames.length, 6, `Expected 6 tools, got ${toolNames.length}: ${toolNames.join(", ")}`);

    // -- Onboarding prepare --
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

    // -- Onboarding prepare without token --
    const prepareNoToken = await client.callTool({
      name: "telegram_onboarding_prepare",
      arguments: {
        packageName: "mcp-telegram-agent",
        serverName: "telegram-agent",
        setupCode: "SETUP1234",
      },
    });
    assert.equal(prepareNoToken.isError, true);

    // -- Onboarding verify (needs confirmation) --
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
    assert.match(verifyText, /chat_id confirmation is required/);
    assert.match(verifyText, /chat_id=889721252/);

    // -- Onboarding verify (confirmed) --
    const verifyConfirmed = await client.callTool({
      name: "telegram_onboarding_verify",
      arguments: {
        botToken: BOT_TOKEN,
        setupCode: "SETUP1234",
        expectedChatId: "889721252",
        limit: 20,
        sendTestMessage: true,
        packageName: "mcp-telegram-agent",
        serverName: "telegram-agent",
      },
    });
    const verifyConfirmedText = verifyConfirmed.content?.[0]?.type === "text" ? verifyConfirmed.content[0].text : "";
    assert.match(verifyConfirmedText, /Onboarding verified successfully/);
    assert.match(verifyConfirmedText, /test_message=Sent/);

    // -- Send notification --
    const sendResult = await client.callTool({
      name: "send_telegram_notification",
      arguments: { message: "hello from test" },
    });
    const sendText = sendResult.content?.[0]?.type === "text" ? sendResult.content[0].text : "";
    assert.match(sendText, /Notification sent to Telegram/);

    // -- Config status --
    const configResult = await client.callTool({
      name: "telegram_config_status",
      arguments: {},
    });
    const configText = configResult.content?.[0]?.type === "text" ? configResult.content[0].text : "";
    assert.match(configText, /Configuration is valid/);
    assert.match(configText, /889721252/);

    // -- send_and_wait_reply --
    // Clear stale updates so the tool only sees the reply
    mock.updates.length = 0;

    // The next sendMessage will get this message_id from the mock counter
    const expectedSentMsgId = mock.sentMessages.length + 1;

    // Schedule injecting the reply after a short delay (simulates user replying)
    setTimeout(() => {
      mock.updates.push({
        update_id: 9001,
        message: {
          message_id: 500,
          text: "respuesta de prueba",
          reply_to_message: {
            message_id: expectedSentMsgId,
            text: "Esperando tu reply...",
          },
          chat: {
            id: 889721252,
            type: "private",
            username: "tecnomanu",
          },
        },
      });
    }, 500);

    const awaitResult = await client.callTool({
      name: "telegram_send_and_wait_reply",
      arguments: {
        message: "Esperando tu reply...",
        waitTimeoutSeconds: 15,
      },
    });
    const awaitText = awaitResult.content?.[0]?.type === "text" ? awaitResult.content[0].text : "";
    assert.match(awaitText, /respuesta de prueba/);
    assert.match(awaitText, /tecnomanu/);
    assert.match(awaitText, /ack_message_id: \d+/);

    // Extract ack_message_id and test telegram_edit_message
    const ackIdMatch = awaitText.match(/ack_message_id: (\d+)/);
    assert.ok(ackIdMatch, "ack_message_id should be a number");
    const ackMsgId = Number.parseInt(ackIdMatch[1], 10);

    const editResult = await client.callTool({
      name: "telegram_edit_message",
      arguments: {
        messageId: ackMsgId,
        text: "Listo, tarea completada.",
      },
    });
    const editText = editResult.content?.[0]?.type === "text" ? editResult.content[0].text : "";
    assert.match(editText, /edited successfully/);

    // -- Send notification with media (photo URL) --
    const mediaResult = await client.callTool({
      name: "send_telegram_notification",
      arguments: {
        message: "Check this image",
        media: { type: "photo", url: "https://example.com/photo.jpg" },
      },
    });
    const mediaText = mediaResult.content?.[0]?.type === "text" ? mediaResult.content[0].text : "";
    assert.match(mediaText, /photo notification sent to Telegram/);

    // -- Send notification with media only (no caption) --
    const mediaNoCaption = await client.callTool({
      name: "send_telegram_notification",
      arguments: {
        media: { type: "document", url: "https://example.com/report.pdf" },
      },
    });
    const mediaNoCaptionText = mediaNoCaption.content?.[0]?.type === "text" ? mediaNoCaption.content[0].text : "";
    assert.equal(mediaNoCaption.isError, undefined);

    // -- Validation: neither message nor media --
    const emptyResult = await client.callTool({
      name: "send_telegram_notification",
      arguments: {},
    });
    assert.equal(emptyResult.isError, true);
  } finally {
    await transport.close();
    await new Promise((resolve) => mock.server.close(resolve));
  }
});
