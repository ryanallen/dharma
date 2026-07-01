// glossary.js
// ---------------------------------------------------------------------------
// Shared bottom-sheet glossary behaviour for the web reading views (the root
// README reader in reader.js and the /docs site in docs.js).
//
// A "glossary link" is any in-page link whose target file is the glossary
// (its basename is GLOSSARY_FILE) and that carries a "#anchor" — for example
// `[karma](../../GLOSSARY.md#karma)`. Clicking one slides the matching entry up
// in a sheet over the reading view instead of navigating away, so the doc
// underneath keeps its scroll position. Links inside the sheet that point at
// other glossary terms swap the entry in place; any other link dismisses the
// sheet first and hands the navigation back to the host.
//
// The host owns its own click handling, so this module does NOT register a
// document-wide listener. It returns `handleClick(event)`: call it first in the
// host's content click handler and bail out when it returns true.
// ---------------------------------------------------------------------------

import { slugify } from './slugger.js';
import { stripToText } from './markdown.js';

// The on-disk convention is GLOSSARY.md (like README.md). This is the
// comparison key only; the basename is lowercased before comparing, so a
// link to GLOSSARY.md or a legacy glossary.md both match.
const GLOSSARY_FILE = 'glossary.md';

// ---------------------------------------------------------------------------
// Lightweight glossary index
//
// The glossary is one enormous Markdown file (tens of thousands of `## Term`
// entries, multiple megabytes). Rendering the whole thing in the browser just
// to show one entry — or to harvest the term list — is what makes the sheet
// "never open" on a phone: parsing a multi-megabyte HTML string into a
// ~200k-node DOM blows past mobile Safari's memory ceiling.
//
// Instead we fetch the raw text once and scan it into a compact index: for each
// heading, its level, the SAME slug the renderer would assign (built with the
// shared `stripToText` + `slugify` and one dedupe counter across all headings,
// in document order, skipping fenced code — mirroring markdown.js), the plain
// term text, and the line where the heading sits. From that we can slice a
// single entry's source and render only those few lines, and list the terms
// without rendering anything.
// ---------------------------------------------------------------------------

// ATX heading, matched exactly as markdown.js does (up to 3 leading spaces,
// optional trailing #'s). Group 1 = the #'s, group 2 = the heading text.
const GLOSSARY_HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const GLOSSARY_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

function buildGlossaryIndex(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const slugOcc = Object.create(null);
  const headings = []; // { level, slug, term, line }
  const bySlug = new Map();
  let inFence = false;
  let fenceCh = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = line.match(GLOSSARY_FENCE_RE);
    if (fm) {
      if (!inFence) {
        inFence = true;
        fenceCh = fm[1][0];
      } else if (line.trim()[0] === fenceCh) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const h = line.match(GLOSSARY_HEADING_RE);
    if (!h) continue;
    const term = stripToText(h[2]);
    const slug = slugify(term, slugOcc);
    const entry = { level: h[1].length, slug, term, line: i };
    headings.push(entry);
    if (!bySlug.has(slug)) bySlug.set(slug, headings.length - 1);
  }
  return { lines, headings, bySlug };
}

// The Markdown source for a single entry: from its heading line up to (but not
// including) the next heading of the same or higher level — the same span the
// old DOM-walking extractEntry captured, but sliced from raw text.
function sliceGlossaryEntry(index, anchor) {
  const at = index.bySlug.get(anchor);
  if (at === undefined) return null;
  const start = index.headings[at];
  let endLine = index.lines.length;
  for (let j = at + 1; j < index.headings.length; j++) {
    if (index.headings[j].level <= start.level) {
      endLine = index.headings[j].line;
      break;
    }
  }
  return index.lines.slice(start.line, endLine).join('\n');
}

// Fetch + index each glossary URL at most once; shared by the sheet and the
// auto-linker so the multi-megabyte file is downloaded and scanned a single time.
const glossaryIndexCache = new Map(); // url -> Promise<{lines, headings, bySlug}>
function loadGlossaryIndex(url) {
  let promise = glossaryIndexCache.get(url);
  if (!promise) {
    promise = (async () => {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return buildGlossaryIndex(await res.text());
    })();
    // Don't cache a failure — a transient error shouldn't poison the session.
    promise.catch(() => glossaryIndexCache.delete(url));
    glossaryIndexCache.set(url, promise);
  }
  return promise;
}

