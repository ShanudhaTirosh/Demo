import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeInMemoryStore,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import dotenv from 'dotenv';
import fs from 'fs';
import { connectDB, getOrCreateUser, getOrCreateGroup } from './db.js';
import commandHandler from './commands.js';
import botSettings from './settings.js';

dotenv.config();

// Create session directory
const SESSION_DIR = './session';
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Logger
const logger = pino({ level: 'silent' });

// Store for message handling
const store = makeInMemoryStore({ logger });
store?.readFromFile('./store.json');
setInterval(() => {
  store?.writeToFile('./store.json');
}, 30000);

// Link detection regex
const linkRegex = /(https?:\/\/|www\.)[^\s]+/gi;

class WhatsAppBot {
  constructor() {
    this.sock = null;
    this.retryCount = 0;
    this.maxRetries = 5;
  }

  async start() {
    await connectDB();
    await this.connectToWhatsApp();
  }

  async connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: ['ubuntu', 'Chrome', '121.0.0'],
      getMessage: async (key) => {
        if (store) {
          const msg = await store.loadMessage(key.remoteJid, key.id);
          return msg?.message || undefined;
        }
        return undefined;
      }
    });

    // Bind store
    store?.bind(this.sock.ev);

    // Handle pairing code
    if (!this.sock.authState.creds.registered) {
      const phoneNumber = process.env.BOT_NUMBER;
      
      if (!phoneNumber) {
        console.error('❌ Please set BOT_NUMBER in .env file');
        process.exit(1);
      }

      setTimeout(async () => {
        try {
          const code = await this.sock.requestPairingCode(phoneNumber);
          console.log(`\n🔐 Pairing Code: ${code}\n`);
          console.log('📱 Enter this code in WhatsApp > Linked Devices > Link a Device');
        } catch (error) {
          console.error('❌ Failed to get pairing code:', error);
        }
      }, 3000);
    }

    // Connection updates
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
          : true;

        console.log('❌ Connection closed. Reconnecting:', shouldReconnect);

        if (shouldReconnect) {
          if (this.retryCount < this.maxRetries) {
            this.retryCount++;
            setTimeout(() => this.connectToWhatsApp(), 3000);
          } else {
            console.error('❌ Max retries reached. Please restart the bot.');
          }
        } else {
          console.log('❌ Logged out. Please delete session folder and restart.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        this.retryCount = 0;
        console.log('✅ Connected to WhatsApp successfully!');
        
        // Set presence
        if (await botSettings.isAlwaysOnlineEnabled()) {
          await this.sock.sendPresenceUpdate('available');
        }
      }
    });

    // Save credentials
    this.sock.ev.on('creds.update', saveCreds);

    // Handle messages
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');
        const userId = msg.key.participant || sender;

        // Auto seen
        if (await botSettings.isAutoSeenEnabled()) {
          await this.sock.readMessages([msg.key]);
        }

        // Store user info
        const userName = msg.pushName || 'Unknown';
        await getOrCreateUser(userId, userName);

        // Store group info
        if (isGroup) {
          try {
            const groupMetadata = await this.sock.groupMetadata(sender);
            const participants = groupMetadata.participants.map(p => p.id);
            const admins = groupMetadata.participants
              .filter(p => p.admin)
              .map(p => p.id);
            
            await getOrCreateGroup(sender, groupMetadata.subject, participants, admins);
          } catch (error) {
            console.error('Error fetching group metadata:', error);
          }
        }

        // Get message text
        const text = msg.message?.conversation || 
                     msg.message?.extendedTextMessage?.text || '';

        // Anti-link check (only in groups)
        if (isGroup && await botSettings.isAntiLinkEnabled(sender)) {
          if (linkRegex.test(text)) {
            const groupMetadata = await this.sock.groupMetadata(sender);
            const isAdmin = groupMetadata.participants
              .find(p => p.id === userId)?.admin;
            
            // Don't delete if sender is admin or owner
            if (!isAdmin && userId.split('@')[0] !== process.env.OWNER_NUMBER) {
              try {
                await this.sock.sendMessage(sender, {
                  delete: msg.key
                });
                await this.sock.sendMessage(sender, {
                  text: '⚠️ Links are not allowed in this group!',
                  mentions: [userId]
                });
              } catch (error) {
                console.error('Failed to delete message:', error);
              }
              continue;
            }
          }
        }

        // Anti-badword check (only in groups)
        if (isGroup && await botSettings.isAntiBadWordEnabled(sender)) {
          const badWords = await botSettings.getBadWords();
          const lowerText = text.toLowerCase();
          
          const hasBadWord = badWords.some(word => lowerText.includes(word));
          
          if (hasBadWord) {
            const groupMetadata = await this.sock.groupMetadata(sender);
            const isAdmin = groupMetadata.participants
              .find(p => p.id === userId)?.admin;
            
            if (!isAdmin && userId.split('@')[0] !== process.env.OWNER_NUMBER) {
              try {
                await this.sock.sendMessage(sender, {
                  delete: msg.key
                });
                await this.sock.sendMessage(sender, {
                  text: '⚠️ Bad words are not allowed!',
                  mentions: [userId]
                });
              } catch (error) {
                console.error('Failed to delete message:', error);
              }
              continue;
            }
          }
        }

        // Handle commands
        if (text.startsWith(commandHandler.prefix)) {
          await commandHandler.execute(this.sock, msg);
        }
      }
    });

    // Group participants update
    this.sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
      try {
        const groupMetadata = await this.sock.groupMetadata(id);
        
        if (action === 'add') {
          for (const participant of participants) {
            await this.sock.sendMessage(id, {
              text: `👋 Welcome @${participant.split('@')[0]} to *${groupMetadata.subject}*!`,
              mentions: [participant]
            });
          }
        } else if (action === 'remove') {
          for (const participant of participants) {
            await this.sock.sendMessage(id, {
              text: `👋 Goodbye @${participant.split('@')[0]}!`,
              mentions: [participant]
            });
          }
        }
      } catch (error) {
        console.error('Error handling group participant update:', error);
      }
    });

    // Status updates (auto view)
    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      if (!await botSettings.isAutoStatusViewEnabled()) return;

      for (const msg of messages) {
        if (msg.key.remoteJid === 'status@broadcast') {
          await this.sock.readMessages([msg.key]);
        }
      }
    });

    // Keep presence updated
    if (await botSettings.isAlwaysOnlineEnabled()) {
      setInterval(async () => {
        try {
          await this.sock.sendPresenceUpdate('available');
        } catch (error) {
          // Ignore presence update errors
        }
      }, 30000);
    }
  }
}

// Start bot
const bot = new WhatsAppBot();
bot.start().catch(err => {
  console.error('❌ Failed to start bot:', err);
  process.exit(1);
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Bot shutting down...');
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});