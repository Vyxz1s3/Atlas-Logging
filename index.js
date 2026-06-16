require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Colors,
  ChannelType,
  PermissionsBitField,
} = require('discord.js');

// ---------------------------------------------------------------------------
// Automod & Anti-Raid system
// Loaded here so it can attach its own event listeners to the same client.
// All configuration lives in automod.js — edit thresholds and actions there.
// Set SECURITY_LOG_CHANNEL_ID in .env to route security alerts to a separate
// channel; falls back to LOG_CHANNEL_ID if unset.
// ---------------------------------------------------------------------------
const automod = require('./automod');

// ---------------------------------------------------------------------------
// Client setup
// All privileged intents required for comprehensive logging:
//   - GuildMembers   → member join/leave/update events
//   - GuildPresences → (not needed here, omitted)
//   - MessageContent → read deleted/edited message bodies
// ---------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildModeration,
  ],
});

// ---------------------------------------------------------------------------
// Invite cache  (guild ID → Map<code, Invite>)
// Populated on ready and updated on inviteCreate/inviteDelete so we can
// diff invite uses when a member joins.
// ---------------------------------------------------------------------------
const inviteCache = new Map();

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

/**
 * Return a human-readable channel type label.
 * @param {number} type  ChannelType enum value
 */
function channelTypeLabel(type) {
  const labels = {
    [ChannelType.GuildText]:          'Text',
    [ChannelType.GuildVoice]:         'Voice',
    [ChannelType.GuildCategory]:      'Category',
    [ChannelType.GuildAnnouncement]:  'Announcement',
    [ChannelType.GuildStageVoice]:    'Stage',
    [ChannelType.GuildForum]:         'Forum',
    [ChannelType.GuildMedia]:         'Media',
    [ChannelType.PublicThread]:       'Public Thread',
    [ChannelType.PrivateThread]:      'Private Thread',
    [ChannelType.AnnouncementThread]: 'Announcement Thread',
  };
  return labels[type] ?? `Unknown (${type})`;
}

/**
 * Diff two PermissionsBitField values and return a human-readable string
 * listing added and removed permissions, or null if nothing changed.
 *
 * @param {bigint} oldBits
 * @param {bigint} newBits
 * @returns {string|null}
 */
function diffPermissions(oldBits, newBits) {
  if (oldBits === newBits) return null;

  const added   = new PermissionsBitField(newBits & ~oldBits).toArray();
  const removed = new PermissionsBitField(oldBits & ~newBits).toArray();

  const lines = [];
  if (added.length)   lines.push(`**Added:** ${added.join(', ')}`);
  if (removed.length) lines.push(`**Removed:** ${removed.join(', ')}`);
  return lines.join('\n') || null;
}

/**
 * Truncate a string to a maximum length, appending "…" if cut.
 * @param {string} str
 * @param {number} max
 */
function truncate(str, max = 1024) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------
client.once('ready', async () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  console.log(`📋  Logging to channel: ${process.env.LOG_CHANNEL_ID ?? 'console (no LOG_CHANNEL_ID set)'}`);

  // Pre-populate invite cache for every guild the bot is in
  for (const guild of client.guilds.cache.values()) {
    try {
      const invites = await guild.invites.fetch();
      inviteCache.set(guild.id, new Map(invites.map((inv) => [inv.code, inv])));
    } catch {
      // Bot may lack MANAGE_GUILD — silently skip
    }
  }

  // Initialise automod — attaches all automod/anti-raid event listeners
  automod.init(client);
});

// ═══════════════════════════════════════════════════════════════════════════
// CHANNEL LOGS
// Events: channelCreate, channelDelete, channelUpdate
// ═══════════════════════════════════════════════════════════════════════════

client.on('channelCreate', async (channel) => {
  if (!channel.guild) return; // ignore DM channels

  const embed = buildEmbed({
    title: '📢 Channel Created',
    color: Colors.Green,
    description:
      `**Name:** ${channel.name}\n` +
      `**Type:** ${channelTypeLabel(channel.type)}\n` +
      (channel.parent ? `**Category:** ${channel.parent.name}\n` : '') +
      `**ID:** ${channel.id}`,
  });

  await sendLog(channel.guild, embed);
});

client.on('channelDelete', async (channel) => {
  if (!channel.guild) return;

  const embed = buildEmbed({
    title: '🗑️ Channel Deleted',
    color: Colors.Red,
    description:
      `**Name:** ${channel.name}\n` +
      `**Type:** ${channelTypeLabel(channel.type)}\n` +
      (channel.parent ? `**Category:** ${channel.parent.name}\n` : '') +
      `**ID:** ${channel.id}`,
  });

  await sendLog(channel.guild, embed);
});

