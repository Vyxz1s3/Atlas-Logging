'use strict';

// =============================================================================
// automod.js — Atlas Automoderation & Anti-Raid System
//
// Integrates with the Atlas Logging bot (index.js) to provide:
//   • Automoderation  — spam, mentions, links, invites, profanity, caps,
//                       repeated chars, zalgo/unicode abuse
//   • Anti-Raid       — mass join/ban/kick/role-change/channel-create/delete,
//                       webhook spam, permission escalation, account age checks,
//                       suspicious-activity scoring
//
// Usage (in index.js):
//   const automod = require('./automod');
//   automod.init(client);
//
// Environment variables:
//   SECURITY_LOG_CHANNEL_ID  — channel for security/automod alerts
//   LOG_CHANNEL_ID           — fallback if SECURITY_LOG_CHANNEL_ID is unset
// =============================================================================

require('dotenv').config();
const { EmbedBuilder, Colors, PermissionsBitField } = require('discord.js');

// =============================================================================
// CONFIGURATION
// All thresholds, actions, and toggles live here. Edit to taste.
// =============================================================================

const config = {
  // ── Automod rules ──────────────────────────────────────────────────────────
  automod: {
    // Spam Detection — max messages per window per user per channel
    spam: {
      enabled:        true,
      maxMessages:    5,          // messages
      windowMs:       5_000,      // 5 seconds
      action:         'mute',     // 'log' | 'warn' | 'mute' | 'kick' | 'ban'
      muteDurationMs: 5 * 60_000, // 5 minutes
    },

    // Mention Spam — max unique mentions in a single message
    mentionSpam: {
      enabled:        true,
      maxMentions:    5,
      action:         'mute',
      muteDurationMs: 10 * 60_000,
    },

    // Link Detection — flag any URL
    links: {
      enabled:   true,
      action:    'log',
      // Domains that are always allowed (case-insensitive, partial match)
      whitelist: ['discord.com', 'discord.gg', 'tenor.com', 'giphy.com'],
    },

    // Discord Invite Detection — flag discord.gg / discord.com/invite links
    inviteLinks: {
      enabled: true,
      action:  'warn',
    },

    // Profanity / Keyword Filter
    profanity: {
      enabled: true,
      action:  'warn',
      // Add words in lower-case; matching is case-insensitive and whole-word
      words: [
        // Seed list — extend as needed
        'badword1',
        'badword2',
        'slur1',
      ],
    },

    // Caps Spam — % of uppercase chars in messages longer than minLength
    capsSpam: {
      enabled:    true,
      minLength:  10,   // chars — ignore short messages
      maxPercent: 70,   // % uppercase before flagging
      action:     'warn',
    },

    // Repeated Character Spam — e.g. "aaaaaaa", "!!!!!!"
    repeatedChars: {
      enabled:    true,
      maxRepeat:  6,    // consecutive identical chars
      action:     'warn',
    },

    // Suspicious Patterns — zalgo text, excessive unicode, RTL override, etc.
    suspiciousPatterns: {
      enabled: true,
      action:  'log',
    },
  },

  // ── Anti-Raid / Security rules ─────────────────────────────────────────────
  antiRaid: {
    // Mass Join — joins per minute
    massJoin: {
      enabled:    true,
      maxJoins:   10,
      windowMs:   60_000,
      action:     'log', // 'log' | 'lockdown' (lockdown = alert only for now)
    },

    // Mass Ban
    massBan: {
      enabled:   true,
      maxBans:   5,
      windowMs:  60_000,
      action:    'log',
    },

    // Mass Kick
    massKick: {
      enabled:   true,
      maxKicks:  5,
      windowMs:  60_000,
      action:    'log',
    },

    // Mass Role Changes — total role add/remove events across all members
    massRoleChange: {
      enabled:          true,
      maxChanges:       10,
      windowMs:         60_000,
      action:           'log',
    },

    // Mass Channel Creation
    massChannelCreate: {
      enabled:    true,
      maxCreates: 5,
      windowMs:   60_000,
      action:     'log',
    },

    // Mass Channel Deletion
    massChannelDelete: {
      enabled:    true,
      maxDeletes: 5,
      windowMs:   60_000,
      action:     'log',
    },

    // Webhook Spam
    webhookSpam: {
      enabled:     true,
      maxWebhooks: 3,
      windowMs:    60_000,
      action:      'log',
    },

    // Permission Escalation — non-admin gains Administrator or dangerous perms
    permissionEscalation: {
      enabled:           true,
      action:            'log',
      // Permissions considered "dangerous" for escalation detection
      dangerousPerms: [
        'Administrator',
        'ManageGuild',
        'ManageRoles',
        'ManageChannels',
        'BanMembers',
        'KickMembers',
        'ManageWebhooks',
        'ManageMessages',
        'MentionEveryone',
      ],
    },

    // Account Age Verification — flag accounts younger than minAgeDays
    accountAge: {
      enabled:    true,
      minAgeDays: 7,
      action:     'log',
    },

    // Suspicious Activity Scoring
    // Each rule contributes points; when total >= threshold an alert fires.
    suspiciousScore: {
      enabled:   true,
      threshold: 10,
      decayMs:   10 * 60_000, // points decay after 10 minutes of inactivity
      // Points awarded per violation type
      points: {
        spam:                 3,
        mentionSpam:          4,
        inviteLink:           2,
        profanity:            2,
        capsSpam:             1,
        repeatedChars:        1,
        suspiciousPattern:    3,
        newAccount:           2,
        permissionEscalation: 5,
      },
    },
  },

  // ── Whitelist — these entities are never actioned ──────────────────────────
  whitelist: {
    userIds:    [],   // string[] — user IDs exempt from all automod
    roleIds:    [],   // string[] — members with these roles are exempt
    channelIds: [],   // string[] — channels where automod is silent
  },
};

