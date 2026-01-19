import { Settings, Group } from './db.js';

class BotSettings {
  constructor() {
    this.cache = null;
  }

  async getGlobalSettings() {
    if (!this.cache) {
      const settings = await Settings.findOne({ key: 'bot_settings' });
      this.cache = settings?.global || {};
    }
    return this.cache;
  }

  async updateGlobalSetting(key, value) {
    const update = {};
    update[`global.${key}`] = value;
    
    await Settings.findOneAndUpdate(
      { key: 'bot_settings' },
      { $set: update },
      { upsert: true }
    );
    
    this.cache = null; // Clear cache
    return true;
  }

  async getGroupSettings(groupJid) {
    const group = await Group.findOne({ jid: groupJid });
    return group?.settings || {
      antilink: false,
      antibadword: false,
      muted: false,
      locked: false
    };
  }

  async updateGroupSetting(groupJid, key, value) {
    const update = {};
    update[`settings.${key}`] = value;
    
    await Group.findOneAndUpdate(
      { jid: groupJid },
      { $set: update },
      { upsert: true }
    );
    
    return true;
  }

  async getBadWords() {
    const settings = await Settings.findOne({ key: 'bot_settings' });
    return settings?.badWords || [];
  }

  async addBadWord(word) {
    await Settings.findOneAndUpdate(
      { key: 'bot_settings' },
      { $addToSet: { badWords: word.toLowerCase() } },
      { upsert: true }
    );
    return true;
  }

  async removeBadWord(word) {
    await Settings.findOneAndUpdate(
      { key: 'bot_settings' },
      { $pull: { badWords: word.toLowerCase() } }
    );
    return true;
  }

  async isAntiLinkEnabled(groupJid) {
    const groupSettings = await this.getGroupSettings(groupJid);
    const globalSettings = await this.getGlobalSettings();
    return groupSettings.antilink || globalSettings.antilink || false;
  }

  async isAntiBadWordEnabled(groupJid) {
    const groupSettings = await this.getGroupSettings(groupJid);
    const globalSettings = await this.getGlobalSettings();
    return groupSettings.antibadword || globalSettings.antibadword || false;
  }

  async isAutoStatusViewEnabled() {
    const settings = await this.getGlobalSettings();
    return settings.autoStatusView || false;
  }

  async isAlwaysOnlineEnabled() {
    const settings = await this.getGlobalSettings();
    return settings.alwaysOnline !== false; // Default true
  }

  async isAutoSeenEnabled() {
    const settings = await this.getGlobalSettings();
    return settings.autoSeen || false;
  }

  clearCache() {
    this.cache = null;
  }
}

export default new BotSettings();