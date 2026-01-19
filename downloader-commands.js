import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// API Configuration
const API_BASE = 'https://api.prabath.top/api/v1';
const API_KEY = 'prabath_sk_077fb699e307ba097affa7be3ea1eefa851a78d6';
const TEMP_DIR = path.join(__dirname, 'temp');
const MAX_FILE_SIZE = 2000 * 1024 * 1024; // 2GB in bytes

// Create temp directory if not exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Store active searches per user
const activeSearches = new Map();

// Helper: Make API Request
async function apiRequest(endpoint, data = {}) {
  try {
    const response = await axios.post(`${API_BASE}${endpoint}`, data, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      timeout: 60000
    });
    return response.data;
  } catch (error) {
    console.error('API Error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.message || 'API request failed');
  }
}

// Helper: Download File
async function downloadFile(url, filename) {
  const filepath = path.join(TEMP_DIR, filename);
  const writer = fs.createWriteStream(filepath);

  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 300000 // 5 minutes
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(filepath));
    writer.on('error', reject);
  });
}

// Helper: Get File Size
async function getFileSize(url) {
  try {
    const response = await axios.head(url);
    return parseInt(response.headers['content-length'] || 0);
  } catch (error) {
    return 0;
  }
}

// Helper: Format File Size
function formatSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Helper: Clean Up File
function cleanupFile(filepath) {
  try {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

// Helper: Send Large File (Split if needed)
async function sendLargeFile(sock, jid, filepath, caption, mimeType) {
  const stats = fs.statSync(filepath);
  const fileSize = stats.size;

  if (fileSize > MAX_FILE_SIZE) {
    await sock.sendMessage(jid, {
      text: `⚠️ File too large (${formatSize(fileSize)})\nWhatsApp limit is 2GB. Please use a different quality or format.`
    });
    cleanupFile(filepath);
    return;
  }

  const mediaType = mimeType.startsWith('video') ? 'video' : 
                    mimeType.startsWith('audio') ? 'audio' : 'document';

  const message = {
    [mediaType]: fs.readFileSync(filepath),
    caption: caption,
    mimetype: mimeType
  };

  if (mediaType === 'document') {
    message.fileName = path.basename(filepath);
  }

  await sock.sendMessage(jid, message);
  cleanupFile(filepath);
}

// ==================== YOUTUBE COMMANDS ====================

export function registerYouTubeCommands(handler) {
  handler.register('yt', 'download', async (sock, msg, args) => {
    if (args.length === 0) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '❌ Usage: .yt <youtube_url>\nExample: .yt https://youtube.com/watch?v=xxxxx'
      });
      return;
    }

    const url = args[0];

    try {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '⏳ Fetching video information...'
      });

      const data = await apiRequest('/dl/youtube', { url });

      if (!data.success) {
        throw new Error('Failed to fetch video');
      }

      const info = data.data;
      const message = `🎥 *${info.title}*

📺 Channel: ${info.channel || 'Unknown'}
⏱️ Duration: ${info.duration || 'Unknown'}
👁️ Views: ${info.views || 'Unknown'}

📥 Select quality:
Reply with number to download

1️⃣ Video - High Quality
2️⃣ Video - Medium Quality  
3️⃣ Audio Only (MP3)`;

      await sock.sendMessage(msg.key.remoteJid, {
        text: message,
        contextInfo: info.thumbnail ? {
          externalAdReply: {
            title: info.title,
            body: 'YouTube Downloader',
            thumbnailUrl: info.thumbnail,
            sourceUrl: url
          }
        } : undefined
      });

      // Store for selection
      activeSearches.set(msg.key.participant || msg.key.remoteJid, {
        type: 'youtube',
        data: info,
        url: url
      });

    } catch (error) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: `❌ Error: ${error.message}`
      });
    }
  }, { description: 'Download YouTube videos' });

  handler.register('yts', 'download', async (sock, msg, args) => {
    if (args.length === 0) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '❌ Usage: .yts <search query>\nExample: .yts despacito'
      });
      return;
    }

    const query = args.join(' ');

    try {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '🔍 Searching YouTube...'
      });

      const data = await apiRequest('/search/youtube', { query });

      if (!data.success || !data.data.length) {
        throw new Error('No results found');
      }

      const results = data.data.slice(0, 10);
      let message = `🔍 *YouTube Search Results*\n\nQuery: "${query}"\n\n`;

      results.forEach((video, index) => {
        message += `${index + 1}️⃣ *${video.title}*\n`;
        message += `   👤 ${video.channel}\n`;
        message += `   ⏱️ ${video.duration} | 👁️ ${video.views}\n\n`;
      });

      message += '📝 Reply with number (1-10) to download';

      await sock.sendMessage(msg.key.remoteJid, { text: message });

      activeSearches.set(msg.key.participant || msg.key.remoteJid, {
        type: 'youtube-search',
        results: results,
        query: query
      });

    } catch (error) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: `❌ Error: ${error.message}`
      });
    }
  }, { aliases: ['ytsearch'], description: 'Search YouTube videos' });
}

