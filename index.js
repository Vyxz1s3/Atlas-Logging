require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Colors } = require('discord.js');

// ---------------------------------------------------------------------------
// Client setup
// ---------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the log channel and send an embed.
 * Falls back to console.log when LOG_CHANNEL_ID is not set or the channel
 * cannot be found.
 *
 * @param {import('discord.js').Guild|null} guild
 * @param {import('discord.js').EmbedBuilder} embed
 */
async function sendLog(guild, embed) {
  const channelId = process.env.LOG_CHANNEL_ID;

  if (!channelId) {
    console.log('[LOG]', JSON.stringify(embed.toJSON(), null, 2));
    return;
  }

  try {
    const channel = guild
      ? guild.channels.cache.get(channelId) ??
        (await guild.channels.fetch(channelId).catch(() => null))
      : client.channels.cache.get(channelId) ??
        (await client.channels.fetch(channelId).catch(() => null));

    if (!channel || !channel.isTextBased()) {
      console.warn(`[WARN] Log channel ${channelId} not found or is not a text channel.`);
      return;
    }

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[ERROR] Failed to send log embed:', err);
  }
}

/**
 * Build a base embed with a consistent style.
 *
 * @param {object} opts
 * @param {string}  opts.title
 * @param {number}  opts.color
 * @param {string} [opts.description]
 * @returns {import('discord.js').EmbedBuilder}
 */
function buildEmbed({ title, color, description }) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setTimestamp();

  if (description) embed.setDescription(description);
  return embed;
}

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------
client.once('ready', () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  console.log(`📋  Logging to channel: ${process.env.LOG_CHANNEL_ID ?? 'console (no LOG_CHANNEL_ID set)'}`);
});

// ---------------------------------------------------------------------------
// Channel events
// ---------------------------------------------------------------------------
client.on('channelCreate', async (channel) => {
  if (!channel.guild) return; // ignore DM channels

  const embed = buildEmbed({
    title: '📢 Channel Created',
    color: Colors.Green,
    description: `**Name:** ${channel.name}\n**Type:** ${channel.type}\n**ID:** ${channel.id}`,
  });

  await sendLog(channel.guild, embed);
});

client.on('channelDelete', async (channel) => {
  if (!channel.guild) return;

  const embed = buildEmbed({
    title: '🗑️ Channel Deleted',
    color: Colors.Red,
    description: `**Name:** ${channel.name}\n**Type:** ${channel.type}\n**ID:** ${channel.id}`,
  });

  await sendLog(channel.guild, embed);
});

client.on('channelUpdate', async (oldChannel, newChannel) => {
  if (!newChannel.guild) return;

  const changes = [];

  if (oldChannel.name !== newChannel.name) {
    changes.push(`**Name:** \`${oldChannel.name}\` → \`${newChannel.name}\``);
  }

  // topic is only present on text-based guild channels
  if ('topic' in oldChannel && oldChannel.topic !== newChannel.topic) {
    const oldTopic = oldChannel.topic || '*(none)*';
    const newTopic = newChannel.topic || '*(none)*';
    changes.push(`**Topic:** ${oldTopic} → ${newTopic}`);
  }

  if (changes.length === 0) return; // nothing we care about changed

  const embed = buildEmbed({
    title: '✏️ Channel Updated',
    color: Colors.Yellow,
    description: `**Channel:** <#${newChannel.id}>\n${changes.join('\n')}`,
  });

  await sendLog(newChannel.guild, embed);
});

// ---------------------------------------------------------------------------
// Member events
// ---------------------------------------------------------------------------
client.on('guildMemberAdd', async (member) => {
  const embed = buildEmbed({
    title: '👋 Member Joined',
    color: Colors.Blurple,
    description: `**User:** ${member.user.tag} (${member.user.id})\n**Account created:** <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`,
  });

  embed.setThumbnail(member.user.displayAvatarURL({ dynamic: true }));

  await sendLog(member.guild, embed);
});

client.on('guildMemberRemove', async (member) => {
  const embed = buildEmbed({
    title: '🚪 Member Left',
    color: Colors.Orange,
    description: `**User:** ${member.user.tag} (${member.user.id})\n**Joined:** ${
      member.joinedAt ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Unknown'
    }`,
  });

  embed.setThumbnail(member.user.displayAvatarURL({ dynamic: true }));

  await sendLog(member.guild, embed);
});

// ---------------------------------------------------------------------------
// Message events
// ---------------------------------------------------------------------------
client.on('messageDelete', async (message) => {
  // Ignore partial messages where we have no content, and bot messages
  if (!message.guild) return;
  if (message.partial) return;
  if (message.author?.bot) return;

  const embed = buildEmbed({
    title: '🗑️ Message Deleted',
    color: Colors.Red,
    description:
      `**Author:** ${message.author?.tag ?? 'Unknown'} (${message.author?.id ?? 'Unknown'})\n` +
      `**Channel:** <#${message.channelId}>\n` +
      `**Content:**\n${message.content || '*(no text content)*'}`,
  });

  await sendLog(message.guild, embed);
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!newMessage.guild) return;
  if (newMessage.partial) return;
  if (newMessage.author?.bot) return;
  if (oldMessage.content === newMessage.content) return; // embed-only update

  const embed = buildEmbed({
    title: '✏️ Message Edited',
    color: Colors.Yellow,
    description:
      `**Author:** ${newMessage.author?.tag ?? 'Unknown'} (${newMessage.author?.id ?? 'Unknown'})\n` +
      `**Channel:** <#${newMessage.channelId}>\n` +
      `**[Jump to message](${newMessage.url})**\n\n` +
      `**Before:**\n${oldMessage.content || '*(no text content)*'}\n\n` +
      `**After:**\n${newMessage.content || '*(no text content)*'}`,
  });

  await sendLog(newMessage.guild, embed);
});

// ---------------------------------------------------------------------------
// Role events
// ---------------------------------------------------------------------------
client.on('roleCreate', async (role) => {
  const embed = buildEmbed({
    title: '🎭 Role Created',
    color: Colors.Green,
    description: `**Name:** ${role.name}\n**ID:** ${role.id}\n**Color:** ${role.hexColor}`,
  });

  await sendLog(role.guild, embed);
});

client.on('roleDelete', async (role) => {
  const embed = buildEmbed({
    title: '🎭 Role Deleted',
    color: Colors.Red,
    description: `**Name:** ${role.name}\n**ID:** ${role.id}\n**Color:** ${role.hexColor}`,
  });

  await sendLog(role.guild, embed);
});

// ---------------------------------------------------------------------------
// Webhook events
// ---------------------------------------------------------------------------
client.on('webhookCreate', async (webhook) => {
  const embed = buildEmbed({
    title: '🔗 Webhook Created',
    color: Colors.Blurple,
    description: `**Name:** ${webhook.name}\n**ID:** ${webhook.id}\n**Channel:** <#${webhook.channelId}>`,
  });

  await sendLog(webhook.guild, embed);
});

client.on('webhookDelete', async (webhook) => {
  const embed = buildEmbed({
    title: '🔗 Webhook Deleted',
    color: Colors.Red,
    description: `**Name:** ${webhook.name}\n**ID:** ${webhook.id}\n**Channel:** <#${webhook.channelId}>`,
  });

  await sendLog(webhook.guild, embed);
});

// ---------------------------------------------------------------------------
// Global error handling
// ---------------------------------------------------------------------------
client.on('error', (err) => {
  console.error('[CLIENT ERROR]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('[FATAL] DISCORD_TOKEN environment variable is not set. Exiting.');
  process.exit(1);
}

client.login(token);