function isMarkdownGlossaryUrl(url) {
  return /\.md(?:[?#]|$)/i.test(url);
}

function decodeAnchor(raw) {
  try {
    return decodeURIComponent(raw);
  } catch (e) {
    return raw;
  }
}

// Split an href into [pathBeforeHash, anchor], dropping any ?query.
function splitHref(href) {
  const hashAt = href.indexOf('#');
  const path = (hashAt >= 0 ? href.slice(0, hashAt) : href).split('?')[0];
  const anchor = hashAt >= 0 ? href.slice(hashAt + 1) : '';
  return [path, decodeAnchor(anchor)];
}

function basename(path) {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1].toLowerCase();
}

// The glossary anchor a link points to, or '' when it is not a glossary link.
function glossaryAnchor(href) {
  if (!href) return '';
  // Preferred form: a fake `glossary:slug` URL with no file path, so it works at
  // any folder depth. The sheet always loads from the configured glossaryUrl.
  const scheme = /^glossary:(.*)$/i.exec(href);
  if (scheme) return decodeAnchor(scheme[1].replace(/^#/, ''));
  if (/^[a-z]+:\/\//i.test(href) || href.startsWith('mailto:')) return '';
  // Real form: a `…/GLOSSARY.md#slug` relative link (what /check expands the
  // shorthand into; also a working link in plain Markdown viewers).
  const [path, anchor] = splitHref(href);
  if (!anchor) return '';
  if (basename(path) !== GLOSSARY_FILE) return '';
  return anchor;
}

function headingLevel(el) {
  const match = /^H([1-6])$/.exec(el.tagName);
  return match ? Number(match[1]) : 0;
}

// Pull one entry out of the rendered glossary: the heading whose id is `anchor`
// plus every following sibling up to the next heading of the same or higher
// level. Returns a DocumentFragment, or null when the anchor is not found.
function extractEntry(root, anchor) {
  const start = Array.from(root.querySelectorAll('[id]')).find((el) => el.id === anchor);
  if (!start) return null;
  const level = headingLevel(start) || 6;
  const frag = document.createDocumentFragment();
  frag.appendChild(start.cloneNode(true));
  let node = start.nextElementSibling;
  while (node) {
    const lvl = headingLevel(node);
    if (lvl && lvl <= level) break;
    frag.appendChild(node.cloneNode(true));
    node = node.nextElementSibling;
  }
  return frag;
}

// Wire up the glossary sheet for one reading view.
//   glossaryUrl    where to fetch the glossary Markdown from (fetched once, lazily)
//   renderMarkdown the shared Markdown -> HTML renderer
//   onNavigate     optional; called with an href when a non-glossary link inside
//                  the sheet is followed, so the host can route to it
export function installGlossary({ glossaryUrl, renderMarkdown, onNavigate }) {
  let loadPromise = null;
  let sheet = null;
  let backdrop = null;
  let bodyEl = null;
  let lastFocus = null;

  // Fallback only: render the WHOLE glossary into a detached DOM. Used for a
  // non-Markdown (.xml) glossary, or the rare case where the index does not
  // contain a requested slug. The fast path (slicing one entry) avoids this.
  function loadGlossaryFull() {
    if (!loadPromise) {
      loadPromise = (async () => {
        const res = await fetch(glossaryUrl, { cache: 'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const root = document.createElement('div');
        root.innerHTML = renderMarkdown(await res.text());
        return root;
      })();
    }
    return loadPromise;
  }

  function onKey(event) {
    if (event.key === 'Escape') dismiss();
  }

  function ensureSheet() {
    if (sheet) return;

    backdrop = document.createElement('div');
    backdrop.className = 'glossary-backdrop';
    backdrop.hidden = true;
    backdrop.addEventListener('click', dismiss);

    sheet = document.createElement('aside');
    sheet.className = 'glossary-sheet';
    sheet.hidden = true;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Glossary');
    sheet.innerHTML =
      '<div class="glossary-sheet-grip"></div>' +
      '<button type="button" class="glossary-sheet-close" aria-label="Close glossary">' +
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true">' +
      '<path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />' +
      '</svg></button>' +
      '<div class="glossary-sheet-body document-body"></div>' +
      '<div class="glossary-sheet-footer">' +
      '<a class="glossary-sheet-fulllink" href="#">Open the full glossary</a>' +
      '</div>';

    bodyEl = sheet.querySelector('.glossary-sheet-body');
    sheet.querySelector('.glossary-sheet-close').addEventListener('click', dismiss);
    bodyEl.addEventListener('click', onSheetClick);
    sheet.querySelector('.glossary-sheet-fulllink').addEventListener('click', (event) => {
      event.preventDefault();
      dismiss();
      if (onNavigate) onNavigate(glossaryUrl);
      else window.location.assign(glossaryUrl);
    });

    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);
  }

  // Clicks inside the sheet: another glossary term (or a bare "#anchor", which
  // can only mean another entry within this glossary) swaps the entry in place;
  // anything else leaves the glossary and is handed to the host.
  function onSheetClick(event) {
    const link = event.target.closest('a');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || /^[a-z]+:\/\//i.test(href) || href.startsWith('mailto:')) return;
    event.preventDefault();
    const within = glossaryAnchor(href) || (href.startsWith('#') ? decodeAnchor(href.slice(1)) : '');
    if (within) {
      open(within);
      return;
    }
    dismiss();
    if (onNavigate) onNavigate(href);
    else window.location.assign(href);
  }

  function show() {
    ensureSheet();
    lastFocus = document.activeElement;
    backdrop.hidden = false;
    sheet.hidden = false;
    requestAnimationFrame(() => {
      backdrop.classList.add('open');
      sheet.classList.add('open');
    });
    document.addEventListener('keydown', onKey);
    sheet.querySelector('.glossary-sheet-close').focus();
  }

  function dismiss() {
    if (!sheet || sheet.hidden) return;
    backdrop.classList.remove('open');
    sheet.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    const hide = () => {
      sheet.hidden = true;
      backdrop.hidden = true;
      sheet.removeEventListener('transitionend', hide);
    };
    sheet.addEventListener('transitionend', hide);
    setTimeout(hide, 320); // fallback when the transition does not fire
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  async function open(anchor) {
    show();
    bodyEl.innerHTML = '<p class="glossary-sheet-status">Loading…</p>';
    try {
      // Fast path: slice just this entry from the raw glossary and render only
      // those few lines — no multi-megabyte render, so the sheet opens instantly
      // even on a phone.
      if (isMarkdownGlossaryUrl(glossaryUrl)) {
        const index = await loadGlossaryIndex(glossaryUrl);
        const src = sliceGlossaryEntry(index, anchor);
        if (src !== null) {
          bodyEl.innerHTML = renderMarkdown(src);
          bodyEl.scrollTop = 0;
          return;
        }
      }
      // Fallback: a non-Markdown glossary, or a slug the index did not produce —
      // render the whole file once and pluck the entry out of the DOM.
      const root = await loadGlossaryFull();
      const entry = extractEntry(root, anchor);
      bodyEl.innerHTML = '';
      if (entry) bodyEl.appendChild(entry);
      else bodyEl.innerHTML = '<p class="glossary-sheet-status">No glossary entry for “' + anchor + '”.</p>';
      bodyEl.scrollTop = 0;
    } catch (err) {
      bodyEl.innerHTML =
        '<p class="glossary-sheet-status">Could not load the glossary (' + err.message + ').</p>';
    }
  }

  return {
    // Call first in the host's content click handler. Returns true when the
    // click was a glossary link (and was handled), false otherwise.
    handleClick(event) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return false;
      }
      const link = event.target.closest('a');
      if (!link) return false;
      const anchor = glossaryAnchor(link.getAttribute('href'));
      if (!anchor) return false;
      event.preventDefault();
      open(anchor);
      return true;
    },
    open,
    dismiss,
  };
}

// ---------------------------------------------------------------------------
// Dynamic auto-glossary linking
//
// After the document content is rendered, call this to asynchronously fetch
// the glossary (GLOSSARY.md or GLOSSARY.xml / glossary.xml) and wrap every
// occurrence of each glossary term in the content with a `glossary:slug` link.
//
// Terms from ## (h2) headings are used. Matching is whole-word, case-insensitive.
// Text inside existing <a>, <code>, and <pre> elements is skipped.
//
// Usage:
//   installAutoGlossary({ contentEl, renderMarkdown, renderTEI })
//
// Returns a promise that resolves when linking is done (or quietly fails).
// ---------------------------------------------------------------------------

const SKIP_TAGS = new Set(['a', 'code', 'pre', 'script', 'style', 'head']);

// Compiled {pattern, termMap} per glossary URL, so repeated renders (the docs
// viewer swaps pages without reloading) reuse one fetch + one compile.
const autoGlossaryCache = new Map();

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collect all text nodes in `root` that are not inside skipped elements.
 * @param {Element} root
 * @returns {Text[]}
 */
function collectTextNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    (node) => {
      let el = node.parentElement;
      while (el && el !== root) {
        if (SKIP_TAGS.has(el.tagName.toLowerCase())) return NodeFilter.FILTER_REJECT;
        el = el.parentElement;
      }
      return node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  );
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  return nodes;
}

/**
 * Replace term occurrences in a single text node with glossary links.
 * @param {Text} textNode
 * @param {RegExp} pattern   — built from all terms
 * @param {Map<string, string>} termMap — term.toLowerCase() → slug
 */
function linkTextNode(textNode, pattern, termMap) {
  const text = textNode.textContent;
  pattern.lastIndex = 0;
  if (!pattern.test(text)) return;
  pattern.lastIndex = 0;

  const frag = document.createDocumentFragment();
  let last = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      frag.appendChild(document.createTextNode(text.slice(last, match.index)));
    }
    const slug = termMap.get(match[0].toLowerCase());
    if (slug) {
      const a = document.createElement('a');
      a.href = 'glossary:' + slug;
      a.textContent = match[0];
      frag.appendChild(a);
    } else {
      frag.appendChild(document.createTextNode(match[0]));
    }
    last = match.index + match[0].length;
  }

  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  textNode.parentNode.replaceChild(frag, textNode);
}

/**
 * Extract glossary terms from rendered glossary HTML.
 * Returns [{term, slug}], longest terms first.
 * @param {string} html  — rendered HTML string
 * @returns {{term: string, slug: string}[]}
 */
function extractTerms(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  const terms = [];
  for (const h of div.querySelectorAll('h2[id]')) {
    const term = h.textContent.trim();
    if (term) terms.push({ term, slug: h.id });
  }
  // longest first so multi-word terms match before their substrings
  terms.sort((a, b) => b.term.length - a.term.length);
  return terms;
}

/**
 * Get the glossary term list, longest term first, trying each candidate URL in
 * order (first that exists wins). A Markdown glossary is read straight from the
 * shared raw-text index — no rendering — so the huge file is never turned into a
 * DOM just to list its terms. A `.xml` glossary still renders through the TEI
 * path (those files are small).
 * @returns {Promise<{term: string, slug: string}[]>}
 */
async function glossaryTermsFor(candidates, renderMarkdown, renderTEI) {
  for (const name of candidates) {
    if (isMarkdownGlossaryUrl(name)) {
      let index;
      try {
        index = await loadGlossaryIndex(name);
      } catch {
        continue;
      }
      const terms = index.headings
        .filter((h) => h.level === 2 && h.term)
        .map((h) => ({ term: h.term, slug: h.slug }));
      terms.sort((a, b) => b.term.length - a.term.length);
      return terms;
    }
    let res;
    try {
      res = await fetch(name, { cache: 'no-cache' });
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const text = await res.text();
    const html = name.endsWith('.xml') && renderTEI ? renderTEI(text) : renderMarkdown(text);
    return extractTerms(html);
  }
  return [];
}

/**
 * Asynchronously scan `contentEl` and wrap every glossary term with a
 * `glossary:slug` link. Safe to call; silently no-ops when no glossary found.
 *
 * @param {object} opts
 * @param {Element} opts.contentEl     — the rendered document element
 * @param {Function} opts.renderMarkdown
 * @param {Function} [opts.renderTEI]  — optional; used for .xml glossary files
 * @param {string|string[]} [opts.glossaryUrl]  — where to fetch the glossary from;
 *        a single URL or a list tried in order (first that exists wins). Needed when
 *        the page is not next to the glossary (e.g. /docs uses ../GLOSSARY.*). Defaults
 *        to trying GLOSSARY.md / GLOSSARY.xml / glossary.xml next to the page.
 */
export async function installAutoGlossary({ contentEl, renderMarkdown, renderTEI, glossaryUrl }) {
  const candidates = glossaryUrl
    ? Array.isArray(glossaryUrl)
      ? glossaryUrl
      : [glossaryUrl]
    : ['GLOSSARY.md', 'GLOSSARY.xml', 'glossary.xml'];

  // Build (or reuse) the compiled term pattern for this glossary URL. The
  // glossary is large (hundreds of entries) and the docs viewer re-renders on
  // every navigation, so caching avoids re-fetching and re-compiling each time.
  const cacheKey = candidates.join('|');
  let compiled = autoGlossaryCache.get(cacheKey);
  if (!compiled) {
    let terms;
    try {
      terms = await glossaryTermsFor(candidates, renderMarkdown, renderTEI || null);
    } catch {
      return;
    }
    if (!terms.length) return;

    // Build a single regex from all terms (whole-word boundaries)
    const pattern = new RegExp(
      '(?<![\\p{L}\\p{M}\\d])(' +
        terms.map((t) => escapeRegex(t.term)).join('|') +
        ')(?![\\p{L}\\p{M}\\d])',
      'giu'
    );

    // Map lowercase term → slug for O(1) lookup during replacement
    const termMap = new Map(terms.map((t) => [t.term.toLowerCase(), t.slug]));
    compiled = { pattern, termMap };
    autoGlossaryCache.set(cacheKey, compiled);
  }
  const { pattern, termMap } = compiled;

  // Collect text nodes first (modifying the DOM during traversal is unsafe)
  const textNodes = collectTextNodes(contentEl);

  // Process in small async batches so we don't block the UI thread
  const BATCH = 50;
  for (let i = 0; i < textNodes.length; i += BATCH) {
    const batch = textNodes.slice(i, i + BATCH);
    for (const node of batch) {
      if (node.parentNode) linkTextNode(node, pattern, termMap);
    }
    // Yield to the browser between batches
    await new Promise((r) => setTimeout(r, 0));
  }
}