client.on('channelUpdate', async (oldChannel, newChannel) => {
  if (!newChannel.guild) return;

  const changes = [];

  if (oldChannel.name !== newChannel.name) {
    changes.push(`**Name:** \`${oldChannel.name}\` → \`${newChannel.name}\``);
  }

  if ('topic' in oldChannel && oldChannel.topic !== newChannel.topic) {
    changes.push(
      `**Topic:** ${oldChannel.topic || '*(none)*'} → ${newChannel.topic || '*(none)*'}`,
    );
  }

  if ('rateLimitPerUser' in oldChannel && oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
    changes.push(
      `**Slowmode:** ${oldChannel.rateLimitPerUser}s → ${newChannel.rateLimitPerUser}s`,
    );
  }

  if ('nsfw' in oldChannel && oldChannel.nsfw !== newChannel.nsfw) {
    changes.push(`**NSFW:** ${oldChannel.nsfw} → ${newChannel.nsfw}`);
  }

  // ── Permission overwrite diff ──────────────────────────────────────────
  const oldOverwrites = oldChannel.permissionOverwrites?.cache ?? new Map();
  const newOverwrites = newChannel.permissionOverwrites?.cache ?? new Map();
  const allIds = new Set([...oldOverwrites.keys(), ...newOverwrites.keys()]);

  for (const id of allIds) {
    const oldOW = oldOverwrites.get(id);
    const newOW = newOverwrites.get(id);

    if (!oldOW && newOW) {
      changes.push(`**Permissions added for** <@${newOW.type === 0 ? '&' : ''}${id}>`);
      continue;
    }
    if (oldOW && !newOW) {
      changes.push(`**Permissions removed for** <@${oldOW.type === 0 ? '&' : ''}${id}>`);
      continue;
    }
    if (oldOW && newOW) {
      const allowDiff = diffPermissions(oldOW.allow.bitfield, newOW.allow.bitfield);
      const denyDiff  = diffPermissions(oldOW.deny.bitfield,  newOW.deny.bitfield);
      const target    = newOW.type === 0 ? `<@&${id}>` : `<@${id}>`;
      if (allowDiff) changes.push(`**Allow overwrite for ${target}:**\n${allowDiff}`);
      if (denyDiff)  changes.push(`**Deny overwrite for ${target}:**\n${denyDiff}`);
    }
  }

  if (changes.length === 0) return;

  const embed = buildEmbed({
    title: '✏️ Channel Updated',
    color: Colors.Yellow,
    description: `**Channel:** <#${newChannel.id}>\n${changes.join('\n')}`,
  });

  await sendLog(newChannel.guild, embed);
});

// ═══════════════════════════════════════════════════════════════════════════
// MEMBER LOGS
// Events: guildMemberAdd, guildMemberRemove, guildMemberUpdate
// ═══════════════════════════════════════════════════════════════════════════

client.on('guildMemberAdd', async (member) => {
  // ── Bot added ────────────────────────────────────────────────────────────
  if (member.user.bot) {
    const embed = buildEmbed({
      title: '🤖 Bot Added',
      color: Colors.Blurple,
      description:
        `**Bot:** ${member.user.tag} (${member.user.id})\n` +
        `**Account created:** <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`,
    });
    embed.setThumbnail(member.user.displayAvatarURL({ dynamic: true }));
    await sendLog(member.guild, embed);
    return;
  }

  // ── Security: flag suspiciously new accounts ─────────────────────────────
  const accountAgeDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
  const isNewAccount   = accountAgeDays < 7;

  // ── Invite tracking ───────────────────────────────────────────────────────
  let usedInvite = null;
  try {
    const cachedInvites  = inviteCache.get(member.guild.id) ?? new Map();
    const freshInvites   = await member.guild.invites.fetch();
    const freshMap       = new Map(freshInvites.map((inv) => [inv.code, inv]));

    for (const [code, freshInv] of freshMap) {
      const cached = cachedInvites.get(code);
      if (!cached || freshInv.uses > cached.uses) {
        usedInvite = freshInv;
        break;
      }
    }

    inviteCache.set(member.guild.id, freshMap);
  } catch {
    // Bot may lack MANAGE_GUILD — skip silently
  }

  const lines = [
    `**User:** ${member.user.tag} (${member.user.id})`,
    `**Account created:** <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`,
  ];
  if (usedInvite) {
    lines.push(
      `**Invite used:** \`${usedInvite.code}\`` +
      (usedInvite.inviter ? ` (created by ${usedInvite.inviter.tag})` : ''),
    );
  }
  if (isNewAccount) {
    lines.push(`⚠️ **New account** — created ${accountAgeDays.toFixed(1)} days ago`);
  }

  const embed = buildEmbed({
    title: isNewAccount ? '⚠️ Member Joined (New Account)' : '👋 Member Joined',
    color: isNewAccount ? Colors.Orange : Colors.Green,
    description: lines.join('\n'),
  });
  embed.setThumbnail(member.user.displayAvatarURL({ dynamic: true }));

  await sendLog(member.guild, embed);
});

