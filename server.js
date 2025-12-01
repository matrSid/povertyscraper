const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const wait = ms => new Promise(r => setTimeout(r, ms));
const nodeFetch = (...args) => import('node-fetch').then(m => m.default(...args)).catch(() => null);

async function extractStreamWithPuppeteer(targetUrl, opts = {}) {
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();
  
  
  const browser = await puppeteer.launch({
  headless: true,
  executablePath: execPath || undefined,
  args: [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--single-process'
  ],
  ignoreHTTPSErrors: true
  });
  
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36');
    
    const found = new Set();
    
    // Capture requests
    page.on('request', req => {
      try {
        const u = req.url();
        if (/\.(m3u8|mp4|vtt|srt|ttml|dfxp)(\?|$)/i.test(u)) found.add(u);
      } catch(e){}
    });
    
    // Capture responses
    page.on('response', async resp => {
      try {
        const u = resp.url();
        const ct = (resp.headers && resp.headers()['content-type']) || '';
        
        if (/\.(m3u8|mp4|vtt|srt|ttml|dfxp)(\?|$)/i.test(u)) found.add(u);
        if (ct.includes('application/vnd.apple.mpegurl') || ct.includes('vnd.apple.mpegurl') || ct.toLowerCase().includes('application/x-mpegurl')) found.add(u);
        if (ct.toLowerCase().includes('text/vtt') || ct.toLowerCase().includes('application/vtt') || ct.toLowerCase().includes('subrip') || ct.toLowerCase().includes('ttml') || ct.toLowerCase().includes('dfxp')) found.add(u);
        
        // Parse m3u8 content for embedded subtitle URLs
        if (/\.m3u8(\?|$)/i.test(u) || ct.toLowerCase().includes('mpegurl')) {
          try {
            const text = await resp.text();
            const regexQuoted = /URI="([^"']+\.(?:vtt|srt|m3u8|ttml|dfxp)[^"']*)"/gi;
            let m;
            while ((m = regexQuoted.exec(text)) !== null) {
              try { found.add(new URL(m[1], u).toString()); } catch(e) { found.add(m[1]); }
            }
            const regexMedia = /#EXT-X-MEDIA:[^\n]*TYPE=SUBTITLES[^\n]*URI="([^"']+)"/gi;
            while ((m = regexMedia.exec(text)) !== null) {
              try { found.add(new URL(m[1], u).toString()); } catch(e) { found.add(m[1]); }
            }
            const regexPlain = /https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4|vtt|srt|ttml|dfxp)(?:\?[^\s"'<>]*)?/gi;
            let pm;
            while ((pm = regexPlain.exec(text)) !== null) found.add(pm[0]);
          } catch (e){}
        }
      } catch (e){}
    });
    
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await wait(opts.waitAfterLoad || 2000);
    
    // Extract from video elements
    try {
      const videoSrcs = await page.evaluate(() => {
        const urls = [];
        document.querySelectorAll('video, video source').forEach(el => {
          if (el.src) urls.push(el.src);
          if (el.getAttribute && el.getAttribute('src')) urls.push(el.getAttribute('src'));
        });
        document.querySelectorAll('track').forEach(t => {
          if (t.src) urls.push(t.src);
          if (t.getAttribute && t.getAttribute('src')) urls.push(t.getAttribute('src'));
        });
        try {
          for (const k in window) {
            try {
              const v = window[k];
              if (!v) continue;
              if (typeof v === 'object' && JSON.stringify(v).length < 200000) {
                const s = JSON.stringify(v);
                const m = s.match(/https?:\/\/[^"']+?(?:\.(m3u8|mp4|vtt|srt|ttml|dfxp))(?:\?[^"']*)?/i);
                if (m) urls.push(m[0]);
              } else if (typeof v === 'string') {
                const m2 = v.match(/https?:\/\/[^"']+?(?:\.(m3u8|mp4|vtt|srt|ttml|dfxp))(?:\?[^"']*)?/i);
                if (m2) urls.push(m2[0]);
              }
            } catch(e){}
          }
        } catch(e){}
        return urls;
      });
      videoSrcs.forEach(u => { if (u) found.add(u); });
    } catch (e){}
    
    // Check performance entries
    try {
      const perf = await page.evaluate(() => (performance.getEntries() || []).map(e => e.name).filter(Boolean));
      perf.forEach(u => { if (u && /\.(m3u8|mp4|vtt|srt|ttml|dfxp)(\?|$)/i.test(u)) found.add(u); });
    } catch(e){}
    
    await browser.close();
    
    // Fetch m3u8 files to extract additional subtitle references
    const arrBefore = Array.from(found);
    for (const u of arrBefore) {
      try {
        if (/\.m3u8(\?|$)/i.test(u)) {
          const f = await nodeFetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (f && f.ok) {
            const text = await f.text();
            const regexQuoted = /URI="([^"']+\.(?:vtt|srt|m3u8|ttml|dfxp)[^"']*)"/gi;
            let m;
            while ((m = regexQuoted.exec(text)) !== null) {
              try { found.add(new URL(m[1], u).toString()); } catch(e) { found.add(m[1]); }
            }
            const regexMedia = /#EXT-X-MEDIA:[^\n]*TYPE=SUBTITLES[^\n]*URI="([^"']+)"/gi;
            while ((m = regexMedia.exec(text)) !== null) {
              try { found.add(new URL(m[1], u).toString()); } catch(e) { found.add(m[1]); }
            }
            const regexPlain = /https?:\/\/[^\s"']+\.(?:vtt|srt|ttml|dfxp|m3u8)(?:\?[^\s"'<>]*)?/gi;
            let pm;
            while ((pm = regexPlain.exec(text)) !== null) found.add(pm[0]);
          }
        }
      } catch(e){}
    }
    
    return Array.from(found);
  } catch (err) {
    try { await browser.close(); } catch(e){}
    throw err;
  }
}

function categorizeUrls(urls) {
  const m3u8 = [];
  const mp4 = [];
  const subtitles = [];
  
  urls.forEach(url => {
    if (/\.m3u8(\?|$)/i.test(url)) {
      m3u8.push(url);
    } else if (/\.mp4(\?|$)/i.test(url)) {
      mp4.push(url);
    } else if (/\.(vtt|srt|ttml|dfxp)(\?|$)/i.test(url)) {
      subtitles.push(url);
    }
  });
  
  return { m3u8, mp4, subtitles };
}

// API endpoint for movies: /api/movie/:imdbId
app.get('/api/movie/:imdbId', async (req, res) => {
  const { imdbId } = req.params;
  const vidrockUrl = `https://vidrock.net/movie/${imdbId}`;
  
  try {
    const urls = await extractStreamWithPuppeteer(vidrockUrl, { waitAfterLoad: 2500 });
    const categorized = categorizeUrls(urls);
    
    res.json({
      success: true,
      type: 'movie',
      imdbId,
      stream: categorized.m3u8[0] || categorized.mp4[0] || null,
      streams: {
        m3u8: categorized.m3u8,
        mp4: categorized.mp4
      },
      subtitles: categorized.subtitles,
      allUrls: urls
    });
  } catch (e) {
    console.error('Movie extraction error:', e);
    res.status(500).json({
      success: false,
      error: 'Failed to extract stream',
      details: e.message
    });
  }
});

// API endpoint for TV shows: /api/tv/:imdbId/:season/:episode
app.get('/api/tv/:imdbId/:season/:episode', async (req, res) => {
  const { imdbId, season, episode } = req.params;
  const vidrockUrl = `https://vidrock.net/tv/${imdbId}/${season}/${episode}`;
  
  try {
    const urls = await extractStreamWithPuppeteer(vidrockUrl, { waitAfterLoad: 2500 });
    const categorized = categorizeUrls(urls);
    
    res.json({
      success: true,
      type: 'tv',
      imdbId,
      season: parseInt(season),
      episode: parseInt(episode),
      stream: categorized.m3u8[0] || categorized.mp4[0] || null,
      streams: {
        m3u8: categorized.m3u8,
        mp4: categorized.mp4
      },
      subtitles: categorized.subtitles,
      allUrls: urls
    });
  } catch (e) {
    console.error('TV extraction error:', e);
    res.status(500).json({
      success: false,
      error: 'Failed to extract stream',
      details: e.message
    });
  }
});

// Generic endpoint if you want to pass full URL
app.get('/api/extract', async (req, res) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'url query parameter required'
    });
  }
  
  try {
    const urls = await extractStreamWithPuppeteer(url, { waitAfterLoad: 2500 });
    const categorized = categorizeUrls(urls);
    
    res.json({
      success: true,
      url,
      stream: categorized.m3u8[0] || categorized.mp4[0] || null,
      streams: {
        m3u8: categorized.m3u8,
        mp4: categorized.mp4
      },
      subtitles: categorized.subtitles,
      allUrls: urls
    });
  } catch (e) {
    console.error('Extraction error:', e);
    res.status(500).json({
      success: false,
      error: 'Failed to extract stream',
      details: e.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const port = process.env.PORT || 9000;
app.listen(port, () => {
  console.log(`Vidrock Stream API listening on port ${port}`);
  console.log(`
Available endpoints:
  - GET /api/movie/:imdbId
  - GET /api/tv/:imdbId/:season/:episode
  - GET /api/extract?url=<vidrock_url>
  - GET /health

Examples:
  - http://localhost:${port}/api/movie/533535
  - http://localhost:${port}/api/tv/94997/5/1
  - http://localhost:${port}/api/extract?url=https://vidrock.net/movie/533535
  `);
});