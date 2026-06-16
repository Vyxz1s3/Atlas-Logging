# Atlas Logging

A comprehensive Discord logging bot that tracks virtually all server activity — members, messages, channels, roles, voice, threads, forums, emojis, stickers, invites, webhooks, and server settings — and posts rich embeds to a designated log channel.

Also ships with a full **automoderation and anti-raid system** (`automod.js`) that protects the server from spam, raids, permission escalation, and other common attacks.

> **Moderation logs (bans, kicks, timeouts, warnings, mutes) are intentionally disabled.** Stub functions are in place for when a dedicated moderation bot is ready to integrate.

---

## Events logged

### 👤 Member Logs
| Event | What's tracked |
|---|---|
| `guildMemberAdd` | Member joined — account age, invite used, new-account security flag |
| `guildMemberAdd` | Bot added to server |
| `guildMemberRemove` | Member left |
| `guildMemberRemove` | Bot removed from server |
| `guildMemberUpdate` | Username changed |
| `guildMemberUpdate` | Global display name changed |
| `guildMemberUpdate` | Nickname changed |
| `guildMemberUpdate` | Roles added or removed |
| `guildMemberUpdate` | Server boost started or stopped |

### 💬 Message Logs
| Event | What's tracked |
|---|---|
| `messageDelete` | Message deleted (author, channel, content) |
| `messageUpdate` | Message edited (before & after, jump link) |

### 📢 Channel Logs
| Event | What's tracked |
|---|---|
| `channelCreate` | Channel created (name, type, category) |
| `channelDelete` | Channel deleted |
| `channelUpdate` | Name, topic, slowmode, NSFW setting changed |
| `channelUpdate` | Permission overwrites added, removed, or changed |

### 🎭 Role Logs
| Event | What's tracked |
|---|---|
| `roleCreate` | Role created (name, color, hoist, mentionable) |
| `roleDelete` | Role deleted |
| `roleUpdate` | Name, color, hoist, mentionable, position, icon changed |
| `roleUpdate` | Permission diff (added/removed permissions) |

### 🔊 Voice Logs
| Event | What's tracked |
|---|---|
| `voiceStateUpdate` | Joined / left / switched voice channel |
| `voiceStateUpdate` | Self-mute / unmute |
| `voiceStateUpdate` | Self-deafen / undeafen |
| `voiceStateUpdate` | Server mute / unmute |
| `voiceStateUpdate` | Server deafen / undeafen |
| `voiceStateUpdate` | Screen share started / stopped |
| `voiceStateUpdate` | Camera on / off |

### 🏰 Server Logs
| Event | What's tracked |
|---|---|
| `guildUpdate` | Server name, icon, banner, invite splash |
| `guildUpdate` | Verification level, explicit content filter |
| `guildUpdate` | Default notifications, AFK channel/timeout |
| `guildUpdate` | System channel, rules channel, community updates channel |

### 🔗 Invite Logs
| Event | What's tracked |
|---|---|
| `inviteCreate` | Invite created (code, creator, channel, max uses, expiry) |
| `inviteDelete` | Invite deleted |
| `guildMemberAdd` | Which invite was used when a member joins |

### 🧵 Thread & Forum Logs
| Event | What's tracked |
|---|---|
| `threadCreate` | Thread or forum post created |
| `threadDelete` | Thread or forum post deleted |
| `threadUpdate` | Name, archived, locked, slowmode changed |

### 😀 Emoji & Sticker Logs
| Event | What's tracked |
|---|---|
| `emojiCreate` | Emoji added |
| `emojiDelete` | Emoji removed |
| `emojiUpdate` | Emoji renamed |
| `stickerCreate` | Sticker added |
| `stickerDelete` | Sticker removed |
| `stickerUpdate` | Sticker name or description changed |

### 🪝 Webhook Logs
| Event | What's tracked |
|---|---|
| `webhooksUpdate` | Webhook created |
| `webhooksUpdate` | Webhook deleted |
| `webhooksUpdate` | Webhook name or channel changed |

### 🔒 Moderation Logs — DISABLED (stubs only)
Bans, unbans, kicks, timeouts, warnings, and mutes are **not logged** by this bot. Stub functions (`memberBanned`, `memberUnbanned`, `memberKicked`, `timeoutApplied`, `timeoutRemoved`, `warningIssued`, `warningRemoved`, `muteApplied`, `muteRemoved`) are defined in `index.js` and ready to be wired up when the dedicated moderation bot is integrated.

---

## 🛡️ Automoderation & Anti-Raid

All automod logic lives in `automod.js` and is automatically initialised when the bot starts. Security alerts are sent to `SECURITY_LOG_CHANNEL_ID` (falls back to `LOG_CHANNEL_ID` if unset).

### Automoderation rules