client.on('guildMemberRemove', async (member) => {
  // ── Bot removed ───────────────────────────────────────────────────────────
  if (member.user.bot) {
    const embed = buildEmbed({
      title: '🤖 Bot Removed',
      color: Colors.Red,
      description: `**Bot:** ${member.user.tag} (${member.user.id})`,
    });
    embed.setThumbnail(member.user.displayAvatarURL({ dynamic: true }));
    await sendLog(member.guild, embed);
    return;
  }

  const embed = buildEmbed({
    title: '🚪 Member Left',
    color: Colors.Orange,
    description:
      `**User:** ${member.user.tag} (${member.user.id})\n` +
      `**Joined:** ${
        member.joinedAt
          ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`
          : 'Unknown'
      }`,
  });
  embed.setThumbnail(member.user.displayAvatarURL({ dynamic: true }));

  await sendLog(member.guild, embed);
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const changes = [];

  // ── Username / global display name ────────────────────────────────────────
  if (oldMember.user.username !== newMember.user.username) {
    changes.push(
      `**Username:** \`${oldMember.user.username}\` → \`${newMember.user.username}\``,
    );
  }

  if (oldMember.user.globalName !== newMember.user.globalName) {
    changes.push(
      `**Global display name:** \`${oldMember.user.globalName ?? 'none'}\` → \`${newMember.user.globalName ?? 'none'}\``,
    );
  }

  // ── Nickname ──────────────────────────────────────────────────────────────
  if (oldMember.nickname !== newMember.nickname) {
    changes.push(
      `**Nickname:** \`${oldMember.nickname ?? 'none'}\` → \`${newMember.nickname ?? 'none'}\``,
    );
  }

  // ── Server boost ──────────────────────────────────────────────────────────
  const wasBoosting = !!oldMember.premiumSince;
  const isBoosting  = !!newMember.premiumSince;
  if (!wasBoosting && isBoosting) {
    changes.push('🚀 **Started boosting the server**');
  } else if (wasBoosting && !isBoosting) {
    changes.push('💔 **Stopped boosting the server**');
  }

  // ── Roles added / removed ─────────────────────────────────────────────────
  const addedRoles   = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
  const removedRoles = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id));

  if (addedRoles.size)   changes.push(`**Roles added:** ${addedRoles.map((r) => `<@&${r.id}>`).join(', ')}`);
  if (removedRoles.size) changes.push(`**Roles removed:** ${removedRoles.map((r) => `<@&${r.id}>`).join(', ')}`);

  if (changes.length === 0) return;

  const embed = buildEmbed({
    title: '👤 Member Updated',
    color: Colors.Yellow,
    description:
      `**User:** ${newMember.user.tag} (${newMember.user.id})\n` +
      changes.join('\n'),
  });
  embed.setThumbnail(newMember.user.displayAvatarURL({ dynamic: true }));

  await sendLog(newMember.guild, embed);
});

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGE LOGS
// Events: messageDelete, messageUpdate
// ═══════════════════════════════════════════════════════════════════════════

client.on('messageDelete', async (message) => {
  if (!message.guild) return;
  if (message.partial) return;
  if (message.author?.bot) return;

  const embed = buildEmbed({
    title: '🗑️ Message Deleted',
    color: Colors.Red,
    description:
      `**Author:** ${message.author?.tag ?? 'Unknown'} (${message.author?.id ?? 'Unknown'})\n` +
      `**Channel:** <#${message.channelId}>\n` +
      `**Content:**\n${truncate(message.content || '*(no text content)*', 1800)}`,
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
      `**Before:**\n${truncate(oldMessage.content || '*(no text content)*', 800)}\n\n` +
      `**After:**\n${truncate(newMessage.content || '*(no text content)*', 800)}`,
  });

  await sendLog(newMessage.guild, embed);
});