// =============================================================================
// IN-MEMORY STATE
// All state is per-guild, keyed by guildId.
// =============================================================================

/**
 * @typedef {Object} GuildState
 * @property {Map<string, number[]>}  messageTimestamps   userId+channelId → timestamps[]
 * @property {number[]}               joinTimestamps
 * @property {number[]}               banTimestamps
 * @property {number[]}               kickTimestamps
 * @property {number[]}               roleChangeTimestamps
 * @property {number[]}               channelCreateTimestamps
 * @property {number[]}               channelDeleteTimestamps
 * @property {number[]}               webhookCreateTimestamps
 * @property {Map<string, {score: number, lastUpdate: number}>} suspiciousScores  userId → score
 */

/** @type {Map<string, GuildState>} */
const guildState = new Map();

/**
 * Get (or lazily create) the mutable state object for a guild.
 * @param {string} guildId
 * @returns {GuildState}
 */
function getState(guildId) {
  if (!guildState.has(guildId)) {
    guildState.set(guildId, {
      messageTimestamps:        new Map(),
      joinTimestamps:           [],
      banTimestamps:            [],
      kickTimestamps:           [],
      roleChangeTimestamps:     [],
      channelCreateTimestamps:  [],
      channelDeleteTimestamps:  [],
      webhookCreateTimestamps:  [],
      suspiciousScores:         new Map(),
    });
  }
  return guildState.get(guildId);
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Prune timestamps older than windowMs from an array (mutates in place).
 * @param {number[]} arr
 * @param {number}   windowMs
 * @param {number}   [now=Date.now()]
 */
function pruneWindow(arr, windowMs, now = Date.now()) {
  const cutoff = now - windowMs;
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  arr.splice(0, i);
}

/**
 * Truncate a string to max characters, appending "…" if cut.
 * @param {string} str
 * @param {number} [max=1024]
 */
function truncate(str, max = 1024) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/**
 * Check whether a guild member is whitelisted (exempt from automod).
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */
function isWhitelisted(member) {
  if (config.whitelist.userIds.includes(member.id)) return true;
  if (member.roles.cache.some((r) => config.whitelist.roleIds.includes(r.id))) return true;
  return false;
}

/**
 * Check whether a channel is whitelisted.
 * @param {string} channelId
 * @returns {boolean}
 */
function isChannelWhitelisted(channelId) {
  return config.whitelist.channelIds.includes(channelId);
}

// =============================================================================
// SECURITY LOG SENDER
// Sends embeds to SECURITY_LOG_CHANNEL_ID (falls back to LOG_CHANNEL_ID).
// =============================================================================

/** @type {import('discord.js').Client|null} */
let _client = null;

/**
 * Send a security/automod alert embed to the configured security log channel.
 *
 * @param {import('discord.js').Guild|null} guild
 * @param {import('discord.js').EmbedBuilder} embed
 */
async function sendSecurityLog(guild, embed) {
  const channelId =
    process.env.SECURITY_LOG_CHANNEL_ID ?? process.env.LOG_CHANNEL_ID;

  if (!channelId) {
    console.log('[SECURITY LOG]', JSON.stringify(embed.toJSON(), null, 2));
    return;
  }

  try {
    const channel = guild
      ? guild.channels.cache.get(channelId) ??
        (await guild.channels.fetch(channelId).catch(() => null))
      : _client?.channels.cache.get(channelId) ??
        (await _client?.channels.fetch(channelId).catch(() => null));

    if (!channel?.isTextBased()) {
      console.warn(
        `[AUTOMOD WARN] Security log channel ${channelId} not found or not a text channel.`,
      );
      return;
    }

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[AUTOMOD ERROR] Failed to send security log embed:', err);
  }
}

/**
 * Build a consistently styled security embed.
 *
 * @param {object} opts
 * @param {string}  opts.title
 * @param {number}  opts.color
 * @param {string} [opts.description]
 * @returns {import('discord.js').EmbedBuilder}
 */
function buildSecurityEmbed({ title, color, description }) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setTimestamp()
    .setFooter({ text: 'Atlas Automod' });

  if (description) embed.setDescription(description);
  return embed;
}

// =============================================================================
// SUSPICIOUS ACTIVITY SCORING
// =============================================================================

/**
 * Add points to a user's suspicious-activity score.
 * Fires an alert embed if the threshold is crossed.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').User}  user
 * @param {string}                     reason   — key into config.antiRaid.suspiciousScore.points
 * @param {string}                     detail   — human-readable context
 */
async function addSuspiciousScore(guild, user, reason, detail) {
  if (!config.antiRaid.suspiciousScore.enabled) return;

  const state = getState(guild.id);
  const now   = Date.now();
  const cfg   = config.antiRaid.suspiciousScore;

  const entry = state.suspiciousScores.get(user.id) ?? { score: 0, lastUpdate: now };

  // Decay: if the user has been quiet for decayMs, reset their score
  if (now - entry.lastUpdate > cfg.decayMs) {
    entry.score = 0;
  }

  const points = cfg.points[reason] ?? 1;
  entry.score     += points;
  entry.lastUpdate = now;
  state.suspiciousScores.set(user.id, entry);

  if (entry.score >= cfg.threshold) {
    // Reset score after alert to avoid spam-alerting
    entry.score = 0;
    state.suspiciousScores.set(user.id, entry);

    const embed = buildSecurityEmbed({
      title: '🚨 Suspicious Activity Threshold Reached',
      color: Colors.DarkRed,
      description:
        `**User:** ${user.tag} (<@${user.id}>)\n` +
        `**Trigger:** ${detail}\n` +
        `**Accumulated score reached:** ${cfg.threshold} points\n` +
        `**Guild:** ${guild.name} (${guild.id})`,
    });

    await sendSecurityLog(guild, embed);
  }
}

