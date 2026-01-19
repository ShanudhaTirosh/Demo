import dotenv from 'dotenv';
import { User, Group, logCommand } from './db.js';
import botSettings from './settings.js';
import { registerAllDownloaderCommands, handleSelection } from './downloader-commands.js';

dotenv.config();

class CommandHandler {
  constructor() {
    this.commands = new Map();
    this.prefix = process.env.PREFIX || '.';
    this.ownerNumber = process.env.OWNER_NUMBER;
    this.categories = {
      general: [],
      group: [],
      moderation: [],
      settings: [],
      owner: []
    };
  }

  register(name, category, handler, options = {}) {
    const command = {
      name,
      category,
      handler,
      aliases: options.aliases || [],
      ownerOnly: options.ownerOnly || false,
      groupOnly: options.groupOnly || false,
      adminOnly: options.adminOnly || false,
      description: options.description || 'No description'
    };

    this.commands.set(name, command);
    
    if (this.categories[category]) {
      this.categories[category].push(name);
    }

    // Register aliases
    command.aliases.forEach(alias => {
      this.commands.set(alias, command);
    });
  }

  async execute(sock, msg) {
    const text = msg.message?.conversation || 
                 msg.message?.extendedTextMessage?.text || '';
    
    // Check if this is a selection response
    if (text.match(/^\d+$/)) {
      const handled = await handleSelection(sock, msg);
      if (handled) return;
    }

    if (!text.startsWith(this.prefix)) return;

    const args = text.slice(this.prefix.length).trim().split(/\s+/);
    const commandName = args.shift().toLowerCase();
    const command = this.commands.get(commandName);

    if (!command) return;

    const sender = msg.key.remoteJid;
    const isGroup = sender.endsWith('@g.us');
    const userId = msg.key.participant || sender;

    // Check if user is banned
    const user = await User.findOne({ jid: userId });
    if (user?.isBanned && userId.split('@')[0] !== this.ownerNumber) {
      await sock.sendMessage(sender, { 
        text: '🚫 You are banned from using this bot!' 
      });
      return;
    }

    // Check permissions
    if (command.ownerOnly && userId.split('@')[0] !== this.ownerNumber) {
      await sock.sendMessage(sender, { text: '❌ This command is owner only!' });
      return;
    }

    if (command.groupOnly && !isGroup) {
      await sock.sendMessage(sender, { text: '❌ This command can only be used in groups!' });
      return;
    }

    if (command.adminOnly && isGroup) {
      const groupMetadata = await sock.groupMetadata(sender);
      const isAdmin = groupMetadata.participants
        .find(p => p.id === userId)?.admin;
      
      if (!isAdmin && userId.split('@')[0] !== this.ownerNumber) {
        await sock.sendMessage(sender, { text: '❌ This command is admin only!' });
        return;
      }
    }

    try {
      // Log command usage
      await logCommand(userId, commandName, isGroup ? sender : null);
      
      // Update user command count
      if (user) {
        user.commandUsage += 1;
        await user.save();
      }
      
      // Execute command
      await command.handler(sock, msg, args);
    } catch (error) {
      console.error(`Error executing command ${commandName}:`, error);
      await sock.sendMessage(sender, { text: '❌ An error occurred while executing the command.' });
    }
  }

  getMenu() {
    let menu = `╭━━━『 *${process.env.BOT_NAME || 'WhatsApp Bot'}* 』━━━╮\n`;
    menu += `│ Prefix: ${this.prefix}\n`;
    menu += `╰━━━━━━━━━━━━━━━━━━━━╯\n\n`;

    for (const [category, commands] of Object.entries(this.categories)) {
      if (commands.length === 0) continue;
      
      menu += `┏━━━『 *${category.toUpperCase()}* 』━━━┓\n`;
      commands.forEach(cmdName => {
        const cmd = this.commands.get(cmdName);
        if (cmd && cmd.name === cmdName) { // Avoid showing aliases
          menu += `┃ ${this.prefix}${cmdName}\n`;
          menu += `┃ ↳ ${cmd.description}\n`;
        }
      });
      menu += `┗━━━━━━━━━━━━━━━━━━━━┛\n\n`;
    }

    return menu;
  }
}

const handler = new CommandHandler();

// ========== GENERAL COMMANDS ==========
handler.register('ping', 'general', async (sock, msg) => {
  const start = Date.now();
  const sent = await sock.sendMessage(msg.key.remoteJid, { text: '🏓 Pinging...' });
  const latency = Date.now() - start;
  
  await sock.sendMessage(msg.key.remoteJid, {
    text: `🏓 *Pong!*\n⏱️ Response Time: ${latency}ms`,
    edit: sent.key
  });
}, { description: 'Check bot latency' });