// ═══════════════════════════════════════════════════════════════════════════
// ROLE LOGS
// Events: roleCreate, roleDelete, roleUpdate
// ═══════════════════════════════════════════════════════════════════════════

client.on('roleCreate', async (role) => {
  const embed = buildEmbed({
    title: '🎭 Role Created',
    color: Colors.Green,
    description:
      `**Name:** ${role.name}\n` +
      `**Color:** ${role.hexColor}\n` +
      `**Hoisted:** ${role.hoist}\n` +
      `**Mentionable:** ${role.mentionable}\n` +
      `**ID:** ${role.id}`,
  });

  await sendLog(role.guild, embed);
});

client.on('roleDelete', async (role) => {
  const embed = buildEmbed({
    title: '🎭 Role Deleted',
    color: Colors.Red,
    description:
      `**Name:** ${role.name}\n` +
      `**Color:** ${role.hexColor}\n` +
      `**ID:** ${role.id}`,
  });

  await sendLog(role.guild, embed);
});

client.on('roleUpdate', async (oldRole, newRole) => {
  const changes = [];

  if (oldRole.name !== newRole.name) {
    changes.push(`**Name:** \`${oldRole.name}\` → \`${newRole.name}\``);
  }

  if (oldRole.hexColor !== newRole.hexColor) {
    changes.push(`**Color:** \`${oldRole.hexColor}\` → \`${newRole.hexColor}\``);
  }

  if (oldRole.hoist !== newRole.hoist) {
    changes.push(`**Hoisted:** ${oldRole.hoist} → ${newRole.hoist}`);
  }

  if (oldRole.mentionable !== newRole.mentionable) {
    changes.push(`**Mentionable:** ${oldRole.mentionable} → ${newRole.mentionable}`);
  }

  if (oldRole.position !== newRole.position) {
    changes.push(`**Position:** ${oldRole.position} → ${newRole.position}`);
  }

  // Role icon (requires ROLE_ICONS feature)
  if (oldRole.icon !== newRole.icon) {
    changes.push(`**Icon changed**`);
  }

  // Permission diff
  const permDiff = diffPermissions(oldRole.permissions.bitfield, newRole.permissions.bitfield);
  if (permDiff) changes.push(`**Permissions:**\n${permDiff}`);

  if (changes.length === 0) return;

  const embed = buildEmbed({
    title: '✏️ Role Updated',
    color: Colors.Yellow,
    description: `**Role:** <@&${newRole.id}>\n${changes.join('\n')}`,
  });

  await sendLog(newRole.guild, embed);
});

// ═══════════════════════════════════════════════════════════════════════════
// VOICE LOGS
// Events: voiceStateUpdate
// ═══════════════════════════════════════════════════════════════════════════

client.on('voiceStateUpdate', async (oldState, newState) => {
  const member = newState.member ?? oldState.member;
  if (!member) return;
  if (member.user.bot) return; // ignore bot voice activity

  const guild = newState.guild ?? oldState.guild;
  const lines = [`**User:** ${member.user.tag} (${member.user.id})`];
  let title = '';
  let color = Colors.Blurple;

  // ── Channel join / leave / switch ─────────────────────────────────────────
  if (!oldState.channelId && newState.channelId) {
    title = '🔊 Joined Voice Channel';
    color = Colors.Green;
    lines.push(`**Channel:** <#${newState.channelId}>`);
  } else if (oldState.channelId && !newState.channelId) {
    title = '🔇 Left Voice Channel';
    color = Colors.Red;
    lines.push(`**Channel:** <#${oldState.channelId}>`);
  } else if (oldState.channelId !== newState.channelId) {
    title = '🔀 Switched Voice Channel';
    color = Colors.Yellow;
    lines.push(`**From:** <#${oldState.channelId}> → **To:** <#${newState.channelId}>`);
  } else {
    // Same channel — state change
    title = '🎙️ Voice State Changed';
    color = Colors.Blurple;
    lines.push(`**Channel:** <#${newState.channelId}>`);
  }

  // ── State flags ───────────────────────────────────────────────────────────
  const flags = [];

  if (oldState.selfMute !== newState.selfMute) {
    flags.push(newState.selfMute ? '🔇 Self-muted' : '🔊 Self-unmuted');
  }
  if (oldState.selfDeaf !== newState.selfDeaf) {
    flags.push(newState.selfDeaf ? '🙉 Self-deafened' : '👂 Self-undeafened');
  }
  if (oldState.serverMute !== newState.serverMute) {
    flags.push(newState.serverMute ? '🔇 Server muted' : '🔊 Server unmuted');
  }
  if (oldState.serverDeaf !== newState.serverDeaf) {
    flags.push(newState.serverDeaf ? '🙉 Server deafened' : '👂 Server undeafened');
  }
  if (oldState.streaming !== newState.streaming) {
    flags.push(newState.streaming ? '📡 Started screen share' : '📡 Stopped screen share');
  }
  if (oldState.selfVideo !== newState.selfVideo) {
    flags.push(newState.selfVideo ? '📷 Camera on' : '📷 Camera off');
  }

  // If the only thing that changed is a state flag (no channel change), skip
  // logging pure self-mute/deafen spam unless there's something meaningful.
  if (
    title === '🎙️ Voice State Changed' &&
    flags.length === 0
  ) return;

  if (flags.length) lines.push(flags.join('\n'));

  const embed = buildEmbed({ title, color, description: lines.join('\n') });
  await sendLog(guild, embed);
});

