#!/usr/bin/env node
/**
 * Visual / typographic regression harness for the Minute Papillons site.
 *
 * Captures, for every page x viewport width: the computed styles of a set of
 * representative elements, the web fonts actually loaded, failed network
 * requests, and a full-page screenshot. Then compares two snapshots.
 *
 * Usage:
 *   node scripts/check-visual.mjs --mode baseline --base <URL> --dir .visual-baseline
 *   node scripts/check-visual.mjs --mode compare  --base <URL> --dir .visual-baseline
 *
 * Options:
 *   --base   <url>       site root, e.g. http://127.0.0.1:8080/ (required)
 *   --dir    <path>      baseline directory (default .visual-baseline)
 *   --out    <path>      where compare mode writes the current run
 *                        (default: <dir>/../visual-current)
 *   --widths <csv>       viewport widths (default 375,768,1280)
 *   --pages  <csv>       page paths, "/"-prefixed (default: all pages below)
 *   --only   <substr>    keep pages whose path contains substr (debug)
 *   --no-shots           skip screenshots (styles-only run, much faster)
 *   --max-diff <pct>     tolerated pixel noise, in % of the image (default 0.1)
 *
 * Requirements: puppeteer-core (no Chromium download) and a Chrome/Chromium
 * binary. On this box the Playwright cache works:
 *   npm i --no-save puppeteer-core
 *   CHROME_BIN=~/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell \
 *     node scripts/check-visual.mjs --mode baseline --base http://127.0.0.1:8080/
 *
 * Exit code: 0 = identical / baseline written, 1 = differences found.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const PAGES = [
  '/', '/la-petite-histoire/', '/louez-moi/', '/trouver-nos-cabines/',
  '/on-parle-de-votre-projet/', '/questions-frequentes/',
  '/acheter-le-kit/', '/agenda/',
  '/en/', '/en/the-little-history/', '/en/louez-moi/', '/en/trouver-nos-cabines/',
  '/en/on-parle-de-votre-projet/', '/en/questions-frequentes/',
  '/en/acheter-le-kit/', '/en/agenda/',
];

// Elements whose computed style must not drift during the refactor.
const PROBES = ['h1', 'h2', 'p', 'strong', 'nav a', 'main img', 'footer', 'footer a'];
const PROPS = [
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'color', 'textTransform', 'marginTop', 'marginBottom', 'paddingTop', 'width',
];
// Absolute tolerance (px) for numeric styles: sub-pixel layout noise.
const TOL = 0.5;

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : (process.argv[i + 1] ?? true);
}
const has = (name) => process.argv.includes(`--${name}`);

// --- minimal PNG decode (8-bit RGB/RGBA, all filter types) -----------------
function decodePng(buf) {
  let i = 8, idat = [], w, h, ct;
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    i += 12 + len;
  }
  let bpp = null;
  if (ct === 6) bpp = 4;
  else if (ct === 2) bpp = 3;
  if (!bpp) throw new Error(`unsupported PNG colour type ${ct}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride), pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    const line = Buffer.from(raw.subarray(pos, pos + stride)); pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255;
      else if (f === 2) line[x] = (line[x] + b) & 255;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        let pred;
        if (pa <= pb && pa <= pc) pred = a;
        else if (pb <= pc) pred = b;
        else pred = c;
        line[x] = (line[x] + pred) & 255;
      }
    }
    line.copy(out, y * stride); prev = line;
  }
  return { w, h, bpp, pixels: out };
}

function pixelDiff(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { sizeMismatch: [a.w + 'x' + a.h, b.w + 'x' + b.h] };
  let n = 0;
  for (let i = 0; i < a.pixels.length; i += a.bpp) {
    if (a.pixels[i] !== b.pixels[i] || a.pixels[i + 1] !== b.pixels[i + 1] || a.pixels[i + 2] !== b.pixels[i + 2]) n++;
  }
  return { differing: n, total: a.w * a.h, pct: +(100 * n / (a.w * a.h)).toFixed(3) };
}

// --- browser ---------------------------------------------------------------
function chromePath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cands = [
    path.join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell'),
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ];
  const found = cands.find(existsSync);
  if (!found) throw new Error('no Chrome binary: set CHROME_BIN');
  return found;
}

async function loadPuppeteer() {
  try { return (await import('puppeteer-core')).default; }
  catch {
    throw new Error('puppeteer-core is missing: run `npm i --no-save puppeteer-core`');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chromium refuses fullPage captures beyond ~16k px (and dies sooner under
// memory pressure). Cap the capture height and record the fact.
const MAX_SHOT_H = Number(process.env.MAX_SHOT_H || 4000);

async function capture(page, shotPath) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  const height = Math.min(h, MAX_SHOT_H);
  // `fullPage: true` intermittently fails ("Unable to capture screenshot") on
  // this headless_shell build for long pages; an explicit clip with
  // captureBeyondViewport is reliable. Always use it.
  const opts = {
    path: shotPath,
    clip: { x: 0, y: 0, width: page.viewport().width, height },
    captureBeyondViewport: true,
  };
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.screenshot(opts);
      return { height, pageHeight: h, truncated: height < h };
    } catch (e) {
      lastErr = e.message;
      await sleep(500);
    }
  }
  return { error: lastErr, pageHeight: h };
}

async function probe(page, url) {
  const failed = [];
  page.on('requestfailed', (r) => failed.push(r.url()));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  // Make captures deterministic: force lazy images to load by scrolling
  // through the page, wait for them, then freeze animations/transitions.
  try {
    await page.evaluate(async () => {
      const step = Math.max(200, window.innerHeight);
      const height = () => document.documentElement.scrollHeight;
      for (let y = 0; y < height(); y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 40));
      }
      for (const img of document.images) img.loading = 'eager';
      window.scrollTo(0, 0);
      await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => {
        img.addEventListener('load', r, { once: true });
        img.addEventListener('error', r, { once: true });
      }))));
      await Promise.all([...document.images].map((img) => (img.decode ? img.decode().catch(() => {}) : null)));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
    await page.evaluate(() => document.fonts.ready);
  } catch { /* best effort: never fail the probe for settling */ }
  const data = await page.evaluate((PROBES, PROPS) => {
    // Visible text only: innerText would force a reflow, so clone the body
    // without script/style/noscript and read textContent.
    const visibleText = () => {
      const clone = document.body.cloneNode(true);
      for (const el of clone.querySelectorAll('script,style,noscript,template')) el.remove();
      return (clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    };
    const styles = {};
    for (const sel of PROBES) {
      const el = document.querySelector(sel);
      if (!el) { styles[sel] = null; continue; }
      const cs = getComputedStyle(el);
      const o = {};
      for (const p of PROPS) o[p] = cs[p];
      styles[sel] = o;
    }
    return {
      title: document.title,
      fontsLoaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family}:${f.weight}:${f.style}`),
      styles,
      h1Text: (document.querySelector('h1')?.textContent || '').trim(),
      bodyText: visibleText(),
    };
  }, PROBES, PROPS);
  return { ...data, failed: [...new Set(failed)] };
}

function compareProbe(base, cur) {
  const diffs = [];
  if (base.title !== cur.title) diffs.push(`title: ${JSON.stringify(base.title)} -> ${JSON.stringify(cur.title)}`);
  if (base.h1Text !== cur.h1Text) diffs.push(`h1 text: ${JSON.stringify(base.h1Text)} -> ${JSON.stringify(cur.h1Text)}`);
  if (base.bodyText !== cur.bodyText) diffs.push('body text differs');
  const bf = [...base.fontsLoaded].sort().join(','), cf = [...cur.fontsLoaded].sort().join(',');
  if (bf !== cf) diffs.push(`fonts: [${bf}] -> [${cf}]`);
  for (const k of new Set([...cur.failed, ...base.failed])) {
    if (!base.failed.includes(k) && cur.failed.includes(k)) diffs.push(`new failing request: ${k}`);
  }
  for (const sel of PROBES) {
    const a = base.styles[sel], b = cur.styles[sel];
    if (!a && !b) continue;
    if (!a || !b) { diffs.push(`${sel}: element ${a ? 'disappeared' : 'appeared'}`); continue; }
    for (const p of Object.keys(b)) {
      const pa = a[p], pb = b[p];
      if (pa === pb) continue;
      const na = parseFloat(pa), nb = parseFloat(pb);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && Math.abs(na - nb) <= TOL && (pa.endsWith('px') || pa === String(na))) continue;
      diffs.push(`${sel}.${p}: ${JSON.stringify(pa)} -> ${JSON.stringify(pb)}`);
    }
  }
  return diffs;
}

// --- main ------------------------------------------------------------------
const MODE = arg('mode');
const BASE = (arg('base') || '').replace(/\/+$/, '');
const DIR = arg('dir', '.visual-baseline');
const OUT = arg('out', null) || path.join(path.dirname(path.resolve(DIR)), 'visual-current');
const WIDTHS = String(arg('widths', '375,768,1280')).split(',').map(Number);
const ONLY = arg('only');
let pages = String(arg('pages', PAGES.join(','))).split(',');
if (ONLY) pages = pages.filter((p) => p.includes(ONLY));
const shots = !has('no-shots');
const MAX_DIFF = Number(arg('max-diff', '0.1'));

if (!['baseline', 'compare'].includes(MODE)) { console.error('--mode baseline|compare is required'); process.exit(2); }
if (!BASE) { console.error('--base is required'); process.exit(2); }

const puppeteer = await loadPuppeteer();
const browser = await puppeteer.launch({
  executablePath: chromePath(),
  // Do not let a wedged renderer hold the run for the 180 s default.
  protocolTimeout: 20000,
  // memory guards: this harness has OOM-killed a co-located service once
  // (3.8 GB box, no swap) — keep one renderer and a small JS heap.
  args: [
    // NB: no --disable-dev-shm-usage: it redirects Chromium shared memory to
    // /tmp, which is a RAM-backed tmpfs on this host — a big screenshot then
    // dies with ENOSPC and takes the renderer down.
    '--no-sandbox', '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--js-flags=--max-old-space-size=256',
  ],
});

const failures = [];
let checked = 0;
let consecutiveErrors = 0;
let abortReason = null;
try {
  for (const pagePath of pages) {
    if (abortReason) break;
    const url = BASE + pagePath;
    const slug = pagePath === '/' ? 'index' : pagePath.replace(/^\/|\/$/g, '').replace(/\//g, '__');
    await mkdir(path.join(DIR, slug), { recursive: true });
    for (const width of WIDTHS) {
      const id = `${slug}@${width}`;
      const baseShotPath = path.join(DIR, slug, `${width}.png`);
      const shotPath = MODE === 'baseline' ? baseShotPath : path.join(OUT, slug, `${width}.png`);
      if (MODE === 'compare') await mkdir(path.join(OUT, slug), { recursive: true });
      let cur;
      // Chromium occasionally drops a page (attach/screenshot flake) on this
      // memory-constrained box: one retry with a fresh page.
      for (let attempt = 0; attempt < 2; attempt++) {
        let page, probeErr;
        try {
          page = await browser.newPage();
          await page.setViewport({ width, height: 900 });
          cur = await probe(page, url);
          if (shots) cur.shot = await capture(page, shotPath);
        } catch (e) {
          probeErr = e.message;
        }
        if (page) { try { await page.close(); } catch { /* page already gone */ } }
        if (!probeErr) break;
        cur = { error: probeErr };
        console.warn(`retry ${id}: ${probeErr}`);
        await sleep(750);
      }

      // Fail fast: a dead base URL otherwise makes every page retry twice and
      // a stuck Chromium can burn 30+ minutes holding hundreds of MB.
      consecutiveErrors = cur.error ? consecutiveErrors + 1 : 0;
      if (consecutiveErrors >= 2) {
        abortReason = `${consecutiveErrors} consecutive page failures — is ${BASE} up? last: ${cur.error}`;
        break;
      }

      if (MODE === 'baseline') {
        await writeFile(path.join(DIR, slug, `${width}.json`), JSON.stringify(cur, null, 1));
        checked++;
        console.log(`baseline ${id}${cur.error ? ' ERROR ' + cur.error : ''}`);
        continue;
      }
      // compare
      const refPath = path.join(DIR, slug, `${width}.json`);
      if (!existsSync(refPath)) { failures.push(`${id}: no baseline`); continue; }
      const base = JSON.parse(await readFile(refPath, 'utf8'));
      if (MODE === 'compare') await writeFile(path.join(OUT, slug, `${width}.json`), JSON.stringify(cur, null, 1));
      const diffs = cur.error ? [cur.error] : compareProbe(base, cur);
      if (cur.shot?.error) diffs.push(`screenshot failed: ${cur.shot.error}`);
      if (shots && !cur.shot?.error && existsSync(shotPath) && existsSync(baseShotPath)) {
        {
          const pd = pixelDiff(decodePng(await readFile(baseShotPath)), decodePng(await readFile(shotPath)));
          if (pd.sizeMismatch) diffs.push(`screenshot size ${pd.sizeMismatch[0]} -> ${pd.sizeMismatch[1]}`);
          else if (pd.differing && pd.pct > MAX_DIFF) diffs.push(`screenshot: ${pd.pct}% pixels differ (${pd.differing}/${pd.total}) > ${MAX_DIFF}% tolerance`);
          else if (pd.differing) console.log(`note ${id}: pixel noise ${pd.pct}% (<= ${MAX_DIFF}%)`);
        }
      }
      checked++;
      if (diffs.length) { failures.push(`${id}:\n    ` + diffs.slice(0, 12).join('\n    ')); console.log(`DIFF ${id} (${diffs.length})`); }
      else console.log(`ok   ${id}`);
      await sleep(50);
    }
  }
} finally {
  try { await browser.close(); } catch { /* browser already gone */ }
}

if (abortReason) {
  console.error(`\nAborted: ${abortReason}`);
  process.exit(3);
}

if (MODE === 'baseline') {
  console.log(`\nbaseline written: ${checked} page/width combos -> ${DIR}`);
  process.exit(0);
}
if (failures.length) {
  console.log(`\n${failures.length} page/width combos differ:\n`);
  console.log(failures.join('\n'));
  process.exit(1);
}
console.log(`\n${checked} page/width combos identical (styles within ${TOL}px).`);
