const chromium = require('@sparticuz/chromium-min');
const puppeteer = require('puppeteer-core');

const SITE_URL = 'https://aleksandarkrst.github.io/lower-back-assessment/';
const CHROMIUM_PACK_URL = process.env.CHROMIUM_PACK_URL;
const R_PATTERN = /^[A-Za-z0-9+/=]{1,4000}$/;

module.exports = async (req, res) => {
  const r = req.query.r;
  if (!r || typeof r !== 'string' || !R_PATTERN.test(r)) {
    res.status(400).json({ error: 'Missing or malformed r parameter' });
    return;
  }
  try {
    JSON.parse(decodeURIComponent(Buffer.from(r, 'base64').toString('utf8')));
  } catch (e) {
    res.status(400).json({ error: 'Malformed report payload' });
    return;
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 900, height: 1200 },
      executablePath: await chromium.executablePath(CHROMIUM_PACK_URL),
      headless: chromium.headless,
    });
    const page = await browser.newPage();

    // ck.js is a non-deferred, parser-blocking <script> on the email step,
    // which stays in the DOM (just hidden) even on the report screen. It's
    // never needed to render the report itself, so abort it to keep a slow
    // or unavailable third-party CDN off the critical path for every PDF.
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      request.resourceType() === 'script' && request.url().includes('convertkit.com')
        ? request.abort()
        : request.continue();
    });

    const url = `${SITE_URL}?pdf=1&r=${encodeURIComponent(r)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // renderReport() runs synchronously once hydrateFromURL() succeeds, so
    // this resolves almost immediately for a valid payload. hydrateFromURL()
    // fails silently (falls back to the intro screen) on a malformed r, so
    // this explicit wait turns that into a clean error instead of a PDF of
    // the intro screen.
    try {
      await page.waitForSelector('[data-step="report"]', { timeout: 5000 });
    } catch (e) {
      res.status(400).json({ error: 'Could not render a report for this payload' });
      return;
    }

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', bottom: '20mm', left: '16mm', right: '16mm' },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="low-back-assessment-report.pdf"');
    // Output is a pure function of r (see renderReport()/encodeReportPayload()
    // in index.html) - safe to cache aggressively so repeat clicks on the
    // same emailed link don't re-render.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.status(200).send(pdf);
  } catch (e) {
    console.error('report-pdf error:', e);
    res.status(500).json({ error: 'Could not generate report PDF' });
  } finally {
    if (browser) await browser.close();
  }
};
