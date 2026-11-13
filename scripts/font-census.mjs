#!/usr/bin/env node
/**
 * Font census for the Minute Papillons site (bead org-6i7.4).
 *
 * Answers, per page: which font FAMILIES are actually USED to lay out visible
 * text (not merely declared and loaded), how many glyphs each family renders,
 * and which elements render inside the "extra" families we want to retire
 * (Inter, Cardo, "giant-boys" from useanyfont, GIANT BOYS INNER/SHADOW).
 *
 * `document.fonts` only tells us what the browser *loaded*: a family matched
 * by a single inherited rule gets loaded and would look "used" even if every
 * glyph falls back visually. So we go one level deeper: for every element with
 * rendered text we take the computed font-family stack and the first family in
 * that stack that is actually available, then attribute the element's text
 * length to it. A family wins only if it accounts for real rendered text.
 *
 * Usage:
 *   node scripts/font-census.mjs --base http://127.0.0.1:8101/ [--json out.json]
 *
 * Requires: puppeteer-core + a Chrome/Chromium binary (CHROME_BIN).
 */
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const PAGES = [
  '/', '/220-2/', '/louez-moi/', '/trouver-nos-cabines/',
  '/on-parle-de-votre-projet/', '/questions-frequentes/',
  '/acheter-le-kit/', '/agenda/',
  '/en/', '/en/220-2/', '/en/louez-moi/', '/en/trouver-nos-cabines/',
  '/en/on-parle-de-votre-projet/', '/en/questions-frequentes/',
  '/en/acheter-le-kit/', '/en/agenda/',
];

const arg = (name, def = undefined) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : (process.argv[i + 1] ?? true);
};

const BASE = arg('base');
const ONLY = arg('only');
const JSON_OUT = arg('json');
const WIDTH = Number(arg('width', 1280));
if (!BASE) { console.error('--base is required (e.g. http://127.0.0.1:8101/)'); process.exit(2); }

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
const puppeteer = (await import('puppeteer-core')).default;

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  args: [
    '--no-sandbox', '--hide-scrollbars', '--force-color-profile=srgb',
    '--js-flags=--max-old-space-size=256',
  ],
});

let pages = PAGES;
if (ONLY) pages = pages.filter((p) => p.includes(ONLY));