// =============================================================================
// ACTION EXECUTOR
// Applies the configured action (log / warn / mute / kick / ban) for a rule.
// =============================================================================

/**
 * Execute the configured action for an automod violation.
 *
 * @param {object}  opts
 * @param {import('discord.js').Guild}       opts.guild
 * @param {import('discord.js').GuildMember} opts.member
 * @param {string}  opts.action        — 'log' | 'warn' | 'mute' | 'kick' | 'ban'
 * @param {string}  opts.ruleName      — human-readable rule label
 * @param {string}  opts.detail        — violation detail for the log embed
 * @param {number}  [opts.muteDurationMs] — required when action === 'mute'
 * @param {string}  [opts.scoreReason]   — key for suspicious-score system
 */
async function executeAction({
  guild,
  member,
  action,
  ruleName,
  detail,
  muteDurationMs,
  scoreReason,
}) {
  // Always log the violation
  const colorMap = {
    log:  Colors.Yellow,
    warn: Colors.Orange,
    mute: Colors.Red,
    kick: Colors.DarkRed,
    ban:  0x000000,
  };

  const actionLabel = {
    log:  '📋 Logged',
    warn: '⚠️ Warned',
    mute: '🔇 Muted',
    kick: '👢 Kicked',
    ban:  '🔨 Banned',
  };

  const embed = buildSecurityEmbed({
    title: `🛡️ Automod — ${ruleName}`,
    color: colorMap[action] ?? Colors.Yellow,
    description:
      `**User:** ${member.user.tag} (<@${member.id}>)\n` +
      `**Action:** ${actionLabel[action] ?? action}\n` +
      `**Detail:** ${truncate(detail, 900)}\n` +
      `**Guild:** ${guild.name} (${guild.id})`,
  });

  await sendSecurityLog(guild, embed);

  // Accumulate suspicious score
  if (scoreReason) {
    await addSuspiciousScore(guild, member.user, scoreReason, detail);
  }

  // Perform the action
  try {
    switch (action) {
      case 'warn':
        // DM the user with a warning
        await member.user
          .send(
            `⚠️ **Warning from ${guild.name}:** Your message was flagged by automod.\n` +
            `**Reason:** ${ruleName}\n` +
            `Please review the server rules.`,
          )
          .catch(() => null); // DMs may be closed
        break;

      case 'mute':
        if (member.moderatable) {
          await member.timeout(
            muteDurationMs ?? 5 * 60_000,
            `Automod: ${ruleName}`,
          );
          await member.user
            .send(
              `🔇 **You have been timed out in ${guild.name}.**\n` +
              `**Reason:** ${ruleName}\n` +
              `Duration: ${Math.round((muteDurationMs ?? 300_000) / 60_000)} minute(s).`,
            )
            .catch(() => null);
        }
        break;

      case 'kick':
        if (member.kickable) {
          await member.user
            .send(
              `👢 **You have been kicked from ${guild.name}.**\n` +
              `**Reason:** ${ruleName}`,
            )
            .catch(() => null);
          await member.kick(`Automod: ${ruleName}`);
        }
        break;

      case 'ban':
        if (member.bannable) {
          await member.user
            .send(
              `🔨 **You have been banned from ${guild.name}.**\n` +
              `**Reason:** ${ruleName}`,
            )
            .catch(() => null);
          await member.ban({ reason: `Automod: ${ruleName}`, deleteMessageSeconds: 86_400 });
        }
        break;

      case 'log':
      default:
        // Already logged above
        break;
    }
  } catch (err) {
    console.error(`[AUTOMOD ERROR] Failed to execute action "${action}" for ${member.user.tag}:`, err);
  }
}

// =============================================================================
// AUTOMOD RULES — MESSAGE-BASED
// =============================================================================

// ── Regex patterns ────────────────────────────────────────────────────────────

/** Matches any URL (http/https/ftp or bare domain). */
const URL_REGEX = /https?:\/\/[^\s<>]+|ftp:\/\/[^\s<>]+|(?<![/\w])(?:[\w-]+\.)+(?:com|net|org|io|gg|tv|co|uk|de|fr|ru|xyz|app|dev|me|info|biz|us|ca|au|jp|br|in|nl|se|no|fi|dk|pl|es|it|pt|be|ch|at|nz|sg|hk|tw|kr|mx|ar|cl|za|ae|sa|tr|id|ph|vn|th|my|pk|bd|ng|ke|gh|tz|ug|rw|et|eg|ma|dz|tn|ly|sd|so|cm|ci|sn|ml|bf|ne|td|mr|gm|gn|sl|lr|tg|bj|cg|cd|ao|mz|zm|zw|bw|na|sz|ls|mg|mu|sc|km|dj|er|ss|cf|ga|gq|st|cv|gw|bi|rw|mw|ug|tz|ke|et|so|dj|er|ss|sd|ly|tn|dz|ma|eg|ng|gh|cm|ci|sn|ml|bf|ne|td|mr|gm|gn|sl|lr|tg|bj|cg|cd|ao|mz|zm|zw|bw|na|sz|ls|mg|mu|sc|km)[/\w\-.~:/?#[\]@!$&'()*+,;=%]*)(?=[^/\w]|$)/gi;

/** Matches Discord invite links. */
const INVITE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:discord\.(?:gg|io|me|li)|discordapp\.com\/invite|discord\.com\/invite)\/[\w-]+/gi;

/** Matches zalgo text (combining diacritics stacked on characters). */
const ZALGO_REGEX = /[\u0300-\u036f\u0489\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]{3,}/g;