// ═══════════════════════════════════════════════════════════════════════════
// SERVER / GUILD LOGS
// Events: guildUpdate
// ═══════════════════════════════════════════════════════════════════════════

client.on('guildUpdate', async (oldGuild, newGuild) => {
  const changes = [];

  if (oldGuild.name !== newGuild.name) {
    changes.push(`**Name:** \`${oldGuild.name}\` → \`${newGuild.name}\``);
  }

  if (oldGuild.icon !== newGuild.icon) {
    changes.push(
      `**Icon:** ${newGuild.iconURL() ? `[new icon](${newGuild.iconURL()})` : 'removed'}`,
    );
  }

  if (oldGuild.banner !== newGuild.banner) {
    changes.push(
      `**Banner:** ${newGuild.bannerURL() ? `[new banner](${newGuild.bannerURL()})` : 'removed'}`,
    );
  }

  if (oldGuild.splash !== newGuild.splash) {
    changes.push(`**Invite splash:** ${newGuild.splashURL() ? 'updated' : 'removed'}`);
  }

  if (oldGuild.verificationLevel !== newGuild.verificationLevel) {
    changes.push(
      `**Verification level:** ${oldGuild.verificationLevel} → ${newGuild.verificationLevel}`,
    );
  }

  if (oldGuild.explicitContentFilter !== newGuild.explicitContentFilter) {
    changes.push(
      `**Explicit content filter:** ${oldGuild.explicitContentFilter} → ${newGuild.explicitContentFilter}`,
    );
  }

  if (oldGuild.defaultMessageNotifications !== newGuild.defaultMessageNotifications) {
    changes.push(
      `**Default notifications:** ${oldGuild.defaultMessageNotifications} → ${newGuild.defaultMessageNotifications}`,
    );
  }

  if (oldGuild.afkChannelId !== newGuild.afkChannelId) {
    const oldAfk = oldGuild.afkChannelId ? `<#${oldGuild.afkChannelId}>` : 'none';
    const newAfk = newGuild.afkChannelId ? `<#${newGuild.afkChannelId}>` : 'none';
    changes.push(`**AFK channel:** ${oldAfk} → ${newAfk}`);
  }

  if (oldGuild.afkTimeout !== newGuild.afkTimeout) {
    changes.push(`**AFK timeout:** ${oldGuild.afkTimeout}s → ${newGuild.afkTimeout}s`);
  }

  if (oldGuild.systemChannelId !== newGuild.systemChannelId) {
    const oldSys = oldGuild.systemChannelId ? `<#${oldGuild.systemChannelId}>` : 'none';
    const newSys = newGuild.systemChannelId ? `<#${newGuild.systemChannelId}>` : 'none';
    changes.push(`**System channel:** ${oldSys} → ${newSys}`);
  }

  if (oldGuild.rulesChannelId !== newGuild.rulesChannelId) {
    const oldRules = oldGuild.rulesChannelId ? `<#${oldGuild.rulesChannelId}>` : 'none';
    const newRules = newGuild.rulesChannelId ? `<#${newGuild.rulesChannelId}>` : 'none';
    changes.push(`**Rules channel:** ${oldRules} → ${newRules}`);
  }

  if (oldGuild.publicUpdatesChannelId !== newGuild.publicUpdatesChannelId) {
    const oldPub = oldGuild.publicUpdatesChannelId ? `<#${oldGuild.publicUpdatesChannelId}>` : 'none';
    const newPub = newGuild.publicUpdatesChannelId ? `<#${newGuild.publicUpdatesChannelId}>` : 'none';
    changes.push(`**Community updates channel:** ${oldPub} → ${newPub}`);
  }

  if (changes.length === 0) return;

  const embed = buildEmbed({
    title: '🏰 Server Updated',
    color: Colors.Yellow,
    description: `**Server:** ${newGuild.name}\n${changes.join('\n')}`,
  });
  if (newGuild.iconURL()) embed.setThumbnail(newGuild.iconURL());

  await sendLog(newGuild, embed);
});

