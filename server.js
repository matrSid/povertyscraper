const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const wait = ms => new Promise(r => setTimeout(r, ms));

/* -------------------------------------------------------
   Fetch text (m3u8, vtt, srt, etc.) *using Puppeteer itself*
   to avoid Cloudflare ECONNRESET
-------------------------------------------------------- */
async function puppeteerFetch(page, url) {
  try {
    return await page.evaluate(async (targetUrl) => {
      try {
        const res = await fetch(targetUrl, {
          method: "GET",
          headers: {
            "User-Agent": navigator.userAgent
          }
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
   Main extraction logic
-------------------------------------------------------- */
async function extractStreamWithPuppeteer(targetUrl, opts = {}) {
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: execPath || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage'
    ],
    ignoreHTTPSErrors: true
  });

  let page = null;

  try {
    page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
    );

    const found = new Set();

    /* Capture network requests */
    page.on('request', req => {
      try {
        const u = req.url();
        if (/\.(m3u8|mp4|vtt|srt|ttml|dfxp)(\?|$)/i.test(u)) found.add(u);
      } catch (e) {}
    });

    /* Capture responses */
    page.on('response', async resp => {
      try {
        const u = resp.url();
        const headers = resp.headers?.() || {};
        const ct = (headers['content-type'] || '').toLowerCase();

        if (/\.(m3u8|mp4|vtt|srt|ttml|dfxp)(\?|$)/i.test(u)) found.add(u);
        if (ct.includes('mpegurl') || ct.includes('vtt') || ct.includes('subrip') || ct.includes('ttml') || ct.includes('dfxp'))
          found.add(u);

      } catch (e) {}
    });

    /* Load page */
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await wait(opts.waitAfterLoad || 2500);

    /* Extract video / track elements */
    try {
      const urls = await page.evaluate(() => {
        const list = [];
        document.querySelectorAll('video, video source').forEach(el => {
          if (el.src) list.push(el.src);
          const attr = el.getAttribute?.('src');
          if (attr) list.push(attr);
        });

        document.querySelectorAll('track').forEach(t => {
          if (t.src) list.push(t.src);
          const attr = t.getAttribute?.('src');
          if (attr) list.push(attr);
        });

        return list;
      });

      urls.forEach(u => { if (u) found.add(u); });
    } catch (e) {}

    /* Performance entries */
    try {
      const perf = await page.evaluate(() => performance.getEntries().map(e => e.name));
      perf.forEach(u => {
        if (/\.(m3u8|mp4|vtt|srt|ttml|dfxp)(\?|$)/i.test(u)) found.add(u);
      });
    } catch (e) {}

    /* -------------------------------------------------------
       Fetch m3u8 *via Puppeteer* to avoid ECONNRESET
    -------------------------------------------------------- */
    const before = Array.from(found);

    for (const u of before) {
      if (!/\.m3u8(\?|$)/i.test(u)) continue;

      const text = await puppeteerFetch(page, u);
      if (!text) continue;

      // Parse embedded subtitle URLs
      const quoted = /URI="([^"']+\.(vtt|srt|m3u8|ttml|dfxp)[^"']*)"/gi;
      let m;
      while ((m = quoted.exec(text)) !== null) {
        try { found.add(new URL(m[1], u).toString()); }
        catch { found.add(m[1]); }
      }

      const media = /#EXT-X-MEDIA:[^\n]*TYPE=SUBTITLES[^\n]*URI="([^"']+)"/gi;
      while ((m = media.exec(text)) !== null) {
        try { found.add(new URL(m[1], u).toString()); }
        catch { found.add(m[1]); }
      }

      const plain = /https?:\/\/[^\s"']+\.(vtt|srt|m3u8|ttml|dfxp)(\?[^\s"'<>]*)?/gi;
      let pm;
      while ((pm = plain.exec(text)) !== null) found.add(pm[0]);
    }

    await browser.close();
    return Array.from(found);

  } catch (err) {
    try { if (browser) await browser.close(); } catch(e){}
    throw err;
  }
}

/* -------------------------------------------------------
   Categorize URLs
-------------------------------------------------------- */
function categorizeUrls(urls) {
  const m3u8 = [];
  const mp4 = [];
  const subtitles = [];

  urls.forEach(url => {
    if (/\.m3u8(\?|$)/i.test(url)) m3u8.push(url);
    else if (/\.mp4(\?|$)/i.test(url)) mp4.push(url);
    else if (/\.(vtt|srt|ttml|dfxp)(\?|$)/i.test(url)) subtitles.push(url);
  });

  return { m3u8, mp4, subtitles };
}

/* -------------------------------------------------------
   API ENDPOINTS
-------------------------------------------------------- */

/* Movies */
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

/* TV Shows */
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

/* Generic extractor */
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

/* Health check */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/* Start server */
const port = process.env.PORT || 9000;
app.listen(port, () => {
  console.log(`Vidrock Stream API running on port ${port}`);
});