/** Matches RTL override / other dangerous unicode control characters. */
const DANGEROUS_UNICODE_REGEX = /[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/g;

/** Matches excessive emoji sequences (5+ consecutive emoji). */
const EMOJI_SPAM_REGEX = /(?:[\u{1F300}-\u{1FAFF}][\u{1F300}-\u{1FAFF}][\u{1F300}-\u{1FAFF}][\u{1F300}-\u{1FAFF}][\u{1F300}-\u{1FAFF}]+)/gu;

// ── Rule: Spam Detection ──────────────────────────────────────────────────────

/**
 * Track message rate for a user in a channel.
 * Returns true if the rate exceeds the configured threshold.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {string} channelId
 * @returns {boolean}
 */
function checkSpam(guildId, userId, channelId) {
  const cfg   = config.automod.spam;
  const state = getState(guildId);
  const key   = `${userId}:${channelId}`;
  const now   = Date.now();

  const timestamps = state.messageTimestamps.get(key) ?? [];
  pruneWindow(timestamps, cfg.windowMs, now);
  timestamps.push(now);
  state.messageTimestamps.set(key, timestamps);

  return timestamps.length > cfg.maxMessages;
}

// ── Rule: Mention Spam ────────────────────────────────────────────────────────

/**
 * Returns true if the message contains more unique mentions than the threshold.
 * @param {import('discord.js').Message} message
 * @returns {boolean}
 */
function checkMentionSpam(message) {
  const cfg          = config.automod.mentionSpam;
  const uniqueUsers  = new Set(message.mentions.users.keys());
  const uniqueRoles  = new Set(message.mentions.roles.keys());
  const total        = uniqueUsers.size + uniqueRoles.size + (message.mentions.everyone ? 1 : 0);
  return total > cfg.maxMentions;
}

// ── Rule: Link Detection ──────────────────────────────────────────────────────

/**
 * Returns the first non-whitelisted URL found in the message, or null.
 * @param {string} content
 * @returns {string|null}
 */
function checkLinks(content) {
  const cfg     = config.automod.links;
  const matches = content.match(URL_REGEX) ?? [];

  for (const url of matches) {
    const lower = url.toLowerCase();
    const allowed = cfg.whitelist.some((domain) => lower.includes(domain.toLowerCase()));
    if (!allowed) return url;
  }
  return null;
}

// ── Rule: Invite Link Detection ───────────────────────────────────────────────

/**
 * Returns the first Discord invite link found, or null.
 * @param {string} content
 * @returns {string|null}
 */
function checkInviteLink(content) {
  INVITE_REGEX.lastIndex = 0;
  const match = INVITE_REGEX.exec(content);
  return match ? match[0] : null;
}

// ── Rule: Profanity / Keyword Filter ─────────────────────────────────────────

/**
 * Returns the first matched banned word, or null.
 * @param {string} content
 * @returns {string|null}
 */
function checkProfanity(content) {
  const cfg   = config.automod.profanity;
  const lower = content.toLowerCase();

  for (const word of cfg.words) {
    // Whole-word match (word boundaries)
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) return word;
  }
  return null;
}

// ── Rule: Caps Spam ───────────────────────────────────────────────────────────

/**
 * Returns true if the message has excessive uppercase characters.
 * @param {string} content
 * @returns {boolean}
 */
function checkCapsSpam(content) {
  const cfg = config.automod.capsSpam;
  // Strip non-alpha characters for the ratio calculation
  const letters = content.replace(/[^a-zA-Z]/g, '');
  if (letters.length < cfg.minLength) return false;

  const upper = letters.replace(/[^A-Z]/g, '').length;
  return (upper / letters.length) * 100 > cfg.maxPercent;
}

// ── Rule: Repeated Character Spam ────────────────────────────────────────────

/**
 * Returns true if the message contains a run of repeated characters.
 * @param {string} content
 * @returns {boolean}
 */
function checkRepeatedChars(content) {
  const cfg = config.automod.repeatedChars;
  const re  = new RegExp(`(.)\\1{${cfg.maxRepeat - 1},}`, 'u');
  return re.test(content);
}

// ── Rule: Suspicious Patterns ─────────────────────────────────────────────────

/**
 * Returns a description of the first suspicious pattern found, or null.
 * @param {string} content
 * @returns {string|null}
 */
function checkSuspiciousPatterns(content) {
  if (ZALGO_REGEX.test(content)) {
    ZALGO_REGEX.lastIndex = 0;
    return 'Zalgo / stacked diacritics detected';
  }
  ZALGO_REGEX.lastIndex = 0;

  if (DANGEROUS_UNICODE_REGEX.test(content)) {
    DANGEROUS_UNICODE_REGEX.lastIndex = 0;
    return 'Dangerous Unicode control characters detected (RTL override / zero-width)';
  }
  DANGEROUS_UNICODE_REGEX.lastIndex = 0;

  if (EMOJI_SPAM_REGEX.test(content)) {
    EMOJI_SPAM_REGEX.lastIndex = 0;
    return 'Excessive emoji spam detected';
  }
  EMOJI_SPAM_REGEX.lastIndex = 0;

  return null;
}

// =============================================================================
// MESSAGE EVENT HANDLER
// Called for every non-bot message in a guild.
// =============================================================================

/**
 * Run all message-based automod checks against a single message.
 * @param {import('discord.js').Message} message
 */