// ═══════════════════════════════════════════════════════════════════════════
// INVITE LOGS
// Events: inviteCreate, inviteDelete
// ═══════════════════════════════════════════════════════════════════════════

client.on('inviteCreate', async (invite) => {
  // Update cache
  const guildCache = inviteCache.get(invite.guild?.id) ?? new Map();
  guildCache.set(invite.code, invite);
  if (invite.guild) inviteCache.set(invite.guild.id, guildCache);

  const embed = buildEmbed({
    title: '🔗 Invite Created',
    color: Colors.Green,
    description:
      `**Code:** \`${invite.code}\`\n` +
      `**Created by:** ${invite.inviter?.tag ?? 'Unknown'}\n` +
      `**Channel:** ${invite.channel ? `<#${invite.channel.id}>` : 'Unknown'}\n` +
      `**Max uses:** ${invite.maxUses || '∞'}\n` +
      `**Expires:** ${invite.expiresAt ? `<t:${Math.floor(invite.expiresTimestamp / 1000)}:R>` : 'Never'}`,
  });

  await sendLog(invite.guild, embed);
});

client.on('inviteDelete', async (invite) => {
  // Update cache
  const guildCache = inviteCache.get(invite.guild?.id);
  if (guildCache) guildCache.delete(invite.code);

  const embed = buildEmbed({
    title: '🔗 Invite Deleted',
    color: Colors.Red,
    description:
      `**Code:** \`${invite.code}\`\n` +
      `**Channel:** ${invite.channel ? `<#${invite.channel.id}>` : 'Unknown'}`,
  });

  await sendLog(invite.guild, embed);
});

// ═══════════════════════════════════════════════════════════════════════════
// THREAD LOGS  (also covers Forum posts — forum posts are threads)
// Events: threadCreate, threadDelete, threadUpdate
// ═══════════════════════════════════════════════════════════════════════════

/** Returns true if the thread lives inside a Forum or Media channel. */
function isForumPost(thread) {
  const parentType = thread.parent?.type;
  return (
    parentType === ChannelType.GuildForum ||
    parentType === ChannelType.GuildMedia
  );
}

client.on('threadCreate', async (thread, newlyCreated) => {
  if (!newlyCreated) return; // ignore threads the bot just gained access to

  const forum  = isForumPost(thread);
  const title  = forum ? '📌 Forum Post Created' : '🧵 Thread Created';
  const color  = Colors.Green;

  const embed = buildEmbed({
    title,
    color,
    description:
      `**Name:** ${thread.name}\n` +
      `**Type:** ${channelTypeLabel(thread.type)}\n` +
      (thread.parent ? `**${forum ? 'Forum' : 'Channel'}:** <#${thread.parent.id}>\n` : '') +
      `**Created by:** ${thread.ownerId ? `<@${thread.ownerId}>` : 'Unknown'}\n` +
      `**ID:** ${thread.id}`,
  });

  await sendLog(thread.guild, embed);
});

client.on('threadDelete', async (thread) => {
  const forum = isForumPost(thread);
  const title = forum ? '📌 Forum Post Deleted' : '🧵 Thread Deleted';

  const embed = buildEmbed({
    title,
    color: Colors.Red,
    description:
      `**Name:** ${thread.name}\n` +
      (thread.parent ? `**${forum ? 'Forum' : 'Channel'}:** <#${thread.parent.id}>\n` : '') +
      `**ID:** ${thread.id}`,
  });

  await sendLog(thread.guild, embed);
});