// ==================== MOVIE COMMANDS ====================

export function registerMovieCommands(handler) {
  handler.register('movie', 'download', async (sock, msg, args) => {
    if (args.length === 0) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '❌ Usage: .movie <movie name>\nExample: .movie Inception'
      });
      return;
    }

    const query = args.join(' ');

    try {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '🎬 Searching for movies...'
      });

      const data = await apiRequest('/search/cinemasearch', { query });

      if (!data.success || !data.data.length) {
        throw new Error('No movies found');
      }

      const results = data.data.slice(0, 10);
      let message = `🎬 *Movie Search Results*\n\nQuery: "${query}"\n\n`;

      results.forEach((movie, index) => {
        message += `${index + 1}️⃣ *${movie.title}*\n`;
        message += `   📅 ${movie.year || 'N/A'}\n`;
        message += `   ⭐ ${movie.rating || 'N/A'}\n`;
        message += `   🎭 ${movie.type || 'Movie'}\n\n`;
      });

      message += '📝 Reply with number (1-10) to get download link';

      await sock.sendMessage(msg.key.remoteJid, { text: message });

      activeSearches.set(msg.key.participant || msg.key.remoteJid, {
        type: 'movie-search',
        results: results,
        query: query
      });

    } catch (error) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: `❌ Error: ${error.message}`
      });
    }
  }, { aliases: ['movies'], description: 'Search and download movies' });

  handler.register('cineru', 'download', async (sock, msg, args) => {
    if (args.length === 0) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '❌ Usage: .cineru <movie_url>\nExample: .cineru https://cineru.lk/movie/xxx'
      });
      return;
    }

    const url = args[0];

    try {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '⏳ Fetching movie details...'
      });

      const data = await apiRequest('/dl/cinerumovie', { url });

      if (!data.success) {
        throw new Error('Failed to fetch movie');
      }

      const movie = data.data;
      let message = `🎬 *${movie.title}*\n\n`;
      
      if (movie.description) message += `📝 ${movie.description}\n\n`;
      if (movie.year) message += `📅 Year: ${movie.year}\n`;
      if (movie.quality) message += `📺 Quality: ${movie.quality}\n`;
      if (movie.size) message += `💾 Size: ${movie.size}\n\n`;

      if (movie.downloadLinks && movie.downloadLinks.length > 0) {
        message += '📥 Download Links:\n\n';
        movie.downloadLinks.forEach((link, index) => {
          message += `${index + 1}️⃣ ${link.quality || 'Download'}\n`;
          message += `   ${link.url}\n\n`;
        });
      }

      await sock.sendMessage(msg.key.remoteJid, {
        text: message,
        contextInfo: movie.thumbnail ? {
          externalAdReply: {
            title: movie.title,
            body: 'Cineru Movie',
            thumbnailUrl: movie.thumbnail,
            sourceUrl: url
          }
        } : undefined
      });

    } catch (error) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: `❌ Error: ${error.message}`
      });
    }
  }, { description: 'Download from Cineru' });
}

// ==================== TV SHOW COMMANDS ====================