async function handleMessage(message) {
  // Only process guild messages from real users
  if (!message.guild)        return;
  if (message.author.bot)    return;
  if (message.partial)       return;

  // Channel whitelist
  if (isChannelWhitelisted(message.channelId)) return;

  // Fetch the GuildMember for action execution
  let member;
  try {
    member = message.member ?? (await message.guild.members.fetch(message.author.id));
  } catch {
    return; // Can't fetch member — skip
  }

  // User / role whitelist
  if (isWhitelisted(member)) return;

  const content  = message.content ?? '';
  const guildId  = message.guild.id;
  const cfg      = config.automod;

  // ── 1. Spam Detection ──────────────────────────────────────────────────────
  if (cfg.spam.enabled && checkSpam(guildId, message.author.id, message.channelId)) {
    await executeAction({
      guild:          message.guild,
      member,
      action:         cfg.spam.action,
      ruleName:       'Spam Detection',
      detail:         `Sent more than ${cfg.spam.maxMessages} messages in ${cfg.spam.windowMs / 1000}s in <#${message.channelId}>`,
      muteDurationMs: cfg.spam.muteDurationMs,
      scoreReason:    'spam',
    });
    // Delete the offending message if we have permission
    await message.delete().catch(() => null);
    return; // Don't stack further checks on the same message
  }

  // ── 2. Mention Spam ────────────────────────────────────────────────────────
  if (cfg.mentionSpam.enabled && checkMentionSpam(message)) {
    await executeAction({
      guild:          message.guild,
      member,
      action:         cfg.mentionSpam.action,
      ruleName:       'Mention Spam',
      detail:         `Message contained more than ${cfg.mentionSpam.maxMentions} unique mentions`,
      muteDurationMs: cfg.mentionSpam.muteDurationMs,
      scoreReason:    'mentionSpam',
    });
    await message.delete().catch(() => null);
    return;
  }

  // ── 3. Invite Link Detection (checked before generic links) ───────────────
  if (cfg.inviteLinks.enabled) {
    const invite = checkInviteLink(content);
    if (invite) {
      await executeAction({
        guild:       message.guild,
        member,
        action:      cfg.inviteLinks.action,
        ruleName:    'Discord Invite Link',
        detail:      `Posted a Discord invite link: \`${truncate(invite, 200)}\``,
        scoreReason: 'inviteLink',
      });
      await message.delete().catch(() => null);
      return;
    }
  }

  // ── 4. Link Detection ──────────────────────────────────────────────────────
  if (cfg.links.enabled) {
    const url = checkLinks(content);
    if (url) {
      await executeAction({
        guild:    message.guild,
        member,
        action:   cfg.links.action,
        ruleName: 'Link Detected',
        detail:   `Posted a non-whitelisted URL: \`${truncate(url, 200)}\``,
        // Links are 'log' by default — no score contribution unless you add one
      });
      // Note: we do NOT delete or return here by default (action is 'log').
      // If you change the action to 'warn'/'mute', add a delete + return.
    }
  }

  // ── 5. Profanity / Keyword Filter ─────────────────────────────────────────
  if (cfg.profanity.enabled) {
    const word = checkProfanity(content);
    if (word) {
      await executeAction({
        guild:       message.guild,
        member,
        action:      cfg.profanity.action,
        ruleName:    'Profanity / Keyword Filter',
        detail:      `Message contained a banned word: \`${word}\``,
        scoreReason: 'profanity',
      });
      await message.delete().catch(() => null);
      return;
    }
  }

  // ── 6. Caps Spam ───────────────────────────────────────────────────────────
  if (cfg.capsSpam.enabled && checkCapsSpam(content)) {
    await executeAction({
      guild:       message.guild,
      member,
      action:      cfg.capsSpam.action,
      ruleName:    'Caps Spam',
      detail:      `Message exceeded ${cfg.capsSpam.maxPercent}% uppercase characters`,
      scoreReason: 'capsSpam',
    });
    // Caps spam is warned but not deleted by default
  }

  // ── 7. Repeated Character Spam ────────────────────────────────────────────
  if (cfg.repeatedChars.enabled && checkRepeatedChars(content)) {
    await executeAction({
      guild:       message.guild,
      member,
      action:      cfg.repeatedChars.action,
      ruleName:    'Repeated Character Spam',
      detail:      `Message contained ${cfg.repeatedChars.maxRepeat}+ consecutive identical characters`,
      scoreReason: 'repeatedChars',
    });
  }

  // ── 8. Suspicious Patterns ────────────────────────────────────────────────
  if (cfg.suspiciousPatterns.enabled) {
    const pattern = checkSuspiciousPatterns(content);
    if (pattern) {
      await executeAction({
        guild:       message.guild,
        member,
        action:      cfg.suspiciousPatterns.action,
        ruleName:    'Suspicious Pattern',
        detail:      pattern,
        scoreReason: 'suspiciousPattern',
      });
    }
  }
}

// =============================================================================
// ANTI-RAID — MEMBER JOIN
// =============================================================================

/**
 * Handle a new member joining — checks mass-join rate and account age.
 * @param {import('discord.js').GuildMember} member
 */
