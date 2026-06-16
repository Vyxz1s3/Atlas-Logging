require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionsBitField,
} = require('discord.js');

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
 * Resolve the log channel and send a JSON log object as a code block.
 * Falls back to console.log when LOG_CHANNEL_ID is not set or the channel
 * cannot be found.
 *
 * @param {import('discord.js').Guild|null} guild
 * @param {object} logObject  Plain JS object describing the event
 */
async function sendLog(guild, logObject) {
  const channelId = process.env.LOG_CHANNEL_ID;

  console.log('[LOG]', JSON.stringify(logObject, null, 2));

  if (!channelId) return;

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

    const json    = JSON.stringify(logObject, null, 2);
    // Discord messages are capped at 2000 characters; truncate the payload
    // inside the code block if necessary so the send never fails.
    const maxJson = 1980; // 2000 − len("```json\n" + "\n```")
    const body    = json.length > maxJson ? json.slice(0, maxJson - 1) + '…' : json;

    await channel.send(`\`\`\`json\n${body}\n\`\`\``);
  } catch (err) {
    console.error('[ERROR] Failed to send log message:', err);
  }
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
 * Diff two PermissionsBitField values and return an object with added/removed
 * permission name arrays, or null if nothing changed.
 *
 * @param {bigint} oldBits
 * @param {bigint} newBits
 * @returns {{ added: string[], removed: string[] }|null}
 */
function diffPermissions(oldBits, newBits) {
  if (oldBits === newBits) return null;

  const added   = new PermissionsBitField(newBits & ~oldBits).toArray();
  const removed = new PermissionsBitField(oldBits & ~newBits).toArray();

  if (!added.length && !removed.length) return null;
  return { added, removed };
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
});

// ═══════════════════════════════════════════════════════════════════════════
// CHANNEL LOGS
// Events: channelCreate, channelDelete, channelUpdate
// ═══════════════════════════════════════════════════════════════════════════

client.on('channelCreate', async (channel) => {
  if (!channel.guild) return; // ignore DM channels

  await sendLog(channel.guild, {
    event:     'channelCreate',
    timestamp: new Date().toISOString(),
    guild:     { id: channel.guild.id, name: channel.guild.name },
    data: {
      id:       channel.id,
      name:     channel.name,
      type:     channelTypeLabel(channel.type),
      category: channel.parent?.name ?? null,
    },
  });
});

client.on('channelDelete', async (channel) => {
  if (!channel.guild) return;

  await sendLog(channel.guild, {
    event:     'channelDelete',
    timestamp: new Date().toISOString(),
    guild:     { id: channel.guild.id, name: channel.guild.name },
    data: {
      id:       channel.id,
      name:     channel.name,
      type:     channelTypeLabel(channel.type),
      category: channel.parent?.name ?? null,
    },
  });
});

