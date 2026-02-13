const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium-browser';
const PORT = process.env.PORT || 9000;

const app = express();
app.use(express.json());
app.use(cors({ origin: '*', methods: 'GET,POST', allowedHeaders: 'Content-Type' }));

const wait = ms => new Promise(r => setTimeout(r, ms));

let browserInstance = null;
let lastUsed = Date.now();
const BROWSER_TIMEOUT = 5 * 60 * 1000;

setInterval(() => {
  if (browserInstance && Date.now() - lastUsed > BROWSER_TIMEOUT) {
    browserInstance.close().catch(() => {});
    browserInstance = null;
    console.log('🔄 Browser closed due to inactivity');
  }
}, 60000);

async function getBrowser() {
  lastUsed = Date.now();

  if (browserInstance) {
    try {
      await browserInstance.version();
      return browserInstance;
    } catch {
      browserInstance = null;
    }
  }

  browserInstance = await puppeteer.launch({

    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions'
    ],
    ignoreHTTPSErrors: true,
    defaultViewport: { width: 1280, height: 720 }
  });

  return browserInstance;
}

async function puppeteerFetch(page, url) {
  try {
    return await page.evaluate(async (targetUrl) => {
      try {
        const res = await fetch(targetUrl, { method: "GET", headers: { "User-Agent": navigator.userAgent } });
        if (!res.ok) return null;
        return await res.text();
      } catch (e) {
        return null;
      }
    }, url);
  } catch (e) {
    return null;
  }
}

async function extractStreamWithPuppeteer(targetUrl, opts = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      const url = req.url();
      if (/\.(m3u8|mp4|vtt|srt|ttml|dfxp)(\?|$)/i.test(url)) {
        found.add(url);
      }
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36');

    const found = new Set();

    page.on('response', async resp => {
      try {
        const u = resp.url();
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (/\.(m3u8|mp4|vtt|srt|ttml|dfxp)(\?|$)/i.test(u)) found.add(u);
        if (ct.includes('mpegurl') || ct.includes('vtt') || ct.includes('subrip') || ct.includes('ttml') || ct.includes('dfxp')) {
          found.add(u);
        }
      } catch (e) {}
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await wait(opts.waitAfterLoad || 1500);

    try {
      const urls = await page.evaluate(() => {
        const list = [];
        document.querySelectorAll('video, video source, track').forEach(el => {
          const src = el.src || el.getAttribute?.('src');
          if (src) list.push(src);
        });
        return list;
      });
      urls.forEach(u => { if (u) found.add(u); });
    } catch (e) {}

    try {
      const perf = await page.evaluate(() => performance.getEntries().map(e => e.name));
      perf.forEach(u => {
        if (/\.(m3u8|mp4|vtt|srt|ttml|dfxp)(\?|$)/i.test(u)) found.add(u);
      });
    } catch (e) {}

    const m3u8Urls = Array.from(found).filter(u => /\.m3u8(\?|$)/i.test(u));

    await Promise.all(
      m3u8Urls.map(async (u) => {
        const text = await puppeteerFetch(page, u);
        if (!text) return;
        const uriPattern = /URI="([^"']+\.(vtt|srt|m3u8|ttml|dfxp)[^"']*)"/gi;
        const mediaPattern = /#EXT-X-MEDIA:[^\n]*TYPE=SUBTITLES[^\n]*URI="([^"']+)"/gi;
        const plainPattern = /https?:\/\/[^\s"']+\.(vtt|srt|m3u8|ttml|dfxp)(\?[^\s"'<>]*)?/gi;
        let m;
        while ((m = uriPattern.exec(text)) !== null) {
          try { found.add(new URL(m[1], u).toString()); } catch { found.add(m[1]); }
        }
        while ((m = mediaPattern.exec(text)) !== null) {
          try { found.add(new URL(m[1], u).toString()); } catch { found.add(m[1]); }
        }
        while ((m = plainPattern.exec(text)) !== null) {
          found.add(m[0]);
        }
      })
    );

    await page.close();
    return Array.from(found);

  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

function categorizeUrls(urls) {
  const m3u8 = [];
  const mp4 = [];
  const subtitles = [];
  for (const url of urls) {
    if (url.includes('.m3u8')) m3u8.push(url);
    else if (url.includes('.mp4')) mp4.push(url);
    else if (/\.(vtt|srt|ttml|dfxp)(\?|$)/i.test(url)) subtitles.push(url);
  }
  return { m3u8, mp4, subtitles };
}

app.get('/api/movie/:imdbId', async (req, res) => {
  const { imdbId } = req.params;
  const url = `https://vidrock.net/movie/${imdbId}`;
  try {
    const urls = await extractStreamWithPuppeteer(url);
    const cat = categorizeUrls(urls);
    res.json({ success: true, type: 'movie', imdbId, stream: cat.m3u8[0] || cat.mp4[0] || null, streams: { m3u8: cat.m3u8, mp4: cat.mp4 }, subtitles: cat.subtitles, allUrls: urls });
  } catch (e) {
    console.error('Movie extraction error:', e);
    res.status(500).json({ success: false, error: 'Failed to extract stream', details: e.message });
  }
});

app.get('/api/tv/:imdbId/:season/:episode', async (req, res) => {
  const { imdbId, season, episode } = req.params;
  const url = `https://vidrock.net/tv/${imdbId}/${season}/${episode}`;
  try {
    const urls = await extractStreamWithPuppeteer(url);
    const cat = categorizeUrls(urls);
    res.json({ success: true, type: 'tv', imdbId, season: Number(season), episode: Number(episode), stream: cat.m3u8[0] || cat.mp4[0] || null, streams: { m3u8: cat.m3u8, mp4: cat.mp4 }, subtitles: cat.subtitles, allUrls: urls });
  } catch (e) {
    console.error('TV extraction error:', e);
    res.status(500).json({ success: false, error: 'Failed to extract stream', details: e.message });
  }
});

app.get('/api/extract', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ success: false, error: 'url query parameter required' });
  try {
    const urls = await extractStreamWithPuppeteer(url);
    const cat = categorizeUrls(urls);
    res.json({ success: true, url, stream: cat.m3u8[0] || cat.mp4[0] || null, streams: { m3u8: cat.m3u8, mp4: cat.mp4 }, subtitles: cat.subtitles, allUrls: urls });
  } catch (e) {
    console.error('Extraction error:', e);
    res.status(500).json({ success: false, error: 'Failed to extract stream', details: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing browser...');
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`⚡ Vidrock Stream API running on port ${PORT}`);
});
