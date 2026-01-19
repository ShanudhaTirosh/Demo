import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// User Schema
const userSchema = new mongoose.Schema({
  jid: { type: String, required: true, unique: true },
  name: String,
  isRegistered: { type: Boolean, default: true },
  isBanned: { type: Boolean, default: false },
  warnings: { type: Number, default: 0 },
  commandUsage: { type: Number, default: 0 },
  registeredAt: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now }
});

// Group Schema
const groupSchema = new mongoose.Schema({
  jid: { type: String, required: true, unique: true },
  name: String,
  participants: [String],
  admins: [String],
  settings: {
    antilink: { type: Boolean, default: false },
    antibadword: { type: Boolean, default: false },
    muted: { type: Boolean, default: false },
    locked: { type: Boolean, default: false }
  },
  bannedUsers: [String],
  createdAt: { type: Date, default: Date.now }
});

// Bot Settings Schema
const settingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  global: {
    autoStatusView: { type: Boolean, default: false },
    alwaysOnline: { type: Boolean, default: true },
    autoSeen: { type: Boolean, default: false },
    antilink: { type: Boolean, default: false },
    antibadword: { type: Boolean, default: false }
  },
  badWords: {
    type: [String],
    default: ['badword1', 'badword2', 'fuck', 'shit', 'damn']
  },
  updatedAt: { type: Date, default: Date.now }
});

// Command Logs Schema
const commandLogSchema = new mongoose.Schema({
  user: String,
  command: String,
  group: String,
  timestamp: { type: Date, default: Date.now }
});

// Session Schema
const sessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  data: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Models
export const User = mongoose.model('User', userSchema);
export const Group = mongoose.model('Group', groupSchema);
export const Settings = mongoose.model('Settings', settingsSchema);
export const CommandLog = mongoose.model('CommandLog', commandLogSchema);
export const Session = mongoose.model('Session', sessionSchema);

// Connect to MongoDB
export const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB connected successfully');
    
    // Initialize default settings if not exists
    const existingSettings = await Settings.findOne({ key: 'bot_settings' });
    if (!existingSettings) {
      await Settings.create({ key: 'bot_settings' });
      console.log('✅ Default settings initialized');
    }
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Helper functions
export const getOrCreateUser = async (jid, name = '') => {
  let user = await User.findOne({ jid });
  if (!user) {
    user = await User.create({ jid, name });
  } else {
    user.lastSeen = new Date();
    await user.save();
  }
  return user;
};

export const getOrCreateGroup = async (jid, name = '', participants = [], admins = []) => {
  let group = await Group.findOne({ jid });
  if (!group) {
    group = await Group.create({ jid, name, participants, admins });
  } else {
    group.participants = participants;
    group.admins = admins;
    await group.save();
  }
  return group;
};

export const logCommand = async (user, command, group = null) => {
  await CommandLog.create({ user, command, group });
};

export const getSettings = async () => {
  const settings = await Settings.findOne({ key: 'bot_settings' });
  return settings || { global: {} };
};

export const updateSettings = async (updates) => {
  const settings = await Settings.findOneAndUpdate(
    { key: 'bot_settings' },
    { $set: updates, updatedAt: new Date() },
    { new: true, upsert: true }
  );
  return settings;
};