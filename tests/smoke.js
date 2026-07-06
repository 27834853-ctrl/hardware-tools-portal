/**
 * Automated regression smoke test (CommonJS for max compatibility).
 *
 * Runs Playwright headless Chromium against the repo's main HTML.
 * Fails CI if:
 *   - Page fails to load
 *   - Any console error (except favicon 404 / ServiceWorker on file://)
 *   - Any CSP violation
 *   - Any SRI failure (blocked resource)
 *   - Main calculator button (if detected) throws on click
 *
 * Usage:  node tests/smoke.js [path/to/main.html]
 */
'use strict';
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const targetArg = process.argv[2] || 'index.html';
  const targetPath = path.resolve(process.cwd(), targetArg);
  if (!fs.existsSync(targetPath)) {
    console.error('FAIL: ' + targetPath + ' does not exist');
    process.exit(1);
  }
  const targetUrl = pathToFileURL(targetPath).href;
  console.log('Testing: ' + targetUrl);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const cspViolations = [];
  const sriFailures = [];
  const requestFailures = [];

  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // Filter well-known file:// noise (safe when serving from HTTP too)
    if (/favicon|ServiceWorker|net::ERR_FILE_NOT_FOUND/.test(text)) return;
    if (/Content Security Policy/i.test(text)) { cspViolations.push(text); return; }
    if (/integrity|Subresource Integrity/i.test(text)) { sriFailures.push(text); return; }
    consoleErrors.push(text);
  });
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('requestfailed', r => {
    if (r.url().startsWith('http')) requestFailures.push({ url: r.url(), reason: (r.failure() || {}).errorText });
  });

  try {
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(2500);
  } catch (e) {
    pageErrors.push('[goto] ' + e.message);
  }

  const clickResult = await page.evaluate(() => {
    const btns = document.querySelectorAll(
      'button.btn-primary, button[class*="primary"], button[onclick*="calc" i], button[onclick*="generate" i]'
    );
    for (const b of btns) {
      const rect = b.getBoundingClientRect();
      if (rect.width > 0 && !b.disabled) {
        try { b.click(); return { clicked: b.textContent.trim().slice(0, 40) }; }
        catch (e) { return { clicked: 'error: ' + e.message }; }
      }
    }
    return { clicked: null };
  });
  if (clickResult.clicked) {
    await page.waitForTimeout(1500);
    console.log('Interaction: clicked "' + clickResult.clicked + '"');
  }

  const summary = {
    consoleErrors: consoleErrors.length,
    pageErrors: pageErrors.length,
    cspViolations: cspViolations.length,
    sriFailures: sriFailures.length,
    requestFailures: requestFailures.length,
  };
  const failed = summary.consoleErrors + summary.pageErrors + summary.cspViolations + summary.sriFailures + summary.requestFailures;

  console.log('\n===== Smoke test summary =====');
  for (const [k, v] of Object.entries(summary)) console.log('  ' + k.padEnd(20) + ': ' + v);

  if (failed > 0) {
    console.log('\n===== Errors detected =====');
    cspViolations.forEach(e => console.log('  [CSP] ' + e.slice(0, 300)));
    sriFailures.forEach(e => console.log('  [SRI] ' + e.slice(0, 300)));
    requestFailures.forEach(e => console.log('  [REQ] ' + e.url + ' - ' + e.reason));
    pageErrors.forEach(e => console.log('  [ERR] ' + e.slice(0, 300)));
    consoleErrors.forEach(e => console.log('  [CON] ' + e.slice(0, 300)));
    try { await page.screenshot({ path: 'smoke-failure.png', fullPage: false }); console.log('  Screenshot: smoke-failure.png'); } catch (e) {}
  }
  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
})();