export function registerTVCommands(handler) {
  handler.register('tvsearch', 'download', async (sock, msg, args) => {
    if (args.length === 0) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '❌ Usage: .tvsearch <show name>\nExample: .tvsearch Breaking Bad'
      });
      return;
    }

    const query = args.join(' ');

    try {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '📺 Searching TV shows...'
      });

      const data = await apiRequest('/search/cinerutvseries', { query });

      if (!data.success || !data.data.length) {
        throw new Error('No TV shows found');
      }

      const results = data.data.slice(0, 10);
      let message = `📺 *TV Show Search Results*\n\nQuery: "${query}"\n\n`;

      results.forEach((show, index) => {
        message += `${index + 1}️⃣ *${show.title}*\n`;
        message += `   📅 ${show.year || 'N/A'}\n`;
        message += `   ⭐ ${show.rating || 'N/A'}\n`;
        message += `   🎬 ${show.seasons || 'N/A'} Seasons\n\n`;
      });

      message += '📝 Reply with number (1-10) to see episodes';

      await sock.sendMessage(msg.key.remoteJid, { text: message });

      activeSearches.set(msg.key.participant || msg.key.remoteJid, {
        type: 'tv-search',
        results: results,
        query: query
      });

    } catch (error) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: `❌ Error: ${error.message}`
      });
    }
  }, { aliases: ['tvshow'], description: 'Search TV shows' });

  handler.register('episode', 'download', async (sock, msg, args) => {
    if (args.length === 0) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '❌ Usage: .episode <episode_url>\nExample: .episode https://cineru.lk/episode/xxx'
      });
      return;
    }

    const url = args[0];

    try {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '⏳ Fetching episode...'
      });

      const data = await apiRequest('/dl/cineruepisode', { url });

      if (!data.success) {
        throw new Error('Failed to fetch episode');
      }

      const episode = data.data;
      let message = `📺 *${episode.title}*\n\n`;
      
      if (episode.season) message += `📅 Season ${episode.season}\n`;
      if (episode.episode) message += `🎬 Episode ${episode.episode}\n`;
      if (episode.quality) message += `📺 Quality: ${episode.quality}\n\n`;

      if (episode.downloadLink) {
        message += `📥 Download:\n${episode.downloadLink}`;
      }

      await sock.sendMessage(msg.key.remoteJid, { text: message });

    } catch (error) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: `❌ Error: ${error.message}`
      });
    }
  }, { aliases: ['ep'], description: 'Download TV episode' });
}

// ==================== BAISCOPE COMMANDS ====================

export function registerBaiscopeCommands(handler) {
  handler.register('baiscope', 'download', async (sock, msg, args) => {
    if (args.length === 0) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '❌ Usage: .baiscope <search query>\nExample: .baiscope Inception'
      });
      return;
    }

    const query = args.join(' ');

    try {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '🎬 Searching Baiscope...'
      });

      const data = await apiRequest('/search/baiscopesearch', { query });

      if (!data.success || !data.data.length) {
        throw new Error('No results found');
      }

      const results = data.data.slice(0, 10);
      let message = `🎬 *Baiscope Search Results*\n\nQuery: "${query}"\n\n`;

      results.forEach((item, index) => {
        message += `${index + 1}️⃣ *${item.title}*\n`;
        message += `   📅 ${item.year || 'N/A'}\n`;
        message += `   🎭 ${item.type || 'Movie'}\n\n`;
      });

      message += '📝 Reply with number (1-10) to download';

      await sock.sendMessage(msg.key.remoteJid, { text: message });

      activeSearches.set(msg.key.participant || msg.key.remoteJid, {
        type: 'baiscope-search',
        results: results,
        query: query
      });

    } catch (error) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: `❌ Error: ${error.message}`
      });
    }
  }, { description: 'Search Baiscope content' });
}

// ==================== SINHALA SUB COMMANDS ====================

export function registerSinhalaSubCommands(handler) {
  handler.register('sisubsearch', 'download', async (sock, msg, args) => {
    if (args.length === 0) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '❌ Usage: .sisubsearch <movie name>\nExample: .sisubsearch Inception'
      });
      return;
    }

    const query = args.join(' ');

    try {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '🔍 Searching Sinhala subs...'
      });

      const data = await apiRequest('/search/sinhalasub', { query });

      if (!data.success || !data.data.length) {
        throw new Error('No results found');
      }

      const results = data.data.slice(0, 10);
      let message = `🎬 *Sinhala Sub Search*\n\nQuery: "${query}"\n\n`;

      results.forEach((item, index) => {
        message += `${index + 1}️⃣ *${item.title}*\n`;
        message += `   📅 ${item.year || 'N/A'}\n`;
        message += `   🎭 ${item.type || 'Movie'}\n\n`;
      });

      message += '📝 Reply with number (1-10) to get details';

      await sock.sendMessage(msg.key.remoteJid, { text: message });

      activeSearches.set(msg.key.participant || msg.key.remoteJid, {
        type: 'sisubsearch',
        results: results,
        query: query
      });

    } catch (error) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: `❌ Error: ${error.message}`
      });
    }
  }, { aliases: ['sisub'], description: 'Search Sinhala subtitles' });
}

// ==================== GREETING & STICKER COMMANDS ====================