client.on('threadUpdate', async (oldThread, newThread) => {
  const changes = [];

  if (oldThread.name !== newThread.name) {
    changes.push(`**Name:** \`${oldThread.name}\` → \`${newThread.name}\``);
  }

  if (oldThread.archived !== newThread.archived) {
    changes.push(newThread.archived ? '📦 **Archived**' : '📂 **Unarchived**');
  }

  if (oldThread.locked !== newThread.locked) {
    changes.push(newThread.locked ? '🔒 **Locked**' : '🔓 **Unlocked**');
  }

  if (oldThread.rateLimitPerUser !== newThread.rateLimitPerUser) {
    changes.push(
      `**Slowmode:** ${oldThread.rateLimitPerUser}s → ${newThread.rateLimitPerUser}s`,
    );
  }

  if (changes.length === 0) return;

  const forum = isForumPost(newThread);
  const embed = buildEmbed({
    title: forum ? '📌 Forum Post Updated' : '🧵 Thread Updated',
    color: Colors.Yellow,
    description:
      `**Thread:** ${newThread.name}\n` +
      (newThread.parent ? `**${forum ? 'Forum' : 'Channel'}:** <#${newThread.parent.id}>\n` : '') +
      changes.join('\n'),
  });

  await sendLog(newThread.guild, embed);
});

// ═══════════════════════════════════════════════════════════════════════════
// EMOJI & STICKER LOGS
// Events: emojiCreate, emojiDelete, emojiUpdate, stickerCreate, stickerDelete, stickerUpdate
// ═══════════════════════════════════════════════════════════════════════════

client.on('emojiCreate', async (emoji) => {
  const embed = buildEmbed({
    title: '😀 Emoji Added',
    color: Colors.Green,
    description:
      `**Name:** \`:${emoji.name}:\`\n` +
      `**Animated:** ${emoji.animated}\n` +
      `**ID:** ${emoji.id}`,
  });
  embed.setThumbnail(emoji.imageURL());

  await sendLog(emoji.guild, embed);
});

client.on('emojiDelete', async (emoji) => {
  const embed = buildEmbed({
    title: '😀 Emoji Removed',
    color: Colors.Red,
    description:
      `**Name:** \`:${emoji.name}:\`\n` +
      `**Animated:** ${emoji.animated}\n` +
      `**ID:** ${emoji.id}`,
  });

  await sendLog(emoji.guild, embed);
});

client.on('emojiUpdate', async (oldEmoji, newEmoji) => {
  if (oldEmoji.name === newEmoji.name) return;

  const embed = buildEmbed({
    title: '😀 Emoji Updated',
    color: Colors.Yellow,
    description:
      `**Name:** \`:${oldEmoji.name}:\` → \`:${newEmoji.name}:\`\n` +
      `**ID:** ${newEmoji.id}`,
  });
  embed.setThumbnail(newEmoji.imageURL());

  await sendLog(newEmoji.guild, embed);
});

client.on('stickerCreate', async (sticker) => {
  const embed = buildEmbed({
    title: '🪄 Sticker Added',
    color: Colors.Green,
    description:
      `**Name:** ${sticker.name}\n` +
      `**Description:** ${sticker.description || '*(none)*'}\n` +
      `**ID:** ${sticker.id}`,
  });

  await sendLog(sticker.guild, embed);
});

client.on('stickerDelete', async (sticker) => {
  const embed = buildEmbed({
    title: '🪄 Sticker Removed',
    color: Colors.Red,
    description:
      `**Name:** ${sticker.name}\n` +
      `**ID:** ${sticker.id}`,
  });

  await sendLog(sticker.guild, embed);
});

client.on('stickerUpdate', async (oldSticker, newSticker) => {
  const changes = [];

  if (oldSticker.name !== newSticker.name) {
    changes.push(`**Name:** \`${oldSticker.name}\` → \`${newSticker.name}\``);
  }
  if (oldSticker.description !== newSticker.description) {
    changes.push(
      `**Description:** ${oldSticker.description || '*(none)*'} → ${newSticker.description || '*(none)*'}`,
    );
  }

  if (changes.length === 0) return;

  const embed = buildEmbed({
    title: '🪄 Sticker Updated',
    color: Colors.Yellow,
    description: `**ID:** ${newSticker.id}\n${changes.join('\n')}`,
  });

  await sendLog(newSticker.guild, embed);
});

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK LOGS
// Events: webhooksUpdate
// Note: discord.js v14 fires 'webhooksUpdate' (not individual create/delete/update
// events). We fetch the current webhook list and diff against a local cache.
// ═══════════════════════════════════════════════════════════════════════════

/** channel ID → Map<webhookId, Webhook> */
const webhookCache = new Map();