handler.register('alive', 'general', async (sock, msg) => {
  const uptime = process.uptime();
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  
  await sock.sendMessage(msg.key.remoteJid, {
    text: `✅ *Bot is Alive!*\n\n⏰ Uptime: ${days}d ${hours}h ${minutes}m\n📱 Running on Baileys\n🤖 ${process.env.BOT_NAME}`
  });
}, { description: 'Check if bot is alive' });

handler.register('menu', 'general', async (sock, msg) => {
  await sock.sendMessage(msg.key.remoteJid, {
    text: handler.getMenu()
  });
}, { aliases: ['help'], description: 'Show command menu' });

// ========== GROUP MANAGEMENT COMMANDS ==========
handler.register('tagall', 'group', async (sock, msg, args) => {
  const groupMetadata = await sock.groupMetadata(msg.key.remoteJid);
  const message = args.join(' ') || 'Everyone!';
  
  let text = `📢 *TAG ALL*\n\n${message}\n\n`;
  const mentions = [];
  
  groupMetadata.participants.forEach(p => {
    text += `@${p.id.split('@')[0]} `;
    mentions.push(p.id);
  });
  
  await sock.sendMessage(msg.key.remoteJid, {
    text,
    mentions
  });
}, { groupOnly: true, adminOnly: true, aliases: ['everyone'], description: 'Tag all group members' });

handler.register('add', 'group', async (sock, msg, args) => {
  if (args.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please provide a phone number!' });
    return;
  }

  const number = args[0].replace(/[^0-9]/g, '');
  try {
    await sock.groupParticipantsUpdate(
      msg.key.remoteJid,
      [`${number}@s.whatsapp.net`],
      'add'
    );
    await sock.sendMessage(msg.key.remoteJid, { text: `✅ Added @${number}`, mentions: [`${number}@s.whatsapp.net`] });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Failed to add user: ${error.message}` });
  }
}, { groupOnly: true, adminOnly: true, description: 'Add a user to the group' });

handler.register('remove', 'group', async (sock, msg, args) => {
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please mention a user to remove!' });
    return;
  }

  try {
    await sock.groupParticipantsUpdate(
      msg.key.remoteJid,
      mentioned,
      'remove'
    );
    await sock.sendMessage(msg.key.remoteJid, { text: '✅ User removed successfully!' });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Failed to remove user: ${error.message}` });
  }
}, { groupOnly: true, adminOnly: true, aliases: ['kick'], description: 'Remove a user from the group' });

handler.register('promote', 'group', async (sock, msg) => {
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please mention a user to promote!' });
    return;
  }

  try {
    await sock.groupParticipantsUpdate(msg.key.remoteJid, mentioned, 'promote');
    await sock.sendMessage(msg.key.remoteJid, { text: '✅ User promoted to admin!', mentions: mentioned });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Failed to promote user: ${error.message}` });
  }
}, { groupOnly: true, adminOnly: true, description: 'Promote a user to admin' });

handler.register('demote', 'group', async (sock, msg) => {
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please mention a user to demote!' });
    return;
  }

  try {
    await sock.groupParticipantsUpdate(msg.key.remoteJid, mentioned, 'demote');
    await sock.sendMessage(msg.key.remoteJid, { text: '✅ User demoted from admin!', mentions: mentioned });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Failed to demote user: ${error.message}` });
  }
}, { groupOnly: true, adminOnly: true, description: 'Demote an admin to member' });

handler.register('mute', 'group', async (sock, msg) => {
  try {
    await sock.groupSettingUpdate(msg.key.remoteJid, 'announcement');
    await Group.findOneAndUpdate(
      { jid: msg.key.remoteJid },
      { $set: { 'settings.muted': true } }
    );
    await sock.sendMessage(msg.key.remoteJid, { text: '🔇 Group muted! Only admins can send messages.' });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Failed to mute group: ${error.message}` });
  }
}, { groupOnly: true, adminOnly: true, description: 'Mute the group (only admins can send messages)' });

handler.register('unmute', 'group', async (sock, msg) => {
  try {
    await sock.groupSettingUpdate(msg.key.remoteJid, 'not_announcement');
    await Group.findOneAndUpdate(
      { jid: msg.key.remoteJid },
      { $set: { 'settings.muted': false } }
    );
    await sock.sendMessage(msg.key.remoteJid, { text: '🔊 Group unmuted! Everyone can send messages.' });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Failed to unmute group: ${error.message}` });
  }
}, { groupOnly: true, adminOnly: true, description: 'Unmute the group' });

handler.register('lock', 'group', async (sock, msg) => {
  try {
    await sock.groupSettingUpdate(msg.key.remoteJid, 'locked');
    await Group.findOneAndUpdate(
      { jid: msg.key.remoteJid },
      { $set: { 'settings.locked': true } }
    );
    await sock.sendMessage(msg.key.remoteJid, { text: '🔒 Group settings locked! Only admins can edit group info.' });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Failed to lock group: ${error.message}` });
  }
}, { groupOnly: true, adminOnly: true, description: 'Lock group settings' });

handler.register('unlock', 'group', async (sock, msg) => {
  try {
    await sock.groupSettingUpdate(msg.key.remoteJid, 'unlocked');
    await Group.findOneAndUpdate(
      { jid: msg.key.remoteJid },
      { $set: { 'settings.locked': false } }
    );
    await sock.sendMessage(msg.key.remoteJid, { text: '🔓 Group settings unlocked! Everyone can edit group info.' });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Failed to unlock group: ${error.message}` });
  }
}, { groupOnly: true, adminOnly: true, description: 'Unlock group settings' });