| Rule | Trigger | Default action |
|---|---|---|
| **Spam Detection** | >5 messages in 5 seconds (per user per channel) | Mute (5 min) |
| **Mention Spam** | >5 unique mentions in one message | Mute (10 min) |
| **Discord Invite Links** | Any `discord.gg` / `discord.com/invite` link | Warn + delete |
| **Link Detection** | Any non-whitelisted URL | Log |
| **Profanity / Keyword Filter** | Configurable word list (case-insensitive) | Warn + delete |
| **Caps Spam** | >70% uppercase in messages >10 chars | Warn |
| **Repeated Character Spam** | 6+ consecutive identical characters | Warn |
| **Suspicious Patterns** | Zalgo text, RTL override, zero-width chars, emoji spam | Log |

### Anti-Raid / Security rules

| Rule | Trigger | Default action |
|---|---|---|
| **Mass Join** | >10 joins in 60 seconds | Security alert |
| **Mass Ban** | >5 bans in 60 seconds | Security alert |
| **Mass Kick** | >5 kicks in 60 seconds | Security alert |
| **Mass Role Changes** | >10 role changes in 60 seconds | Security alert |
| **Mass Channel Creation** | >5 channels created in 60 seconds | Security alert |
| **Mass Channel Deletion** | >5 channels deleted in 60 seconds | Security alert |
| **Webhook Spam** | >3 webhooks created in 60 seconds | Security alert |
| **Permission Escalation** | Non-admin gains Administrator or other dangerous perms | Security alert |
| **New Account** | Account created <7 days ago joins the server | Security alert |
| **Suspicious Activity Score** | Accumulated violation points reach threshold (10) | Security alert |

### Configuring automod

Open `automod.js` and edit the `config` object at the top of the file. Every rule has an `enabled` toggle, threshold values, and an `action` field:

| Action | Effect |
|---|---|
| `log` | Post a security embed to the security log channel only |
| `warn` | Log + DM the user with a warning |
| `mute` | Log + timeout the user for `muteDurationMs` milliseconds |
| `kick` | Log + DM + kick the user |
| `ban` | Log + DM + ban the user (deletes 24 h of messages) |

**Whitelist** users, roles, or channels by adding their IDs to `config.whitelist.userIds`, `config.whitelist.roleIds`, or `config.whitelist.channelIds`.

**Link whitelist** — domains in `config.automod.links.whitelist` are never flagged by the link-detection rule.

**Profanity list** — add banned words (lower-case) to `config.automod.profanity.words`.

---

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- A Discord bot application with a valid token ([create one here](https://discord.com/developers/applications))
- The bot must be invited to your server with the following permissions:
  - **View Channels**
  - **Send Messages**
  - **Embed Links**
  - **Read Message History**
  - **Manage Webhooks** — required to fetch and diff webhooks
  - **Manage Guild** — required to fetch invites for invite tracking
  - **Moderate Members** — required for the automod mute (timeout) action
  - **Kick Members** — required for the automod kick action
  - **Ban Members** — required for the automod ban action
  - **View Audit Log** — required for mass-kick detection

### Required Privileged Gateway Intents

Enable **all three** in the Discord Developer Portal under your application → **Bot → Privileged Gateway Intents**:

- **Server Members Intent** — required for member join/leave/update events
- **Message Content Intent** — required to read deleted/edited message content

> Standard (non-privileged) intents used: `GuildVoiceStates`, `GuildInvites`, `GuildEmojisAndStickers`, `GuildWebhooks`, `GuildModeration`, `GuildMessageReactions`.

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
   | `LOG_CHANNEL_ID` | The ID of the text channel to send general log messages to |
   | `SECURITY_LOG_CHANNEL_ID` | *(Optional)* Separate channel for automod/security alerts. Falls back to `LOG_CHANNEL_ID` if unset |

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
   - `SECURITY_LOG_CHANNEL_ID` *(optional — dedicated channel for automod/security alerts)*
4. Railway will automatically run `npm start` using the `start` script in `package.json`.

The bot will start automatically on every deploy and restart on crash thanks to Railway's built-in process management.

---

## Integrating the moderation bot

When your moderation bot is ready, open `index.js` and find the **MODERATION LOGS — DISABLED** section near the bottom. Replace each stub function body with the appropriate `buildEmbed` + `sendLog` call, then register the events:

```js
client.on('guildBanAdd',    memberBanned);
client.on('guildBanRemove', memberUnbanned);
```

The `GuildModeration` intent is already enabled, so no further configuration is needed.

---

## Project structure

```
atlas-logging/
├── index.js          # Bot entry point — all logging event listeners live here
├── automod.js        # Automoderation & anti-raid system (config, rules, actions)
├── package.json      # Dependencies and start script
├── .env.example      # Environment variable template
└── README.md         # This file
```

---

## License

MIT