const result = [];
try {
  for (const p of pages) {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: WIDTH, height: 900 });
      await page.goto(BASE + p, { waitUntil: 'networkidle0', timeout: 45000 });
      await page.evaluate(() => document.fonts.ready);

      const data = await page.evaluate(() => {
        // Families the page declares (whether or not rendered).
        const declared = [...document.fonts].map((f) => f.family.replace(/^["']|["']$/g, ''));

        // Which of our @font-face families has the browser actually resolved?
        // We bias toward families declared by the page, then fall back to a
        // generic probe for system families.
        const familyAvailable = (fam) => {
          if (declared.some((d) => d.toLowerCase() === fam.toLowerCase())) return true;
          // generic/system: assume available for the common ones
          return ['serif', 'sans-serif', 'system-ui', 'monospace', 'cursive', 'fantasy'].includes(fam.toLowerCase());
        };

        // Attribute rendered text to a family.
        const usage = {};      // family -> {chars, elements}
        const offenders = {};  // family -> [ {selector, sample, count} ]
        const stacks = {};     // full computed stack -> count (documents cascade)

        const describe = (el) => {
          const cls = (el.className && typeof el.className === 'string')
            ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
          return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
        };

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const text = node.nodeValue;
          if (!text || !text.trim()) continue;
          const el = node.parentElement;
          if (!el) continue;
          // skip non-rendered text
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
          if (!el.getClientRects().length) continue;

          const stack = cs.fontFamily;
          const fams = stack.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
          const chosen = fams.find(familyAvailable) || fams[fams.length - 1];
          stacks[stack] = (stacks[stack] || 0) + 1;
          const n = text.trim().length;
          usage[chosen] = usage[chosen] || { chars: 0, elements: 0 };
          usage[chosen].chars += n;
          usage[chosen].elements += 1;

          (offenders[chosen] = offenders[chosen] || []);
          const list = offenders[chosen];
          const sel = describe(el);
          const found = list.find((o) => o.selector === sel);
          if (found) { found.count += 1; found.chars += n; }
          else list.push({ selector: sel, sample: text.trim().slice(0, 60), count: 1, chars: n });
        }

        // Also check form controls + ::before/::after content, which carry text
        // but are not text nodes.
        const controls = [];
        for (const el of document.querySelectorAll('button, input, select, textarea, figcaption, a')) {
          const cs = getComputedStyle(el);
          const txt = (el.value || el.textContent || '').trim();
          if (!txt) continue;
          if (!el.getClientRects().length) continue;
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const stack = cs.fontFamily;
          const fams = stack.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
          const chosen = fams.find(familyAvailable) || fams[fams.length - 1];
          controls.push({ selector: describe(el), family: chosen, sample: txt.slice(0, 40) });
        }

        // ::before / ::after generated text (e.g. the arrow-link bullet).
        const pseudo = [];
        for (const el of document.querySelectorAll('*')) {
          for (const which of ['::before', '::after']) {
            const cs = getComputedStyle(el, which);
            const c = cs.content;
            if (c && c !== 'none' && c !== 'normal' && /["']/.test(c)) {
              const strip = c.replace(/^["']|["']$/g, '').trim();
              if (!strip) continue;
              const stack = cs.fontFamily;
              const fams = stack.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
              const chosen = fams.find(familyAvailable) || fams[fams.length - 1];
              pseudo.push({ selector: describe(el) + which, family: chosen, sample: strip.slice(0, 40) });
            }
          }
        }

        return {
          title: document.title,
          declaredFamilies: [...new Set(declared)].sort(),
          loadedFamilies: [...new Set([...document.fonts]
            .filter((f) => f.status === 'loaded')
            .map((f) => f.family.replace(/^["']|["']$/g, '')))].sort(),
          usage, offenders, stacks,
          controls, pseudo,
        };
      });

      const rendered = Object.entries(data.usage)
        .sort((a, b) => b[1].chars - a[1].chars)
        .map(([fam, u]) => `${fam}(${u.chars}c/${u.elements}e)`);
      console.log(`\n=== ${p}  "${data.title}"`);
      console.log(`  loaded:   ${data.loadedFamilies.join(', ') || '(none)'}`);
      console.log(`  rendered: ${rendered.join('  ')}`);
      const extra = Object.keys(data.usage).filter((f) => /^(Inter|Cardo|giant-boys|GIANT BOYS INNER|GIANT BOYS SHADOW)$/i.test(f));
      if (extra.length) {
        for (const f of extra) {
          console.log(`  !! RENDERED IN CANDIDATE-REMOVAL FAMILY "${f}":`);
          for (const o of data.offenders[f].slice(0, 6)) {
            console.log(`       ${o.selector}  x${o.count} (${o.chars}c)  "${o.sample}"`);
          }
        }
      }
      if (data.pseudo.length) {
        console.log(`  generated text (::before/::after):`);
        for (const g of data.pseudo.slice(0, 6)) console.log(`       ${g.selector} [${g.family}] "${g.sample}"`);
      }
      const ctrlFams = [...new Set(data.controls.map((c) => c.family))];
      if (ctrlFams.length) console.log(`  form/link families: ${ctrlFams.join(', ')}`);

      result.push({ page: p, ...data });
    } catch (e) {
      console.log(`\n=== ${p}  ERROR ${e.message}`);
      result.push({ page: p, error: e.message });
    } finally {
      try { await page.close(); } catch { /* gone */ }
    }
  }
} finally {
  await browser.close();
}

// Global summary across pages.
const totalChars = {};
const pagesUsing = {};
for (const r of result) {
  if (r.error) continue;
  for (const [fam, u] of Object.entries(r.usage || {})) {
    totalChars[fam] = (totalChars[fam] || 0) + u.chars;
    (pagesUsing[fam] = pagesUsing[fam] || new Set()).add(r.page);
  }
}
console.log('\n\n========== GLOBAL CENSUS ==========');
console.log(`pages analysed: ${result.filter((r) => !r.error).length}/${result.length}`);
for (const [fam, chars] of Object.entries(totalChars).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(chars).padStart(7)} chars   ${String(pagesUsing[fam].size).padStart(2)}/16 pages   ${fam}`);
}
const cand = ['Inter', 'Cardo', 'giant-boys', 'GIANT BOYS INNER', 'GIANT BOYS SHADOW'];
console.log('\nremoval candidates:');
for (const c of cand) {
  const f = Object.keys(totalChars).find((k) => k.toLowerCase() === c.toLowerCase());
  console.log(`  ${c.padEnd(20)} ${f ? `USED (${totalChars[f]} chars) — DO NOT REMOVE` : 'unused — removable'}`);
}

if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify(result, null, 1));
  console.log(`\njson -> ${JSON_OUT}`);
}