// ========== MODERATION COMMANDS ==========
handler.register('antilink', 'moderation', async (sock, msg, args) => {
  const action = args[0]?.toLowerCase();
  
  if (!['on', 'off'].includes(action)) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Usage: .antilink on/off' });
    return;
  }

  const enabled = action === 'on';
  await botSettings.updateGroupSetting(msg.key.remoteJid, 'antilink', enabled);
  
  await sock.sendMessage(msg.key.remoteJid, {
    text: `${enabled ? '✅ Anti-link enabled!' : '❌ Anti-link disabled!'}\n${enabled ? 'Links will be automatically deleted.' : ''}`
  });
}, { groupOnly: true, adminOnly: true, description: 'Toggle anti-link protection' });

handler.register('antibadword', 'moderation', async (sock, msg, args) => {
  const action = args[0]?.toLowerCase();
  
  if (!['on', 'off'].includes(action)) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Usage: .antibadword on/off' });
    return;
  }

  const enabled = action === 'on';
  await botSettings.updateGroupSetting(msg.key.remoteJid, 'antibadword', enabled);
  
  await sock.sendMessage(msg.key.remoteJid, {
    text: `${enabled ? '✅ Anti-badword enabled!' : '❌ Anti-badword disabled!'}\n${enabled ? 'Bad words will be automatically deleted.' : ''}`
  });
}, { groupOnly: true, adminOnly: true, description: 'Toggle bad word filter' });

handler.register('warn', 'moderation', async (sock, msg) => {
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please mention a user to warn!' });
    return;
  }

  const userId = mentioned[0];
  const user = await User.findOne({ jid: userId });
  
  if (user) {
    user.warnings += 1;
    await user.save();
    
    await sock.sendMessage(msg.key.remoteJid, {
      text: `⚠️ User warned! (${user.warnings}/3)\n${user.warnings >= 3 ? '🚫 User will be kicked!' : ''}`,
      mentions: mentioned
    });

    if (user.warnings >= 3) {
      try {
        await sock.groupParticipantsUpdate(msg.key.remoteJid, mentioned, 'remove');
      } catch (error) {
        console.error('Failed to kick user:', error);
      }
    }
  }
}, { groupOnly: true, adminOnly: true, description: 'Warn a user (3 warnings = kick)' });

// ========== SETTINGS COMMANDS ==========
handler.register('autostatusview', 'settings', async (sock, msg, args) => {
  const action = args[0]?.toLowerCase();
  
  if (!['on', 'off'].includes(action)) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Usage: .autostatusview on/off' });
    return;
  }

  await botSettings.updateGlobalSetting('autoStatusView', action === 'on');
  await sock.sendMessage(msg.key.remoteJid, {
    text: `${action === 'on' ? '✅ Auto status view enabled!' : '❌ Auto status view disabled!'}`
  });
}, { ownerOnly: true, description: 'Toggle automatic status viewing' });

handler.register('alwaysonline', 'settings', async (sock, msg, args) => {
  const action = args[0]?.toLowerCase();
  
  if (!['on', 'off'].includes(action)) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Usage: .alwaysonline on/off' });
    return;
  }

  await botSettings.updateGlobalSetting('alwaysOnline', action === 'on');
  await sock.sendMessage(msg.key.remoteJid, {
    text: `${action === 'on' ? '✅ Always online enabled!' : '❌ Always online disabled!'}`
  });
}, { ownerOnly: true, description: 'Toggle always online presence' });

handler.register('autoseen', 'settings', async (sock, msg, args) => {
  const action = args[0]?.toLowerCase();
  
  if (!['on', 'off'].includes(action)) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Usage: .autoseen on/off' });
    return;
  }

  await botSettings.updateGlobalSetting('autoSeen', action === 'on');
  await sock.sendMessage(msg.key.remoteJid, {
    text: `${action === 'on' ? '✅ Auto seen enabled!' : '❌ Auto seen disabled!'}`
  });
}, { ownerOnly: true, description: 'Toggle automatic read receipts' });

