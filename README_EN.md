# Feishu ChatGPT Browser Bridge:Share Your Sol With Your Family and Friends

**English** | [简体中文](README.md)

Use a Feishu bot to send messages to a **locally logged-in ChatGPT web session**, then send ChatGPT's replies back to Feishu.

![demo](./img/demo.png)

This project uses Feishu's official `@larksuiteoapi/node-sdk` with a persistent WebSocket connection, so it does **not** require a public server, domain name, webhook endpoint, or `lark-cli`.

```text
Feishu
  -> Official Feishu WebSocket
  -> Local Node bridge
  -> ws://127.0.0.1:17331
  -> Chrome extension
  -> chatgpt.com
  -> Feishu OpenAPI reply
```

> This is an experimental browser-automation project. It does not use the OpenAI API. Make sure your usage complies with the applicable service terms and your organization's policies.

## Features

- Responds in group chats only when the bot is mentioned
- Supports direct messages
- Keeps one ChatGPT conversation per Feishu chat
- `/new` clears the ChatGPT context associated with the current Feishu chat
- Automatically splits long replies before sending them back to Feishu
- Chrome extension automatically reconnects to the local bridge
- Falls back to a new ChatGPT conversation when a saved conversation becomes stale

## Requirements

- Node.js 20+
- Chrome or another Chromium-based browser
- A Feishu account that can create a custom app
- An active login session at `https://chatgpt.com/`

## 1. Install

```bash
git clone <your-repo-url>
cd feishu-chatgpt-bridge
npm install
```

## 2. Create a Feishu bot

The easiest way is:

```bash
npm run register:feishu
```

The helper will guide you through creating a bot and save the generated App ID and App Secret to a local `.env` file. `.env` is ignored by Git.

You can also configure the app manually:

```bash
cp .env.example .env
```

The bot needs at least these messaging capabilities:

```text
im:message.group_at_msg:readonly
im:message.p2p_msg:readonly
im:message:send_as_bot
```

Subscribe to this event:

```text
im.message.receive_v1
```

In the Feishu Developer Console, set the event subscription mode to **Receive events/callbacks through persistent connection**, then publish an app version.

If you want to add the bot to an external cross-organization group, you may also need to enable external-group usage in the app's release settings and satisfy Feishu's organization verification requirements.

## 3. Load the Chrome extension

Open:

```text
chrome://extensions
```

Enable **Developer mode** → **Load unpacked** → select the project's `extension/` directory.

The extension only connects to the local bridge:

```text
ws://127.0.0.1:17331
```

## 4. Run

Foreground mode:

```bash
npm run check
npm start
```

Background mode:

```bash
npm run start:bg
npm run status
npm run logs
npm run stop
npm run restart:bg
```

Runtime files are stored in `.runtime/` and are excluded from Git.

## Session behavior

The Node bridge passes the Feishu `chatId` (or sender ID for direct messages) to the extension as a `sessionKey`.

The extension stores the mapping in `chrome.storage.local.sessions`:

```text
sessionKey -> https://chatgpt.com/c/<conversation-id>
```

As a result, messages from the same Feishu chat continue the same ChatGPT conversation. Sending `/new` removes that mapping and starts a fresh conversation on the next message.

## Security and privacy

Do not commit any of the following to a public repository:

- `.env`
- `.runtime/`
- Chrome storage exports
- Real Feishu user IDs or chat IDs
- QR codes or debug screenshots containing account information

If an App Secret has ever been committed to Git history, deleting the file is not enough. Rotate the secret immediately in the Feishu Developer Console and remove the leaked value from Git history.

## Project layout

```text
extension/   Chrome MV3 extension that controls the logged-in ChatGPT page
src/         Feishu WebSocket, local browser bridge, and runtime logic
scripts/     Background service and optional Feishu app registration helper
.env.example Configuration template
```

## Notes

ChatGPT's web UI and DOM may change over time. Browser automation is therefore more sensitive to page updates than an official API integration.

If reply extraction starts behaving unexpectedly, first make sure the Chrome extension has been reloaded and is running the latest version from this repository.

## Links

- [LinuxDo](https://linux.do) — A sincere, friendly, united and professional new‑generation AI community

## License

MIT
