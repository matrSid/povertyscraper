const express = require('express');
const puppeteer = require('puppeteer');
const puppeteerCore = require('puppeteer-core');
const chromium = require('chrome-aws-lambda');

const app = express();
app.use(express.json());
const cors = require('cors');
app.use(cors({
  origin: '*',
  methods: 'GET,POST',
  allowedHeaders: 'Content-Type',
}));

const wait = ms => new Promise(r => setTimeout(r, ms));

/* -------------------------------------------------------
   BROWSER POOLING - reuse browser instances
-------------------------------------------------------- */
let browserInstance = null;
let lastUsed = Date.now();
const BROWSER_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Close browser if idle for too long
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
      // Test if browser is still alive
      await browserInstance.version();
      return browserInstance;
    } catch {
      browserInstance = null;
    }
  }

  if (process.env.NODE_ENV === 'production') {
    const execPath = await chromium.executablePath;
    browserInstance = await puppeteerCore.launch({
      args: chromium.args.concat([
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions'
      ]),
      defaultViewport: chromium.defaultViewport,
      executablePath: execPath || undefined,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
  } else {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-software-rasterizer',
        '--disable-extensions'
      ],
      ignoreHTTPSErrors: true,
    });
  }

  return browserInstance;
}

async function puppeteerFetch(page, url) {
  try {
    return await page.evaluate(async (targetUrl) => {
      try {
        const res = await fetch(targetUrl, {
          method: "GET",
          headers: { "User-Agent": navigator.userAgent }
        });
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

/* -------------------------------------------------------
   OPTIMIZED extraction logic
-------------------------------------------------------- */
async function extractStreamWithPuppeteer(targetUrl, opts = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Block unnecessary resources for SPEED
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      const url = req.url();
      
      // Capture media URLs
      if (/\.(m3u8|mp4|vtt|srt|ttml|dfxp)(\?|$)/i.test(url)) {
        found.add(url);
      }
      
      // Block heavy resources
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
    );

    const found = new Set();

    // Capture responses
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

    // Load page with REDUCED timeout and faster waitUntil
    await page.goto(targetUrl, { 
      waitUntil: 'domcontentloaded', // Changed from 'networkidle2' - MUCH faster
      timeout: 30000 // Reduced from 60000
    }).catch(() => {});
    
    // Reduced wait time
    await wait(opts.waitAfterLoad || 1500); // Reduced from 2500

    // Extract video/track elements
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

    // Performance entries
    try {
      const perf = await page.evaluate(() => performance.getEntries().map(e => e.name));
      perf.forEach(u => {
        if (/\.(m3u8|mp4|vtt|srt|ttml|dfxp)(\?|$)/i.test(u)) found.add(u);
      });
    } catch (e) {}

    // Fetch m3u8 and parse for subtitles - but only if found
    const m3u8Urls = Array.from(found).filter(u => /\.m3u8(\?|$)/i.test(u));

    // Process m3u8s in PARALLEL for speed
    await Promise.all(
      m3u8Urls.map(async (u) => {
        const text = await puppeteerFetch(page, u);
        if (!text) return;

        // Combined regex for efficiency
        const uriPattern = /URI="([^"']+\.(vtt|srt|m3u8|ttml|dfxp)[^"']*)"/gi;
        const mediaPattern = /#EXT-X-MEDIA:[^\n]*TYPE=SUBTITLES[^\n]*URI="([^"']+)"/gi;
        const plainPattern = /https?:\/\/[^\s"']+\.(vtt|srt|m3u8|ttml|dfxp)(\?[^\s"'<>]*)?/gi;

        let m;
        while ((m = uriPattern.exec(text)) !== null) {
          try { found.add(new URL(m[1], u).toString()); }
          catch { found.add(m[1]); }
        }

        while ((m = mediaPattern.exec(text)) !== null) {
          try { found.add(new URL(m[1], u).toString()); }
          catch { found.add(m[1]); }
        }

        while ((m = plainPattern.exec(text)) !== null) {
          found.add(m[0]);
        }
      })
    );

    await page.close(); // Close page, keep browser alive

    return Array.from(found);

  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

/* -------------------------------------------------------
   Categorize URLs - OPTIMIZED
-------------------------------------------------------- */
function categorizeUrls(urls) {
  const m3u8 = [];
  const mp4 = [];
  const subtitles = [];

  // Single pass through array
  for (const url of urls) {
    if (url.includes('.m3u8')) m3u8.push(url);
    else if (url.includes('.mp4')) mp4.push(url);
    else if (/\.(vtt|srt|ttml|dfxp)(\?|$)/i.test(url)) subtitles.push(url);
  }

  return { m3u8, mp4, subtitles };
}

/* -------------------------------------------------------
   API ENDPOINTS
-------------------------------------------------------- */

app.get('/api/movie/:imdbId', async (req, res) => {
  const { imdbId } = req.params;
  const url = `https://vidrock.net/movie/${imdbId}`;

  try {
    const urls = await extractStreamWithPuppeteer(url);
    const cat = categorizeUrls(urls);

    res.json({
      success: true,
      type: 'movie',
      imdbId,
      stream: cat.m3u8[0] || cat.mp4[0] || null,
      streams: { m3u8: cat.m3u8, mp4: cat.mp4 },
      subtitles: cat.subtitles,
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

app.get('/api/tv/:imdbId/:season/:episode', async (req, res) => {
  const { imdbId, season, episode } = req.params;
  const url = `https://vidrock.net/tv/${imdbId}/${season}/${episode}`;

  try {
    const urls = await extractStreamWithPuppeteer(url);
    const cat = categorizeUrls(urls);

    res.json({
      success: true,
      type: 'tv',
      imdbId,
      season: Number(season),
      episode: Number(episode),
      stream: cat.m3u8[0] || cat.mp4[0] || null,
      streams: { m3u8: cat.m3u8, mp4: cat.mp4 },
      subtitles: cat.subtitles,
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

app.get('/api/extract', async (req, res) => {
  const { url } = req.query;

  if (!url)
    return res.status(400).json({ success: false, error: 'url query parameter required' });

  try {
    const urls = await extractStreamWithPuppeteer(url);
    const cat = categorizeUrls(urls);

    res.json({
      success: true,
      url,
      stream: cat.m3u8[0] || cat.mp4[0] || null,
      streams: { m3u8: cat.m3u8, mp4: cat.mp4 },
      subtitles: cat.subtitles,
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing browser...');
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});

const port = process.env.PORT || 9000;
app.listen(port, () => {
  console.log(`⚡ Vidrock Stream API running on port ${port}`);
});