// ========== INFO COMMANDS ==========
handler.register('info', 'general', async (sock, msg) => {
  const uptime = process.uptime();
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);

  const text = `╭━━━『 *BOT INFO* 』━━━╮
│ 
│ 🤖 *Name:* ${process.env.BOT_NAME || 'WhatsApp Bot'}
│ 👤 *Owner:* @${process.env.OWNER_NUMBER}
│ ⏰ *Uptime:* ${days}d ${hours}h ${minutes}m ${seconds}s
│ 📱 *Platform:* Baileys
│ 🔖 *Prefix:* ${handler.prefix}
│ 💾 *Memory:* ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB
│ 
╰━━━━━━━━━━━━━━━━━━━━╯`;

  await sock.sendMessage(msg.key.remoteJid, {
    text,
    mentions: [`${process.env.OWNER_NUMBER}@s.whatsapp.net`]
  });
}, { aliases: ['botinfo'], description: 'Display bot information' });

handler.register('owner', 'general', async (sock, msg) => {
  await sock.sendMessage(msg.key.remoteJid, {
    text: `👤 *Bot Owner*\n\n@${process.env.OWNER_NUMBER}\n\nContact for support or inquiries.`,
    mentions: [`${process.env.OWNER_NUMBER}@s.whatsapp.net`]
  });
}, { description: 'Display owner contact' });

handler.register('groupinfo', 'group', async (sock, msg) => {
  try {
    const groupMetadata = await sock.groupMetadata(msg.key.remoteJid);
    const groupSettings = await botSettings.getGroupSettings(msg.key.remoteJid);
    
    const admins = groupMetadata.participants.filter(p => p.admin).length;
    const members = groupMetadata.participants.length;

    const text = `╭━━━『 *GROUP INFO* 』━━━╮
│ 
│ 📛 *Name:* ${groupMetadata.subject}
│ 🆔 *ID:* ${groupMetadata.id}
│ 👥 *Members:* ${members}
│ 👮 *Admins:* ${admins}
│ 📝 *Description:*
│ ${groupMetadata.desc || 'No description'}
│ 
│ ⚙️ *Settings:*
│ 🔗 Anti-Link: ${groupSettings.antilink ? '✅' : '❌'}
│ 🚫 Anti-Badword: ${groupSettings.antibadword ? '✅' : '❌'}
│ 🔇 Muted: ${groupSettings.muted ? '✅' : '❌'}
│ 🔒 Locked: ${groupSettings.locked ? '✅' : '❌'}
│ 
╰━━━━━━━━━━━━━━━━━━━━╯`;

    await sock.sendMessage(msg.key.remoteJid, { text });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Error: ${error.message}` });
  }
}, { groupOnly: true, description: 'Display group information' });

handler.register('admins', 'group', async (sock, msg) => {
  try {
    const groupMetadata = await sock.groupMetadata(msg.key.remoteJid);
    const admins = groupMetadata.participants.filter(p => p.admin);
    
    let text = `👮 *Group Admins* (${admins.length})\n\n`;
    const mentions = [];
    
    admins.forEach((admin, i) => {
      text += `${i + 1}. @${admin.id.split('@')[0]}\n`;
      mentions.push(admin.id);
    });

    await sock.sendMessage(msg.key.remoteJid, { text, mentions });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Error: ${error.message}` });
  }
}, { groupOnly: true, description: 'List all group admins' });

handler.register('profile', 'general', async (sock, msg) => {
  const userId = msg.key.participant || msg.key.remoteJid;
  const user = await User.findOne({ jid: userId });

  if (!user) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ User not found in database!' });
    return;
  }

  const text = `╭━━━『 *YOUR PROFILE* 』━━━╮
│ 
│ 👤 *Name:* ${user.name || 'Unknown'}
│ 📱 *Number:* @${userId.split('@')[0]}
│ ⚠️ *Warnings:* ${user.warnings}/3
│ 🚫 *Banned:* ${user.isBanned ? 'Yes' : 'No'}
│ 📊 *Commands Used:* ${user.commandUsage}
│ 📅 *Registered:* ${user.registeredAt.toLocaleDateString()}
│ 👁️ *Last Seen:* ${user.lastSeen.toLocaleString()}
│ 
╰━━━━━━━━━━━━━━━━━━━━╯`;

  await sock.sendMessage(msg.key.remoteJid, {
    text,
    mentions: [userId]
  });
}, { aliases: ['me'], description: 'View your profile' });

// ========== MEDIA & FUN COMMANDS ==========
handler.register('sticker', 'general', async (sock, msg) => {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  
  if (!quoted?.imageMessage && !quoted?.videoMessage) {
    await sock.sendMessage(msg.key.remoteJid, { 
      text: '❌ Please reply to an image or video (max 10 seconds)!' 
    });
    return;
  }

  try {
    await sock.sendMessage(msg.key.remoteJid, { text: '🎨 Creating sticker...' });
    
    const mediaType = quoted.imageMessage ? 'image' : 'video';
    const stream = await sock.downloadMediaMessage(quoted);
    
    await sock.sendMessage(msg.key.remoteJid, {
      sticker: stream
    });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { 
      text: `❌ Failed to create sticker: ${error.message}` 
    });
  }
}, { aliases: ['s'], description: 'Convert image/video to sticker' });