async function handleMemberJoin(member) {
  const guild = member.guild;
  const state = getState(guild.id);
  const now   = Date.now();

  // ── Mass Join Detection ────────────────────────────────────────────────────
  if (config.antiRaid.massJoin.enabled) {
    const cfg = config.antiRaid.massJoin;
    pruneWindow(state.joinTimestamps, cfg.windowMs, now);
    state.joinTimestamps.push(now);

    if (state.joinTimestamps.length > cfg.maxJoins) {
      const embed = buildSecurityEmbed({
        title: '🚨 Anti-Raid — Mass Join Detected',
        color: Colors.DarkRed,
        description:
          `**${state.joinTimestamps.length} members** joined in the last ${cfg.windowMs / 1000}s.\n` +
          `**Latest join:** ${member.user.tag} (<@${member.id}>)\n` +
          `**Account created:** <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>\n` +
          `**Guild:** ${guild.name} (${guild.id})\n\n` +
          `⚠️ Consider enabling server verification or temporarily pausing invites.`,
      });
      await sendSecurityLog(guild, embed);
    }
  }

  // ── Account Age Verification ───────────────────────────────────────────────
  if (config.antiRaid.accountAge.enabled && !member.user.bot) {
    const cfg         = config.antiRaid.accountAge;
    const ageDays     = (now - member.user.createdTimestamp) / 86_400_000;

    if (ageDays < cfg.minAgeDays) {
      const embed = buildSecurityEmbed({
        title: '⚠️ Anti-Raid — New Account Joined',
        color: Colors.Orange,
        description:
          `**User:** ${member.user.tag} (<@${member.id}>)\n` +
          `**Account age:** ${ageDays.toFixed(2)} days (threshold: ${cfg.minAgeDays} days)\n` +
          `**Account created:** <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>\n` +
          `**Guild:** ${guild.name} (${guild.id})`,
      });
      await sendSecurityLog(guild, embed);
      await addSuspiciousScore(guild, member.user, 'newAccount', `Account only ${ageDays.toFixed(2)} days old`);
    }
  }
}

// =============================================================================
// ANTI-RAID — GUILD BAN ADD
// =============================================================================

/**
 * Handle a ban being added — checks for mass-ban activity.
 * @param {import('discord.js').GuildBan} ban
 */
async function handleBanAdd(ban) {
  if (!config.antiRaid.massBan.enabled) return;

  const guild = ban.guild;
  const state = getState(guild.id);
  const cfg   = config.antiRaid.massBan;
  const now   = Date.now();

  pruneWindow(state.banTimestamps, cfg.windowMs, now);
  state.banTimestamps.push(now);

  if (state.banTimestamps.length > cfg.maxBans) {
    const embed = buildSecurityEmbed({
      title: '🚨 Anti-Raid — Mass Ban Detected',
      color: Colors.DarkRed,
      description:
        `**${state.banTimestamps.length} bans** issued in the last ${cfg.windowMs / 1000}s.\n` +
        `**Latest ban:** ${ban.user.tag} (${ban.user.id})\n` +
        `**Reason:** ${ban.reason ?? 'No reason provided'}\n` +
        `**Guild:** ${guild.name} (${guild.id})\n\n` +
        `⚠️ This may indicate a compromised moderator account or a bot running amok.`,
    });
    await sendSecurityLog(guild, embed);
  }
}

// =============================================================================
// ANTI-RAID — GUILD MEMBER REMOVE (kick detection)
// =============================================================================

/**
 * Handle a member removal — attempts to detect mass-kick activity via audit log.
 * @param {import('discord.js').GuildMember} member
 */
async function handleMemberRemove(member) {
  if (!config.antiRaid.massKick.enabled) return;

  const guild = member.guild;
  const state = getState(guild.id);
  const cfg   = config.antiRaid.massKick;
  const now   = Date.now();

  // Check audit log to confirm this was a kick (not a voluntary leave)
  try {
    const auditLogs = await guild.fetchAuditLogs({ type: 20 /* MemberKick */, limit: 1 });
    const entry     = auditLogs.entries.first();

    // Only count if the audit log entry is recent (within 3 seconds)
    if (entry && now - entry.createdTimestamp < 3_000 && entry.target?.id === member.id) {
      pruneWindow(state.kickTimestamps, cfg.windowMs, now);
      state.kickTimestamps.push(now);

      if (state.kickTimestamps.length > cfg.maxKicks) {
        const embed = buildSecurityEmbed({
          title: '🚨 Anti-Raid — Mass Kick Detected',
          color: Colors.DarkRed,
          description:
            `**${state.kickTimestamps.length} kicks** in the last ${cfg.windowMs / 1000}s.\n` +
            `**Latest kick:** ${member.user.tag} (${member.user.id})\n` +
            `**Kicked by:** ${entry.executor?.tag ?? 'Unknown'}\n` +
            `**Guild:** ${guild.name} (${guild.id})\n\n` +
            `⚠️ This may indicate a compromised moderator account.`,
        });
        await sendSecurityLog(guild, embed);
      }
    }
  } catch {
    // Missing VIEW_AUDIT_LOG permission — skip kick detection silently
  }
}

// =============================================================================
// ANTI-RAID — GUILD MEMBER UPDATE (role changes + permission escalation)
// =============================================================================

/**
 * Handle a member update — checks for mass role changes and permission escalation.
 * @param {import('discord.js').GuildMember} oldMember
 * @param {import('discord.js').GuildMember} newMember
 */