client.on('webhooksUpdate', async (channel) => {
  if (!channel.guild) return;

  let freshWebhooks;
  try {
    freshWebhooks = await channel.fetchWebhooks();
  } catch {
    return; // Missing MANAGE_WEBHOOKS permission
  }

  const cached = webhookCache.get(channel.id) ?? new Map();
  const fresh  = new Map(freshWebhooks.map((wh) => [wh.id, wh]));

  // Detect created webhooks
  for (const [id, wh] of fresh) {
    if (!cached.has(id)) {
      const embed = buildEmbed({
        title: '🪝 Webhook Created',
        color: Colors.Green,
        description:
          `**Name:** ${wh.name}\n` +
          `**Channel:** <#${channel.id}>\n` +
          `**Created by:** ${wh.owner?.tag ?? 'Unknown'}\n` +
          `**ID:** ${wh.id}`,
      });
      await sendLog(channel.guild, embed);
    }
  }

  // Detect deleted webhooks
  for (const [id, wh] of cached) {
    if (!fresh.has(id)) {
      const embed = buildEmbed({
        title: '🪝 Webhook Deleted',
        color: Colors.Red,
        description:
          `**Name:** ${wh.name}\n` +
          `**Channel:** <#${channel.id}>\n` +
          `**ID:** ${wh.id}`,
      });
      await sendLog(channel.guild, embed);
    }
  }

  // Detect updated webhooks (name or channel changed)
  for (const [id, freshWh] of fresh) {
    const cachedWh = cached.get(id);
    if (!cachedWh) continue;

    const changes = [];
    if (cachedWh.name !== freshWh.name) {
      changes.push(`**Name:** \`${cachedWh.name}\` → \`${freshWh.name}\``);
    }
    if (cachedWh.channelId !== freshWh.channelId) {
      changes.push(`**Channel:** <#${cachedWh.channelId}> → <#${freshWh.channelId}>`);
    }

    if (changes.length > 0) {
      const embed = buildEmbed({
        title: '🪝 Webhook Updated',
        color: Colors.Yellow,
        description:
          `**ID:** ${freshWh.id}\n` +
          changes.join('\n'),
      });
      await sendLog(channel.guild, embed);
    }
  }

  // Update cache
  webhookCache.set(channel.id, fresh);
});

// ═══════════════════════════════════════════════════════════════════════════
// MODERATION LOGS  —  ⚠️  DISABLED / STUBBED
//
// These handlers are intentionally left as no-ops. A dedicated moderation
// bot will handle bans, kicks, timeouts, warnings, and mutes. Once that bot
// is ready, replace each stub body with the appropriate logging logic and
// ensure the GuildModeration intent remains enabled.
//
// Stubs: memberBanned, memberUnbanned, memberKicked,
//        timeoutApplied, timeoutRemoved,
//        warningIssued, warningRemoved,
//        muteApplied, muteRemoved
// ═══════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line no-unused-vars
async function memberBanned(_ban)         { /* STUB — moderation bot will handle this */ }
// eslint-disable-next-line no-unused-vars
async function memberUnbanned(_ban)       { /* STUB — moderation bot will handle this */ }
// eslint-disable-next-line no-unused-vars
async function memberKicked(_member)      { /* STUB — moderation bot will handle this */ }
// eslint-disable-next-line no-unused-vars
async function timeoutApplied(_member)    { /* STUB — moderation bot will handle this */ }
// eslint-disable-next-line no-unused-vars
async function timeoutRemoved(_member)    { /* STUB — moderation bot will handle this */ }
// eslint-disable-next-line no-unused-vars
async function warningIssued(_member)     { /* STUB — moderation bot will handle this */ }
// eslint-disable-next-line no-unused-vars
async function warningRemoved(_member)    { /* STUB — moderation bot will handle this */ }
// eslint-disable-next-line no-unused-vars
async function muteApplied(_member)       { /* STUB — moderation bot will handle this */ }
// eslint-disable-next-line no-unused-vars
async function muteRemoved(_member)       { /* STUB — moderation bot will handle this */ }

// The guildBanAdd / guildBanRemove events are intentionally NOT registered
// here. When the moderation bot is ready, wire them up like so:
//
//   client.on('guildBanAdd',    memberBanned);
//   client.on('guildBanRemove', memberUnbanned);

// ═══════════════════════════════════════════════════════════════════════════
// Global error handling
// ═══════════════════════════════════════════════════════════════════════════

client.on('error', (err) => {
  console.error('[CLIENT ERROR]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

// ═══════════════════════════════════════════════════════════════════════════
// Login
// ═══════════════════════════════════════════════════════════════════════════

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('[FATAL] DISCORD_TOKEN environment variable is not set. Exiting.');
  process.exit(1);
}

client.login(token);