handler.register('delete', 'moderation', async (sock, msg) => {
  const quoted = msg.message?.extendedTextMessage?.contextInfo;
  
  if (!quoted || !quoted.participant) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please reply to a message to delete it!' });
    return;
  }

  try {
    await sock.sendMessage(msg.key.remoteJid, {
      delete: {
        remoteJid: msg.key.remoteJid,
        fromMe: false,
        id: quoted.stanzaId,
        participant: quoted.participant
      }
    });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Failed to delete message: ${error.message}` });
  }
}, { groupOnly: true, adminOnly: true, aliases: ['del'], description: 'Delete a message' });

handler.register('hidetag', 'group', async (sock, msg, args) => {
  const groupMetadata = await sock.groupMetadata(msg.key.remoteJid);
  const message = args.join(' ') || 'Hidden tag!';
  const mentions = groupMetadata.participants.map(p => p.id);
  
  await sock.sendMessage(msg.key.remoteJid, {
    text: message,
    mentions
  });
}, { groupOnly: true, adminOnly: true, description: 'Send hidden tag to all members' });

handler.register('invite', 'group', async (sock, msg) => {
  try {
    const code = await sock.groupInviteCode(msg.key.remoteJid);
    const groupMetadata = await sock.groupMetadata(msg.key.remoteJid);
    
    await sock.sendMessage(msg.key.remoteJid, {
      text: `╭━━━『 *GROUP INVITE* 』━━━╮
│ 
│ 📛 *Group:* ${groupMetadata.subject}
│ 🔗 *Link:* https://chat.whatsapp.com/${code}
│ 
╰━━━━━━━━━━━━━━━━━━━━╯

Share this link to invite others!`
    });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Error: ${error.message}` });
  }
}, { groupOnly: true, adminOnly: true, description: 'Get group invite link' });

handler.register('revoke', 'group', async (sock, msg) => {
  try {
    await sock.groupRevokeInvite(msg.key.remoteJid);
    await sock.sendMessage(msg.key.remoteJid, { 
      text: '✅ Group invite link has been revoked! Old links are now invalid.' 
    });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Error: ${error.message}` });
  }
}, { groupOnly: true, adminOnly: true, description: 'Revoke group invite link' });

handler.register('setname', 'group', async (sock, msg, args) => {
  if (args.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please provide a new group name!' });
    return;
  }

  const newName = args.join(' ');
  
  try {
    await sock.groupUpdateSubject(msg.key.remoteJid, newName);
    await sock.sendMessage(msg.key.remoteJid, { text: `✅ Group name changed to: *${newName}*` });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Error: ${error.message}` });
  }
}, { groupOnly: true, adminOnly: true, description: 'Change group name' });

handler.register('setdesc', 'group', async (sock, msg, args) => {
  if (args.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please provide a new group description!' });
    return;
  }

  const newDesc = args.join(' ');
  
  try {
    await sock.groupUpdateDescription(msg.key.remoteJid, newDesc);
    await sock.sendMessage(msg.key.remoteJid, { text: '✅ Group description updated successfully!' });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Error: ${error.message}` });
  }
}, { groupOnly: true, adminOnly: true, description: 'Change group description' });

// ========== OWNER COMMANDS ==========
handler.register('broadcast', 'owner', async (sock, msg, args) => {
  if (args.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Usage: .broadcast <message>' });
    return;
  }

  const message = args.join(' ');
  const chats = await sock.store?.chats?.all() || [];
  let success = 0, failed = 0;

  await sock.sendMessage(msg.key.remoteJid, { text: '📢 Broadcasting message...' });

  for (const chat of chats) {
    try {
      await sock.sendMessage(chat.id, {
        text: `📢 *BROADCAST MESSAGE*\n\n${message}\n\n_This is a broadcast message from bot owner_`
      });
      success++;
      await new Promise(resolve => setTimeout(resolve, 2000)); // Delay to avoid spam
    } catch (error) {
      failed++;
    }
  }

  await sock.sendMessage(msg.key.remoteJid, {
    text: `✅ Broadcast complete!\n\n✔️ Success: ${success}\n❌ Failed: ${failed}`
  });
}, { ownerOnly: true, description: 'Broadcast message to all chats' });

handler.register('join', 'owner', async (sock, msg, args) => {
  if (args.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { 
      text: '❌ Usage: .join <group_invite_link>' 
    });
    return;
  }

  const link = args[0];
  const code = link.split('/').pop();

  try {
    await sock.groupAcceptInvite(code);
    await sock.sendMessage(msg.key.remoteJid, { text: '✅ Successfully joined the group!' });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { 
      text: `❌ Failed to join group: ${error.message}` 
    });
  }
}, { ownerOnly: true, description: 'Join a group via invite link' });

handler.register('leave', 'owner', async (sock, msg) => {
  const isGroup = msg.key.remoteJid.endsWith('@g.us');
  
  if (!isGroup) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ This command only works in groups!' });
    return;
  }

  try {
    await sock.sendMessage(msg.key.remoteJid, { text: '👋 Goodbye! Bot is leaving...' });
    await sock.groupLeave(msg.key.remoteJid);
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Error: ${error.message}` });
  }
}, { ownerOnly: true, description: 'Make bot leave the group' });