async function handleMemberUpdate(oldMember, newMember) {
  const guild = newMember.guild;
  const state = getState(guild.id);
  const now   = Date.now();

  const addedRoles   = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
  const removedRoles = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id));
  const totalChanges = addedRoles.size + removedRoles.size;

  if (totalChanges === 0) return;

  // ── Mass Role Change Detection ─────────────────────────────────────────────
  if (config.antiRaid.massRoleChange.enabled) {
    const cfg = config.antiRaid.massRoleChange;
    pruneWindow(state.roleChangeTimestamps, cfg.windowMs, now);

    for (let i = 0; i < totalChanges; i++) state.roleChangeTimestamps.push(now);

    if (state.roleChangeTimestamps.length > cfg.maxChanges) {
      const embed = buildSecurityEmbed({
        title: '🚨 Anti-Raid — Mass Role Changes Detected',
        color: Colors.DarkRed,
        description:
          `**${state.roleChangeTimestamps.length} role changes** in the last ${cfg.windowMs / 1000}s.\n` +
          `**Latest change on:** ${newMember.user.tag} (<@${newMember.id}>)\n` +
          (addedRoles.size   ? `**Roles added:** ${addedRoles.map((r) => `<@&${r.id}>`).join(', ')}\n`   : '') +
          (removedRoles.size ? `**Roles removed:** ${removedRoles.map((r) => `<@&${r.id}>`).join(', ')}\n` : '') +
          `**Guild:** ${guild.name} (${guild.id})`,
      });
      await sendSecurityLog(guild, embed);
    }
  }

  // ── Permission Escalation Detection ───────────────────────────────────────
  if (config.antiRaid.permissionEscalation.enabled && addedRoles.size > 0) {
    const cfg = config.antiRaid.permissionEscalation;

    // Was the member already an admin before this update?
    const wasAdmin = oldMember.permissions.has(PermissionsBitField.Flags.Administrator);
    if (wasAdmin) return; // Already had admin — no escalation

    // Check if any newly added role grants a dangerous permission
    const escalatedPerms = [];
    for (const role of addedRoles.values()) {
      for (const perm of cfg.dangerousPerms) {
        if (
          PermissionsBitField.Flags[perm] !== undefined &&
          role.permissions.has(PermissionsBitField.Flags[perm])
        ) {
          escalatedPerms.push(perm);
        }
      }
    }

    if (escalatedPerms.length > 0) {
      const embed = buildSecurityEmbed({
        title: '🚨 Security — Permission Escalation Detected',
        color: Colors.DarkRed,
        description:
          `**User:** ${newMember.user.tag} (<@${newMember.id}>)\n` +
          `**Dangerous permissions gained:** ${[...new Set(escalatedPerms)].join(', ')}\n` +
          `**Via roles:** ${addedRoles.map((r) => `<@&${r.id}> (${r.name})`).join(', ')}\n` +
          `**Guild:** ${guild.name} (${guild.id})\n\n` +
          `⚠️ Verify this role assignment was intentional.`,
      });
      await sendSecurityLog(guild, embed);
      await addSuspiciousScore(
        guild,
        newMember.user,
        'permissionEscalation',
        `Gained dangerous permissions: ${[...new Set(escalatedPerms)].join(', ')}`,
      );
    }
  }
}

// =============================================================================
// ANTI-RAID — CHANNEL CREATE / DELETE
// =============================================================================

/**
 * Handle a channel creation — checks for mass channel creation.
 * @param {import('discord.js').GuildChannel} channel
 */
async function handleChannelCreate(channel) {
  if (!channel.guild) return;
  if (!config.antiRaid.massChannelCreate.enabled) return;

  const guild = channel.guild;
  const state = getState(guild.id);
  const cfg   = config.antiRaid.massChannelCreate;
  const now   = Date.now();

  pruneWindow(state.channelCreateTimestamps, cfg.windowMs, now);
  state.channelCreateTimestamps.push(now);

  if (state.channelCreateTimestamps.length > cfg.maxCreates) {
    const embed = buildSecurityEmbed({
      title: '🚨 Anti-Raid — Mass Channel Creation Detected',
      color: Colors.DarkRed,
      description:
        `**${state.channelCreateTimestamps.length} channels** created in the last ${cfg.windowMs / 1000}s.\n` +
        `**Latest channel:** ${channel.name} (${channel.id})\n` +
        `**Guild:** ${guild.name} (${guild.id})\n\n` +
        `⚠️ This may indicate a compromised account or a malicious bot.`,
    });
    await sendSecurityLog(guild, embed);
  }
}

/**
 * Handle a channel deletion — checks for mass channel deletion.
 * @param {import('discord.js').GuildChannel} channel
 */
async function handleChannelDelete(channel) {
  if (!channel.guild) return;
  if (!config.antiRaid.massChannelDelete.enabled) return;

  const guild = channel.guild;
  const state = getState(guild.id);
  const cfg   = config.antiRaid.massChannelDelete;
  const now   = Date.now();

  pruneWindow(state.channelDeleteTimestamps, cfg.windowMs, now);
  state.channelDeleteTimestamps.push(now);

  if (state.channelDeleteTimestamps.length > cfg.maxDeletes) {
    const embed = buildSecurityEmbed({
      title: '🚨 Anti-Raid — Mass Channel Deletion Detected',
      color: Colors.DarkRed,
      description:
        `**${state.channelDeleteTimestamps.length} channels** deleted in the last ${cfg.windowMs / 1000}s.\n` +
        `**Latest deletion:** ${channel.name} (${channel.id})\n` +
        `**Guild:** ${guild.name} (${guild.id})\n\n` +
        `⚠️ This may indicate a compromised account or a malicious bot.`,
    });
    await sendSecurityLog(guild, embed);
  }
}

// =============================================================================
// ANTI-RAID — WEBHOOK SPAM
// =============================================================================

/**
 * Handle a webhooks update — checks for webhook spam (rapid creation).
 * @param {import('discord.js').TextChannel} channel
 * @param {Map<string, import('discord.js').Webhook>} cachedWebhooks  — previous state
 * @param {import('discord.js').Collection}           freshWebhooks   — current state
 */