client.on('channelUpdate', async (oldChannel, newChannel) => {
  if (!newChannel.guild) return;

  const changes = {};

  if (oldChannel.name !== newChannel.name) {
    changes.name = { from: oldChannel.name, to: newChannel.name };
  }

  if ('topic' in oldChannel && oldChannel.topic !== newChannel.topic) {
    changes.topic = { from: oldChannel.topic ?? null, to: newChannel.topic ?? null };
  }

  if ('rateLimitPerUser' in oldChannel && oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
    changes.slowmode = { from: oldChannel.rateLimitPerUser, to: newChannel.rateLimitPerUser };
  }

  if ('nsfw' in oldChannel && oldChannel.nsfw !== newChannel.nsfw) {
    changes.nsfw = { from: oldChannel.nsfw, to: newChannel.nsfw };
  }

  // ── Permission overwrite diff ──────────────────────────────────────────
  const oldOverwrites = oldChannel.permissionOverwrites?.cache ?? new Map();
  const newOverwrites = newChannel.permissionOverwrites?.cache ?? new Map();
  const allIds = new Set([...oldOverwrites.keys(), ...newOverwrites.keys()]);
  const permissionChanges = [];

  for (const id of allIds) {
    const oldOW = oldOverwrites.get(id);
    const newOW = newOverwrites.get(id);
    const targetType = (newOW ?? oldOW).type === 0 ? 'role' : 'member';

    if (!oldOW && newOW) {
      permissionChanges.push({ id, targetType, action: 'added' });
      continue;
    }
    if (oldOW && !newOW) {
      permissionChanges.push({ id, targetType, action: 'removed' });
      continue;
    }
    if (oldOW && newOW) {
      const allowDiff = diffPermissions(oldOW.allow.bitfield, newOW.allow.bitfield);
      const denyDiff  = diffPermissions(oldOW.deny.bitfield,  newOW.deny.bitfield);
      if (allowDiff || denyDiff) {
        permissionChanges.push({
          id,
          targetType,
          action:  'updated',
          allow:   allowDiff ?? undefined,
          deny:    denyDiff  ?? undefined,
        });
      }
    }
  }

  if (permissionChanges.length) changes.permissions = permissionChanges;

  if (Object.keys(changes).length === 0) return;

  await sendLog(newChannel.guild, {
    event:     'channelUpdate',
    timestamp: new Date().toISOString(),
    guild:     { id: newChannel.guild.id, name: newChannel.guild.name },
    data: {
      id:      newChannel.id,
      name:    newChannel.name,
      type:    channelTypeLabel(newChannel.type),
      changes,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MEMBER LOGS
// Events: guildMemberAdd, guildMemberRemove, guildMemberUpdate
// ═══════════════════════════════════════════════════════════════════════════

client.on('guildMemberAdd', async (member) => {
  // ── Bot added ────────────────────────────────────────────────────────────
  if (member.user.bot) {
    await sendLog(member.guild, {
      event:     'botAdd',
      timestamp: new Date().toISOString(),
      guild:     { id: member.guild.id, name: member.guild.name },
      data: {
        id:             member.user.id,
        tag:            member.user.tag,
        accountCreated: new Date(member.user.createdTimestamp).toISOString(),
        avatarURL:      member.user.displayAvatarURL({ dynamic: true }),
      },
    });
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

  await sendLog(member.guild, {
    event:     'memberJoin',
    timestamp: new Date().toISOString(),
    guild:     { id: member.guild.id, name: member.guild.name },
    data: {
      id:              member.user.id,
      tag:             member.user.tag,
      accountCreated:  new Date(member.user.createdTimestamp).toISOString(),
      accountAgeDays:  parseFloat(accountAgeDays.toFixed(2)),
      newAccount:      isNewAccount,
      avatarURL:       member.user.displayAvatarURL({ dynamic: true }),
      invite:          usedInvite
        ? {
            code:    usedInvite.code,
            inviter: usedInvite.inviter?.tag ?? null,
          }
        : null,
    },
  });
});

client.on('guildMemberRemove', async (member) => {
  // ── Bot removed ───────────────────────────────────────────────────────────
  if (member.user.bot) {
    await sendLog(member.guild, {
      event:     'botRemove',
      timestamp: new Date().toISOString(),
      guild:     { id: member.guild.id, name: member.guild.name },
      data: {
        id:        member.user.id,
        tag:       member.user.tag,
        avatarURL: member.user.displayAvatarURL({ dynamic: true }),
      },
    });
    return;
  }

  await sendLog(member.guild, {
    event:     'memberLeave',
    timestamp: new Date().toISOString(),
    guild:     { id: member.guild.id, name: member.guild.name },
    data: {
      id:        member.user.id,
      tag:       member.user.tag,
      joinedAt:  member.joinedAt ? member.joinedAt.toISOString() : null,
      avatarURL: member.user.displayAvatarURL({ dynamic: true }),
    },
  });
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const changes = {};

  // ── Username / global display name ────────────────────────────────────────
  if (oldMember.user.username !== newMember.user.username) {
    changes.username = { from: oldMember.user.username, to: newMember.user.username };
  }

  if (oldMember.user.globalName !== newMember.user.globalName) {
    changes.globalName = {
      from: oldMember.user.globalName ?? null,
      to:   newMember.user.globalName ?? null,
    };
  }

  // ── Nickname ──────────────────────────────────────────────────────────────
  if (oldMember.nickname !== newMember.nickname) {
    changes.nickname = { from: oldMember.nickname ?? null, to: newMember.nickname ?? null };
  }

  // ── Server boost ──────────────────────────────────────────────────────────
  const wasBoosting = !!oldMember.premiumSince;
  const isBoosting  = !!newMember.premiumSince;
  if (wasBoosting !== isBoosting) {
    changes.boosting = { from: wasBoosting, to: isBoosting };
  }

  // ── Roles added / removed ─────────────────────────────────────────────────
  const addedRoles   = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
  const removedRoles = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id));

  if (addedRoles.size) {
    changes.rolesAdded = addedRoles.map((r) => ({ id: r.id, name: r.name }));
  }
  if (removedRoles.size) {
    changes.rolesRemoved = removedRoles.map((r) => ({ id: r.id, name: r.name }));
  }

  if (Object.keys(changes).length === 0) return;

  await sendLog(newMember.guild, {
    event:     'memberUpdate',
    timestamp: new Date().toISOString(),
    guild:     { id: newMember.guild.id, name: newMember.guild.name },
    data: {
      id:        newMember.user.id,
      tag:       newMember.user.tag,
      avatarURL: newMember.user.displayAvatarURL({ dynamic: true }),
      changes,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGE LOGS
// Events: messageDelete, messageUpdate
// ═══════════════════════════════════════════════════════════════════════════

client.on('messageDelete', async (message) => {
  if (!message.guild) return;
  if (message.partial) return;
  if (message.author?.bot) return;

  await sendLog(message.guild, {
    event:     'messageDelete',
    timestamp: new Date().toISOString(),
    guild:     { id: message.guild.id, name: message.guild.name },
    data: {
      messageId: message.id,
      channelId: message.channelId,
      author:    { id: message.author?.id ?? null, tag: message.author?.tag ?? null },
      content:   truncate(message.content || null, 1800),
    },
  });
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!newMessage.guild) return;
  if (newMessage.partial) return;
  if (newMessage.author?.bot) return;
  if (oldMessage.content === newMessage.content) return; // embed-only update

  await sendLog(newMessage.guild, {
    event:     'messageEdit',
    timestamp: new Date().toISOString(),
    guild:     { id: newMessage.guild.id, name: newMessage.guild.name },
    data: {
      messageId: newMessage.id,
      channelId: newMessage.channelId,
      url:       newMessage.url,
      author:    { id: newMessage.author?.id ?? null, tag: newMessage.author?.tag ?? null },
      before:    truncate(oldMessage.content || null, 800),
      after:     truncate(newMessage.content || null, 800),
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ROLE LOGS
// Events: roleCreate, roleDelete, roleUpdate
// ═══════════════════════════════════════════════════════════════════════════

client.on('roleCreate', async (role) => {
  await sendLog(role.guild, {
    event:     'roleCreate',
    timestamp: new Date().toISOString(),
    guild:     { id: role.guild.id, name: role.guild.name },
    data: {
      id:          role.id,
      name:        role.name,
      color:       role.hexColor,
      hoisted:     role.hoist,
      mentionable: role.mentionable,
    },
  });
});

client.on('roleDelete', async (role) => {
  await sendLog(role.guild, {
    event:     'roleDelete',
    timestamp: new Date().toISOString(),
    guild:     { id: role.guild.id, name: role.guild.name },
    data: {
      id:    role.id,
      name:  role.name,
      color: role.hexColor,
    },
  });
});

client.on('roleUpdate', async (oldRole, newRole) => {
  const changes = {};

  if (oldRole.name !== newRole.name) {
    changes.name = { from: oldRole.name, to: newRole.name };
  }

  if (oldRole.hexColor !== newRole.hexColor) {
    changes.color = { from: oldRole.hexColor, to: newRole.hexColor };
  }

  if (oldRole.hoist !== newRole.hoist) {
    changes.hoisted = { from: oldRole.hoist, to: newRole.hoist };
  }

  if (oldRole.mentionable !== newRole.mentionable) {
    changes.mentionable = { from: oldRole.mentionable, to: newRole.mentionable };
  }

  if (oldRole.position !== newRole.position) {
    changes.position = { from: oldRole.position, to: newRole.position };
  }

  // Role icon (requires ROLE_ICONS feature)
  if (oldRole.icon !== newRole.icon) {
    changes.icon = { from: oldRole.icon ?? null, to: newRole.icon ?? null };
  }

  // Permission diff
  const permDiff = diffPermissions(oldRole.permissions.bitfield, newRole.permissions.bitfield);
  if (permDiff) changes.permissions = permDiff;

  if (Object.keys(changes).length === 0) return;

  await sendLog(newRole.guild, {
    event:     'roleUpdate',
    timestamp: new Date().toISOString(),
    guild:     { id: newRole.guild.id, name: newRole.guild.name },
    data: {
      id:      newRole.id,
      name:    newRole.name,
      changes,
    },
  });
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

  // ── Determine channel action ───────────────────────────────────────────────
  let action;
  if (!oldState.channelId && newState.channelId) {
    action = 'join';
  } else if (oldState.channelId && !newState.channelId) {
    action = 'leave';
  } else if (oldState.channelId !== newState.channelId) {
    action = 'switch';
  } else {
    action = 'stateChange';
  }

  // ── State flag changes ────────────────────────────────────────────────────
  const stateChanges = {};

  if (oldState.selfMute !== newState.selfMute)     stateChanges.selfMute     = newState.selfMute;
  if (oldState.selfDeaf !== newState.selfDeaf)     stateChanges.selfDeaf     = newState.selfDeaf;
  if (oldState.serverMute !== newState.serverMute) stateChanges.serverMute   = newState.serverMute;
  if (oldState.serverDeaf !== newState.serverDeaf) stateChanges.serverDeaf   = newState.serverDeaf;
  if (oldState.streaming !== newState.streaming)   stateChanges.streaming    = newState.streaming;
  if (oldState.selfVideo !== newState.selfVideo)   stateChanges.cameraOn     = newState.selfVideo;

  // Skip pure self-mute/deafen spam with no channel change
  if (action === 'stateChange' && Object.keys(stateChanges).length === 0) return;

  await sendLog(guild, {
    event:     'voiceStateUpdate',
    timestamp: new Date().toISOString(),
    guild:     { id: guild.id, name: guild.name },
    data: {
      user:         { id: member.user.id, tag: member.user.tag },
      action,
      fromChannel:  oldState.channelId ?? null,
      toChannel:    newState.channelId ?? null,
      stateChanges: Object.keys(stateChanges).length ? stateChanges : undefined,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SERVER / GUILD LOGS
// Events: guildUpdate
// ═══════════════════════════════════════════════════════════════════════════

client.on('guildUpdate', async (oldGuild, newGuild) => {
  const changes = {};

  if (oldGuild.name !== newGuild.name) {
    changes.name = { from: oldGuild.name, to: newGuild.name };
  }

  if (oldGuild.icon !== newGuild.icon) {
    changes.icon = { from: oldGuild.iconURL() ?? null, to: newGuild.iconURL() ?? null };
  }

  if (oldGuild.banner !== newGuild.banner) {
    changes.banner = { from: oldGuild.bannerURL() ?? null, to: newGuild.bannerURL() ?? null };
  }

  if (oldGuild.splash !== newGuild.splash) {
    changes.splash = { from: oldGuild.splashURL() ?? null, to: newGuild.splashURL() ?? null };
  }

  if (oldGuild.verificationLevel !== newGuild.verificationLevel) {
    changes.verificationLevel = { from: oldGuild.verificationLevel, to: newGuild.verificationLevel };
  }

  if (oldGuild.explicitContentFilter !== newGuild.explicitContentFilter) {
    changes.explicitContentFilter = { from: oldGuild.explicitContentFilter, to: newGuild.explicitContentFilter };
  }

  if (oldGuild.defaultMessageNotifications !== newGuild.defaultMessageNotifications) {
    changes.defaultMessageNotifications = { from: oldGuild.defaultMessageNotifications, to: newGuild.defaultMessageNotifications };
  }

  if (oldGuild.afkChannelId !== newGuild.afkChannelId) {
    changes.afkChannel = { from: oldGuild.afkChannelId ?? null, to: newGuild.afkChannelId ?? null };
  }

  if (oldGuild.afkTimeout !== newGuild.afkTimeout) {
    changes.afkTimeout = { from: oldGuild.afkTimeout, to: newGuild.afkTimeout };
  }

  if (oldGuild.systemChannelId !== newGuild.systemChannelId) {
    changes.systemChannel = { from: oldGuild.systemChannelId ?? null, to: newGuild.systemChannelId ?? null };
  }

  if (oldGuild.rulesChannelId !== newGuild.rulesChannelId) {
    changes.rulesChannel = { from: oldGuild.rulesChannelId ?? null, to: newGuild.rulesChannelId ?? null };
  }

  if (oldGuild.publicUpdatesChannelId !== newGuild.publicUpdatesChannelId) {
    changes.publicUpdatesChannel = { from: oldGuild.publicUpdatesChannelId ?? null, to: newGuild.publicUpdatesChannelId ?? null };
  }

  if (Object.keys(changes).length === 0) return;

  await sendLog(newGuild, {
    event:     'guildUpdate',
    timestamp: new Date().toISOString(),
    guild:     { id: newGuild.id, name: newGuild.name },
    data:      { changes },
  });
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

  await sendLog(invite.guild, {
    event:     'inviteCreate',
    timestamp: new Date().toISOString(),
    guild:     invite.guild ? { id: invite.guild.id, name: invite.guild.name } : null,
    data: {
      code:      invite.code,
      createdBy: invite.inviter?.tag ?? null,
      channelId: invite.channel?.id ?? null,
      maxUses:   invite.maxUses || null,
      expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
    },
  });
});

client.on('inviteDelete', async (invite) => {
  // Update cache
  const guildCache = inviteCache.get(invite.guild?.id);
  if (guildCache) guildCache.delete(invite.code);

  await sendLog(invite.guild, {
    event:     'inviteDelete',
    timestamp: new Date().toISOString(),
    guild:     invite.guild ? { id: invite.guild.id, name: invite.guild.name } : null,
    data: {
      code:      invite.code,
      channelId: invite.channel?.id ?? null,
    },
  });
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

  const forum = isForumPost(thread);

  await sendLog(thread.guild, {
    event:     forum ? 'forumPostCreate' : 'threadCreate',
    timestamp: new Date().toISOString(),
    guild:     { id: thread.guild.id, name: thread.guild.name },
    data: {
      id:        thread.id,
      name:      thread.name,
      type:      channelTypeLabel(thread.type),
      parentId:  thread.parent?.id ?? null,
      createdBy: thread.ownerId ?? null,
    },
  });
});

client.on('threadDelete', async (thread) => {
  const forum = isForumPost(thread);

  await sendLog(thread.guild, {
    event:     forum ? 'forumPostDelete' : 'threadDelete',
    timestamp: new Date().toISOString(),
    guild:     { id: thread.guild.id, name: thread.guild.name },
    data: {
      id:       thread.id,
      name:     thread.name,
      parentId: thread.parent?.id ?? null,
    },
  });
});

client.on('threadUpdate', async (oldThread, newThread) => {
  const changes = {};

  if (oldThread.name !== newThread.name) {
    changes.name = { from: oldThread.name, to: newThread.name };
  }

  if (oldThread.archived !== newThread.archived) {
    changes.archived = { from: oldThread.archived, to: newThread.archived };
  }

  if (oldThread.locked !== newThread.locked) {
    changes.locked = { from: oldThread.locked, to: newThread.locked };
  }

  if (oldThread.rateLimitPerUser !== newThread.rateLimitPerUser) {
    changes.slowmode = { from: oldThread.rateLimitPerUser, to: newThread.rateLimitPerUser };
  }

  if (Object.keys(changes).length === 0) return;

  const forum = isForumPost(newThread);

  await sendLog(newThread.guild, {
    event:     forum ? 'forumPostUpdate' : 'threadUpdate',
    timestamp: new Date().toISOString(),
    guild:     { id: newThread.guild.id, name: newThread.guild.name },
    data: {
      id:       newThread.id,
      name:     newThread.name,
      parentId: newThread.parent?.id ?? null,
      changes,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EMOJI & STICKER LOGS
// Events: emojiCreate, emojiDelete, emojiUpdate, stickerCreate, stickerDelete, stickerUpdate
// ═══════════════════════════════════════════════════════════════════════════

client.on('emojiCreate', async (emoji) => {
  await sendLog(emoji.guild, {
    event:     'emojiCreate',
    timestamp: new Date().toISOString(),
    guild:     { id: emoji.guild.id, name: emoji.guild.name },
    data: {
      id:       emoji.id,
      name:     emoji.name,
      animated: emoji.animated,
      imageURL: emoji.imageURL(),
    },
  });
});

client.on('emojiDelete', async (emoji) => {
  await sendLog(emoji.guild, {
    event:     'emojiDelete',
    timestamp: new Date().toISOString(),
    guild:     { id: emoji.guild.id, name: emoji.guild.name },
    data: {
      id:       emoji.id,
      name:     emoji.name,
      animated: emoji.animated,
    },
  });
});

client.on('emojiUpdate', async (oldEmoji, newEmoji) => {
  if (oldEmoji.name === newEmoji.name) return;

  await sendLog(newEmoji.guild, {
    event:     'emojiUpdate',
    timestamp: new Date().toISOString(),
    guild:     { id: newEmoji.guild.id, name: newEmoji.guild.name },
    data: {
      id:       newEmoji.id,
      imageURL: newEmoji.imageURL(),
      changes:  { name: { from: oldEmoji.name, to: newEmoji.name } },
    },
  });
});

client.on('stickerCreate', async (sticker) => {
  await sendLog(sticker.guild, {
    event:     'stickerCreate',
    timestamp: new Date().toISOString(),
    guild:     { id: sticker.guild.id, name: sticker.guild.name },
    data: {
      id:          sticker.id,
      name:        sticker.name,
      description: sticker.description || null,
    },
  });
});

client.on('stickerDelete', async (sticker) => {
  await sendLog(sticker.guild, {
    event:     'stickerDelete',
    timestamp: new Date().toISOString(),
    guild:     { id: sticker.guild.id, name: sticker.guild.name },
    data: {
      id:   sticker.id,
      name: sticker.name,
    },
  });
});

client.on('stickerUpdate', async (oldSticker, newSticker) => {
  const changes = {};

  if (oldSticker.name !== newSticker.name) {
    changes.name = { from: oldSticker.name, to: newSticker.name };
  }
  if (oldSticker.description !== newSticker.description) {
    changes.description = { from: oldSticker.description || null, to: newSticker.description || null };
  }

  if (Object.keys(changes).length === 0) return;

  await sendLog(newSticker.guild, {
    event:     'stickerUpdate',
    timestamp: new Date().toISOString(),
    guild:     { id: newSticker.guild.id, name: newSticker.guild.name },
    data: {
      id:      newSticker.id,
      name:    newSticker.name,
      changes,
    },
  });
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
      await sendLog(channel.guild, {
        event:     'webhookCreate',
        timestamp: new Date().toISOString(),
        guild:     { id: channel.guild.id, name: channel.guild.name },
        data: {
          id:        wh.id,
          name:      wh.name,
          channelId: channel.id,
          createdBy: wh.owner?.tag ?? null,
        },
      });
    }
  }

  // Detect deleted webhooks
  for (const [id, wh] of cached) {
    if (!fresh.has(id)) {
      await sendLog(channel.guild, {
        event:     'webhookDelete',
        timestamp: new Date().toISOString(),
        guild:     { id: channel.guild.id, name: channel.guild.name },
        data: {
          id:        wh.id,
          name:      wh.name,
          channelId: channel.id,
        },
      });
    }
  }

  // Detect updated webhooks (name or channel changed)
  for (const [id, freshWh] of fresh) {
    const cachedWh = cached.get(id);
    if (!cachedWh) continue;

    const changes = {};
    if (cachedWh.name !== freshWh.name) {
      changes.name = { from: cachedWh.name, to: freshWh.name };
    }
    if (cachedWh.channelId !== freshWh.channelId) {
      changes.channelId = { from: cachedWh.channelId, to: freshWh.channelId };
    }

    if (Object.keys(changes).length > 0) {
      await sendLog(channel.guild, {
        event:     'webhookUpdate',
        timestamp: new Date().toISOString(),
        guild:     { id: channel.guild.id, name: channel.guild.name },
        data: {
          id:      freshWh.id,
          name:    freshWh.name,
          changes,
        },
      });
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