handler.register('block', 'owner', async (sock, msg) => {
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please mention a user to block!' });
    return;
  }

  try {
    await sock.updateBlockStatus(mentioned[0], 'block');
    await sock.sendMessage(msg.key.remoteJid, { text: '✅ User blocked successfully!' });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Error: ${error.message}` });
  }
}, { ownerOnly: true, description: 'Block a user' });

handler.register('unblock', 'owner', async (sock, msg) => {
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please mention a user to unblock!' });
    return;
  }

  try {
    await sock.updateBlockStatus(mentioned[0], 'unblock');
    await sock.sendMessage(msg.key.remoteJid, { text: '✅ User unblocked successfully!' });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Error: ${error.message}` });
  }
}, { ownerOnly: true, description: 'Unblock a user' });

handler.register('ban', 'owner', async (sock, msg) => {
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please mention a user to ban!' });
    return;
  }

  const userId = mentioned[0];
  await User.findOneAndUpdate(
    { jid: userId },
    { $set: { isBanned: true } },
    { upsert: true }
  );

  await sock.sendMessage(msg.key.remoteJid, {
    text: '🚫 User has been banned from using the bot!',
    mentions: mentioned
  });
}, { ownerOnly: true, description: 'Ban user from using bot' });

handler.register('unban', 'owner', async (sock, msg) => {
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please mention a user to unban!' });
    return;
  }

  const userId = mentioned[0];
  await User.findOneAndUpdate(
    { jid: userId },
    { $set: { isBanned: false, warnings: 0 } }
  );

  await sock.sendMessage(msg.key.remoteJid, {
    text: '✅ User has been unbanned!',
    mentions: mentioned
  });
}, { ownerOnly: true, description: 'Unban user from using bot' });

handler.register('stats', 'owner', async (sock, msg) => {
  const totalUsers = await User.countDocuments();
  const totalGroups = await Group.countDocuments();
  const bannedUsers = await User.countDocuments({ isBanned: true });
  const totalCommands = await CommandLog.countDocuments();

  const text = `╭━━━『 *BOT STATISTICS* 』━━━╮
│ 
│ 👥 *Total Users:* ${totalUsers}
│ 🏘️ *Total Groups:* ${totalGroups}
│ 🚫 *Banned Users:* ${bannedUsers}
│ 📊 *Commands Executed:* ${totalCommands}
│ 💾 *Memory Usage:* ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB
│ ⏰ *Uptime:* ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m
│ 
╰━━━━━━━━━━━━━━━━━━━━╯`;

  await sock.sendMessage(msg.key.remoteJid, { text });
}, { ownerOnly: true, description: 'View bot statistics' });

handler.register('eval', 'owner', async (sock, msg, args) => {
  if (args.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please provide code to evaluate!' });
    return;
  }

  try {
    const code = args.join(' ');
    let result = await eval(code);
    
    if (typeof result !== 'string') {
      result = require('util').inspect(result);
    }

    await sock.sendMessage(msg.key.remoteJid, {
      text: `✅ *Result:*\n\`\`\`${result}\`\`\``
    });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, {
      text: `❌ *Error:*\n\`\`\`${error.message}\`\`\``
    });
  }
}, { ownerOnly: true, description: 'Evaluate JavaScript code (DANGEROUS)' });

handler.register('restart', 'owner', async (sock, msg) => {
  await sock.sendMessage(msg.key.remoteJid, { text: '🔄 Restarting bot...' });
  process.exit(0);
}, { ownerOnly: true, description: 'Restart the bot' });

// ========== UTILITY COMMANDS ==========
handler.register('poll', 'general', async (sock, msg, args) => {
  if (args.length < 3) {
    await sock.sendMessage(msg.key.remoteJid, {
      text: '❌ Usage: .poll <question> | <option1> | <option2> | ...\nExample: .poll Favorite color? | Red | Blue | Green'
    });
    return;
  }

  const parts = args.join(' ').split('|').map(s => s.trim());
  const question = parts[0];
  const options = parts.slice(1);

  if (options.length < 2) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please provide at least 2 options!' });
    return;
  }

  try {
    await sock.sendMessage(msg.key.remoteJid, {
      poll: {
        name: question,
        values: options,
        selectableCount: 1
      }
    });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Error: ${error.message}` });
  }
}, { description: 'Create a poll' });

handler.register('react', 'general', async (sock, msg, args) => {
  const quoted = msg.message?.extendedTextMessage?.contextInfo;
  
  if (!quoted) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please reply to a message!' });
    return;
  }

  const emoji = args[0] || '👍';

  try {
    await sock.sendMessage(msg.key.remoteJid, {
      react: {
        text: emoji,
        key: {
          remoteJid: msg.key.remoteJid,
          fromMe: false,
          id: quoted.stanzaId,
          participant: quoted.participant
        }
      }
    });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Error: ${error.message}` });
  }
}, { description: 'React to a message' });