export function registerMediaCommands(handler) {
  handler.register('greet', 'media', async (sock, msg, args) => {
    if (args.length === 0) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '❌ Usage: .greet <text>\nExample: .greet Happy Birthday!'
      });
      return;
    }

    const text = args.join(' ');

    try {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '🎨 Creating greeting card...'
      });

      const data = await apiRequest('/maker/greeting', { text });

      if (!data.success || !data.data.url) {
        throw new Error('Failed to create greeting');
      }

      await sock.sendMessage(msg.key.remoteJid, {
        image: { url: data.data.url },
        caption: `🎉 ${text}`
      });

    } catch (error) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: `❌ Error: ${error.message}`
      });
    }
  }, { description: 'Create greeting card' });

  handler.register('birthday', 'media', async (sock, msg, args) => {
    if (args.length === 0) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '❌ Usage: .birthday <name>\nExample: .birthday John'
      });
      return;
    }

    const name = args.join(' ');

    try {
      const data = await apiRequest('/maker/birthday', { name });

      if (!data.success || !data.data.url) {
        throw new Error('Failed to create birthday card');
      }

      await sock.sendMessage(msg.key.remoteJid, {
        image: { url: data.data.url },
        caption: `🎂 Happy Birthday ${name}! 🎉`
      });

    } catch (error) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: `❌ Error: ${error.message}`
      });
    }
  }, { aliases: ['bday'], description: 'Create birthday card' });
}

// ==================== SELECTION HANDLER ====================

export async function handleSelection(sock, msg) {
  const userId = msg.key.participant || msg.key.remoteJid;
  const search = activeSearches.get(userId);

  if (!search) return false;

  const text = msg.message?.conversation || 
               msg.message?.extendedTextMessage?.text || '';
  
  const selection = parseInt(text.trim());

  if (isNaN(selection) || selection < 1) return false;

  try {
    switch (search.type) {
      case 'youtube-search':
        if (selection > search.results.length) {
          await sock.sendMessage(msg.key.remoteJid, {
            text: '❌ Invalid selection. Please choose a number from the list.'
          });
          return true;
        }

        const video = search.results[selection - 1];
        activeSearches.delete(userId);

        await sock.sendMessage(msg.key.remoteJid, {
          text: `✅ Selected: *${video.title}*\n\nUse: .yt ${video.url}`
        });
        return true;

      case 'youtube':
        if (selection > 3) return false;

        await sock.sendMessage(msg.key.remoteJid, {
          text: '⏬ Starting download...\nThis may take a few minutes.'
        });

        const quality = selection === 1 ? 'high' : selection === 2 ? 'medium' : 'audio';
        const downloadData = await apiRequest('/dl/youtube', {
          url: search.url,
          quality: quality
        });

        if (!downloadData.success || !downloadData.data.downloadUrl) {
          throw new Error('Download link not available');
        }

        const fileSize = await getFileSize(downloadData.data.downloadUrl);
        
        if (fileSize > MAX_FILE_SIZE) {
          await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ File is too large (${formatSize(fileSize)})\n\n📥 Direct Link:\n${downloadData.data.downloadUrl}`
          });
        } else {
          const ext = quality === 'audio' ? '.mp3' : '.mp4';
          const filename = `${Date.now()}${ext}`;
          const filepath = await downloadFile(downloadData.data.downloadUrl, filename);

          await sendLargeFile(
            sock,
            msg.key.remoteJid,
            filepath,
            `🎵 ${search.data.title}`,
            quality === 'audio' ? 'audio/mpeg' : 'video/mp4'
          );
        }

        activeSearches.delete(userId);
        return true;

      case 'movie-search':
      case 'baiscope-search':
      case 'tv-search':
        if (selection > search.results.length) {
          await sock.sendMessage(msg.key.remoteJid, {
            text: '❌ Invalid selection'
          });
          return true;
        }

        const selected = search.results[selection - 1];
        await sock.sendMessage(msg.key.remoteJid, {
          text: `✅ Selected: *${selected.title}*\n\nFetching download links...`
        });

        // Here you would call the appropriate API endpoint
        // For now, showing the info
        await sock.sendMessage(msg.key.remoteJid, {
          text: `🎬 *${selected.title}*\n\nUse the specific URL command with the item URL to download.`
        });

        activeSearches.delete(userId);
        return true;

      case 'sisubsearch':
        if (selection > search.results.length) return false;

        const subItem = search.results[selection - 1];
        await sock.sendMessage(msg.key.remoteJid, {
          text: `✅ Selected: *${subItem.title}*\n\n${subItem.url || 'URL not available'}`
        });

        activeSearches.delete(userId);
        return true;
    }
  } catch (error) {
    await sock.sendMessage(msg.key.remoteJid, {
      text: `❌ Error: ${error.message}`
    });
    activeSearches.delete(userId);
  }

  return false;
}

// ==================== REGISTER ALL COMMANDS ====================

export function registerAllDownloaderCommands(handler) {
  registerYouTubeCommands(handler);
  registerMovieCommands(handler);
  registerTVCommands(handler);
  registerBaiscopeCommands(handler);
  registerSinhalaSubCommands(handler);
  registerMediaCommands(handler);
}