async function handleWebhookUpdate(channel, cachedWebhooks, freshWebhooks) {
  if (!channel.guild) return;
  if (!config.antiRaid.webhookSpam.enabled) return;

  const guild = channel.guild;
  const state = getState(guild.id);
  const cfg   = config.antiRaid.webhookSpam;
  const now   = Date.now();

  // Count newly created webhooks in this update
  let newCount = 0;
  for (const [id] of freshWebhooks) {
    if (!cachedWebhooks.has(id)) newCount++;
  }

  if (newCount === 0) return;

  pruneWindow(state.webhookCreateTimestamps, cfg.windowMs, now);
  for (let i = 0; i < newCount; i++) state.webhookCreateTimestamps.push(now);

  if (state.webhookCreateTimestamps.length > cfg.maxWebhooks) {
    const embed = buildSecurityEmbed({
      title: '🚨 Anti-Raid — Webhook Spam Detected',
      color: Colors.DarkRed,
      description:
        `**${state.webhookCreateTimestamps.length} webhooks** created in the last ${cfg.windowMs / 1000}s.\n` +
        `**Channel:** <#${channel.id}>\n` +
        `**Guild:** ${guild.name} (${guild.id})\n\n` +
        `⚠️ Webhooks can be used to bypass automod. Review and remove suspicious webhooks.`,
    });
    await sendSecurityLog(guild, embed);
  }
}

// =============================================================================
// AUDIT TRAIL
// Writes a structured JSON audit record to the console (and optionally to the
// security log channel). Useful for forensic review.
// =============================================================================

/**
 * Write a structured audit trail entry.
 *
 * @param {object} entry
 * @param {string} entry.event      — event type identifier
 * @param {string} entry.guildId
 * @param {string} [entry.userId]
 * @param {string} [entry.detail]
 * @param {object} [entry.meta]     — arbitrary extra data
 */
function auditTrail(entry) {
  console.log(
    '[AUDIT]',
    JSON.stringify({ ts: new Date().toISOString(), ...entry }),
  );
}

// =============================================================================
// INIT — Wire up all event listeners
// =============================================================================

/**
 * Initialise the automod system by attaching event listeners to the Discord
 * client. Call this once from index.js after the client is created.
 *
 * @param {import('discord.js').Client} client
 */
function init(client) {
  _client = client;

  // ── Message events ──────────────────────────────────────────────────────────
  client.on('messageCreate', async (message) => {
    try {
      await handleMessage(message);
    } catch (err) {
      console.error('[AUTOMOD ERROR] messageCreate handler threw:', err);
    }
  });

  // Also scan edited messages
  client.on('messageUpdate', async (_old, newMessage) => {
    if (newMessage.partial) return;
    try {
      await handleMessage(newMessage);
    } catch (err) {
      console.error('[AUTOMOD ERROR] messageUpdate handler threw:', err);
    }
  });

  // ── Member events ───────────────────────────────────────────────────────────
  client.on('guildMemberAdd', async (member) => {
    try {
      await handleMemberJoin(member);
      auditTrail({
        event:   'MEMBER_JOIN',
        guildId: member.guild.id,
        userId:  member.id,
        detail:  `${member.user.tag} joined`,
      });
    } catch (err) {
      console.error('[AUTOMOD ERROR] guildMemberAdd handler threw:', err);
    }
  });

  client.on('guildMemberRemove', async (member) => {
    try {
      await handleMemberRemove(member);
    } catch (err) {
      console.error('[AUTOMOD ERROR] guildMemberRemove handler threw:', err);
    }
  });

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
      await handleMemberUpdate(oldMember, newMember);
    } catch (err) {
      console.error('[AUTOMOD ERROR] guildMemberUpdate handler threw:', err);
    }
  });

  // ── Ban events ──────────────────────────────────────────────────────────────
  client.on('guildBanAdd', async (ban) => {
    try {
      await handleBanAdd(ban);
      auditTrail({
        event:   'BAN_ADD',
        guildId: ban.guild.id,
        userId:  ban.user.id,
        detail:  `${ban.user.tag} was banned. Reason: ${ban.reason ?? 'none'}`,
      });
    } catch (err) {
      console.error('[AUTOMOD ERROR] guildBanAdd handler threw:', err);
    }
  });

  // ── Channel events ──────────────────────────────────────────────────────────
  // NOTE: These listeners are additive — index.js also listens to channelCreate
  // and channelDelete for logging. Both handlers will fire independently.
  client.on('channelCreate', async (channel) => {
    try {
      await handleChannelCreate(channel);
    } catch (err) {
      console.error('[AUTOMOD ERROR] channelCreate handler threw:', err);
    }
  });

  client.on('channelDelete', async (channel) => {
    try {
      await handleChannelDelete(channel);
    } catch (err) {
      console.error('[AUTOMOD ERROR] channelDelete handler threw:', err);
    }
  });

  console.log('🛡️  Atlas Automod initialised.');
  console.log(
    `🔒  Security logs → channel: ${
      process.env.SECURITY_LOG_CHANNEL_ID
        ? process.env.SECURITY_LOG_CHANNEL_ID
        : process.env.LOG_CHANNEL_ID
          ? `${process.env.LOG_CHANNEL_ID} (fallback — set SECURITY_LOG_CHANNEL_ID for a dedicated channel)`
          : 'console (no channel ID set)'
    }`,
  );
}

// =============================================================================
// EXPORTS
// All public functions are exported so index.js (or tests) can call them
// individually without going through the event system.
// =============================================================================

module.exports = {
  // Lifecycle
  init,

  // Config (mutable — callers can override thresholds at runtime)
  config,

  // Automod rule checkers (useful for unit testing)
  checkSpam,
  checkMentionSpam,
  checkLinks,
  checkInviteLink,
  checkProfanity,
  checkCapsSpam,
  checkRepeatedChars,
  checkSuspiciousPatterns,

  // Anti-raid handlers (can be called directly from index.js if preferred)
  handleMessage,
  handleMemberJoin,
  handleMemberRemove,
  handleMemberUpdate,
  handleBanAdd,
  handleChannelCreate,
  handleChannelDelete,
  handleWebhookUpdate,

  // Utilities
  sendSecurityLog,
  buildSecurityEmbed,
  addSuspiciousScore,
  executeAction,
  auditTrail,
};