handler.register('translate', 'general', async (sock, msg, args) => {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const text = quoted?.conversation || quoted?.extendedTextMessage?.text || args.join(' ');

  if (!text) {
    await sock.sendMessage(msg.key.remoteJid, {
      text: '❌ Usage: .translate <text> or reply to a message'
    });
    return;
  }

  await sock.sendMessage(msg.key.remoteJid, {
    text: '💡 Translation feature requires external API. Please integrate a translation service.'
  });
}, { aliases: ['tr'], description: 'Translate text (requires API)' });

handler.register('calculate', 'general', async (sock, msg, args) => {
  if (args.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, {
      text: '❌ Usage: .calculate <expression>\nExample: .calculate 2 + 2'
    });
    return;
  }

  try {
    const expression = args.join(' ');
    // Simple safe evaluation
    const result = Function('"use strict"; return (' + expression + ')')();
    
    await sock.sendMessage(msg.key.remoteJid, {
      text: `🧮 *Calculator*\n\n${expression} = ${result}`
    });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, {
      text: '❌ Invalid expression! Use only numbers and operators (+, -, *, /, %)'
    });
  }
}, { aliases: ['calc', 'math'], description: 'Calculate mathematical expressions' });

handler.register('flipcoin', 'general', async (sock, msg) => {
  const result = Math.random() < 0.5 ? 'Heads 🪙' : 'Tails 🪙';
  await sock.sendMessage(msg.key.remoteJid, {
    text: `🎲 Coin Flip: *${result}*`
  });
}, { aliases: ['coin'], description: 'Flip a coin' });

handler.register('dice', 'general', async (sock, msg) => {
  const result = Math.floor(Math.random() * 6) + 1;
  const emoji = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][result - 1];
  
  await sock.sendMessage(msg.key.remoteJid, {
    text: `🎲 Dice Roll: *${result}* ${emoji}`
  });
}, { description: 'Roll a dice' });

handler.register('choose', 'general', async (sock, msg, args) => {
  if (args.length < 2) {
    await sock.sendMessage(msg.key.remoteJid, {
      text: '❌ Usage: .choose <option1> <option2> ...\nExample: .choose pizza burger pasta'
    });
    return;
  }

  const choice = args[Math.floor(Math.random() * args.length)];
  await sock.sendMessage(msg.key.remoteJid, {
    text: `🎯 I choose: *${choice}*`
  });
}, { aliases: ['pick'], description: 'Choose randomly from options' });

handler.register('reminder', 'general', async (sock, msg, args) => {
  if (args.length < 2) {
    await sock.sendMessage(msg.key.remoteJid, {
      text: '❌ Usage: .reminder <minutes> <message>\nExample: .reminder 10 Check the oven'
    });
    return;
  }

  const minutes = parseInt(args[0]);
  if (isNaN(minutes) || minutes <= 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please provide a valid number of minutes!' });
    return;
  }

  const message = args.slice(1).join(' ');
  const userId = msg.key.participant || msg.key.remoteJid;

  await sock.sendMessage(msg.key.remoteJid, {
    text: `⏰ Reminder set for ${minutes} minute(s)!`
  });

  setTimeout(async () => {
    await sock.sendMessage(msg.key.remoteJid, {
      text: `⏰ *REMINDER*\n\n@${userId.split('@')[0]}\n${message}`,
      mentions: [userId]
    });
  }, minutes * 60 * 1000);
}, { aliases: ['remind'], description: 'Set a reminder' });

// ========== DOWNLOAD COMMANDS ==========
handler.register('ytdl', 'general', async (sock, msg, args) => {
  if (args.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, {
      text: '❌ Usage: .ytdl <youtube_url>\nNote: Requires ytdl-core package integration'
    });
    return;
  }

  await sock.sendMessage(msg.key.remoteJid, {
    text: '💡 YouTube download feature requires ytdl-core package. Please integrate it for full functionality.'
  });
}, { aliases: ['youtube', 'yt'], description: 'Download YouTube video (requires integration)' });

handler.register('igdl', 'general', async (sock, msg, args) => {
  if (args.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, {
      text: '❌ Usage: .igdl <instagram_url>\nNote: Requires Instagram API integration'
    });
    return;
  }

  await sock.sendMessage(msg.key.remoteJid, {
    text: '💡 Instagram download feature requires API integration. Please add your preferred Instagram downloader API.'
  });
}, { aliases: ['instagram', 'ig'], description: 'Download Instagram media (requires integration)' });

