# Atlas Logging

A Discord bot that logs comprehensive server events — channel changes, member joins/leaves, message edits/deletions, and role changes — to a designated channel using rich Discord embeds.

---

## Events logged

| Event | Description |
|---|---|
| `channelCreate` | A new channel was created |
| `channelDelete` | A channel was deleted |
| `channelUpdate` | A channel's name or topic changed |
| `guildMemberAdd` | A member joined the server |
| `guildMemberRemove` | A member left (or was kicked from) the server |
| `messageDelete` | A message was deleted |
| `messageUpdate` | A message was edited |
| `roleCreate` | A new role was created |
| `roleDelete` | A role was deleted |

---

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- A Discord bot application with a valid token ([create one here](https://discord.com/developers/applications))
- The bot must be invited to your server with the following permissions:
  - **View Channels**
  - **Send Messages**
  - **Embed Links**
  - **Read Message History**

### Required Privileged Gateway Intents

Enable these in the Discord Developer Portal under your application → **Bot → Privileged Gateway Intents**:

- **Server Members Intent** — required for `guildMemberAdd` / `guildMemberRemove`
- **Message Content Intent** — required to read message content for `messageDelete` / `messageUpdate`

---

## Local setup

1. **Clone the repository**

   ```bash
   git clone <repo-url>
   cd atlas-logging
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment variables**

   ```bash
   cp .env.example .env
   ```

   Open `.env` and fill in the two required values:

   | Variable | Description |
   |---|---|
   | `DISCORD_TOKEN` | Your bot token from the Discord Developer Portal |
   | `LOG_CHANNEL_ID` | The ID of the text channel to send log messages to |

   > **Tip — finding a channel ID:** Enable Developer Mode in Discord (*Settings → Advanced → Developer Mode*), then right-click any text channel and choose **Copy Channel ID**.

4. **Start the bot**

   ```bash
   npm start
   ```

   You should see:
   ```
   ✅  Logged in as YourBot#1234
   📋  Logging to channel: 123456789012345678
   ```

---

## Deploy to Railway

1. Push this repository to GitHub.
2. Create a new Railway project and connect the GitHub repo.
3. Add the following environment variables in the Railway dashboard under **Variables**:
   - `DISCORD_TOKEN`
   - `LOG_CHANNEL_ID`
4. Railway will automatically run `npm start` using the `start` script in `package.json`.

The bot will start automatically on every deploy and restart on crash thanks to Railway's built-in process management.

---

## Project structure

```
atlas-logging/
├── index.js          # Bot entry point — all event listeners live here
├── package.json      # Dependencies and start script
├── .env.example      # Environment variable template
└── README.md         # This file
```

---

## License

MIT