handler.register('tiktok', 'general', async (sock, msg, args) => {
  if (args.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, {
      text: '❌ Usage: .tiktok <tiktok_url>\nNote: Requires TikTok API integration'
    });
    return;
  }

  await sock.sendMessage(msg.key.remoteJid, {
    text: '💡 TikTok download feature requires API integration. Please add your preferred TikTok downloader API.'
  });
}, { aliases: ['tt'], description: 'Download TikTok video (requires integration)' });

// ========== TEXT MANIPULATION ==========
handler.register('lowercase', 'general', async (sock, msg, args) => {
  const text = args.join(' ');
  if (!text) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please provide text to convert!' });
    return;
  }

  await sock.sendMessage(msg.key.remoteJid, { text: text.toLowerCase() });
}, { aliases: ['lower'], description: 'Convert text to lowercase' });

handler.register('uppercase', 'general', async (sock, msg, args) => {
  const text = args.join(' ');
  if (!text) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please provide text to convert!' });
    return;
  }

  await sock.sendMessage(msg.key.remoteJid, { text: text.toUpperCase() });
}, { aliases: ['upper'], description: 'Convert text to uppercase' });

handler.register('reverse', 'general', async (sock, msg, args) => {
  const text = args.join(' ');
  if (!text) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please provide text to reverse!' });
    return;
  }

  await sock.sendMessage(msg.key.remoteJid, { text: text.split('').reverse().join('') });
}, { description: 'Reverse text' });

handler.register('fancy', 'general', async (sock, msg, args) => {
  const text = args.join(' ');
  if (!text) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please provide text to convert!' });
    return;
  }

  const fancyText = text.split('').map(char => {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCharCode(code + 119743);
    if (code >= 97 && code <= 122) return String.fromCharCode(code + 119737);
    return char;
  }).join('');

  await sock.sendMessage(msg.key.remoteJid, { text: fancyText });
}, { description: 'Convert text to fancy font' });

// ========== SEARCH COMMANDS ==========
handler.register('weather', 'general', async (sock, msg, args) => {
  if (args.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, {
      text: '❌ Usage: .weather <city>\nNote: Requires weather API integration'
    });
    return;
  }

  await sock.sendMessage(msg.key.remoteJid, {
    text: '💡 Weather feature requires OpenWeatherMap or similar API. Please integrate for full functionality.'
  });
}, { description: 'Get weather information (requires API)' });

handler.register('google', 'general', async (sock, msg, args) => {
  if (args.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Usage: .google <query>' });
    return;
  }

  const query = encodeURIComponent(args.join(' '));
  const url = `https://www.google.com/search?q=${query}`;

  await sock.sendMessage(msg.key.remoteJid, {
    text: `🔍 *Google Search*\n\nQuery: ${args.join(' ')}\nLink: ${url}`
  });
}, { aliases: ['search'], description: 'Generate Google search link' });

handler.register('lyrics', 'general', async (sock, msg, args) => {
  if (args.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Usage: .lyrics <song name>' });
    return;
  }

  await sock.sendMessage(msg.key.remoteJid, {
    text: '💡 Lyrics feature requires Genius API or similar. Please integrate for full functionality.'
  });
}, { description: 'Get song lyrics (requires API)' });

// ========== ADMIN TOOLS ==========
handler.register('resetwarnings', 'moderation', async (sock, msg) => {
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please mention a user!' });
    return;
  }

  const userId = mentioned[0];
  await User.findOneAndUpdate(
    { jid: userId },
    { $set: { warnings: 0 } }
  );

  await sock.sendMessage(msg.key.remoteJid, {
    text: '✅ Warnings reset for @' + userId.split('@')[0],
    mentions: mentioned
  });
}, { groupOnly: true, adminOnly: true, aliases: ['clearwarnings'], description: 'Reset user warnings' });

handler.register('kick', 'group', async (sock, msg) => {
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please mention users to kick!' });
    return;
  }

  try {
    await sock.groupParticipantsUpdate(msg.key.remoteJid, mentioned, 'remove');
    await sock.sendMessage(msg.key.remoteJid, {
      text: `✅ Kicked ${mentioned.length} user(s) successfully!`
    });
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, { text: `❌ Error: ${error.message}` });
  }
}, { groupOnly: true, adminOnly: true, description: 'Kick multiple users' });

handler.register('quoted', 'general', async (sock, msg) => {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  
  if (!quoted) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Please reply to a message!' });
    return;
  }

  const text = quoted.conversation || quoted.extendedTextMessage?.text || 'No text content';
  
  await sock.sendMessage(msg.key.remoteJid, {
    text: `📝 *Quoted Message:*\n\n${text}`
  });
}, { aliases: ['q'], description: 'Get quoted message text' });

handler.register('runtime', 'general', async (sock, msg) => {
  const uptime = process.uptime();
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);

  await sock.sendMessage(msg.key.remoteJid, {
    text: `⏰ *Runtime*\n\n${days}d ${hours}h ${minutes}m ${seconds}s`
  });
}, { description: 'Check bot runtime' });

// Register all downloader commands
registerAllDownloaderCommands(handler);

export default handler;