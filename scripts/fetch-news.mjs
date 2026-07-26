// Henter siste AI-nyheter fra offisielle, gratis kilder (RSS/HTML) - ingen API-nøkler,
// ingen betalte kall. Tittel/sammendrag beholdes på engelsk fra kilden (ingen oversettelse).
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPDATES_DIR = join(__dirname, "..", "src", "content", "updates");
const MAX_AGE_DAYS = 7;
const MAX_PER_SOURCE = 5;

const MONTHS = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function decodeEntities(str) {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .trim();
}

function stripTags(str) {
  // Decode entities first - some feeds (e.g. Google's) HTML-encode tags like
  // "&lt;img ...&gt;" inside <description>, so they only become literal "<img>"
  // after decoding and must be stripped afterwards.
  const decoded = decodeEntities(str);
  return decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function withinAgeWindow(dateIso) {
  const ageMs = Date.now() - new Date(dateIso).getTime();
  return ageMs >= 0 && ageMs <= MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "ai-nyheter-fetch-news/1.0 (+https://github.com)" },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

// --- RSS-baserte kilder (OpenAI, Google) ---

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRe.exec(xml))) {
    const block = match[1];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const description = extractTag(block, "description");
    const pubDate = extractTag(block, "pubDate");
    if (!title || !link || !pubDate) continue;
    const date = new Date(pubDate);
    if (Number.isNaN(date.getTime())) continue;
    items.push({
      title: stripTags(title),
      url: link.trim(),
      summary: stripTags(description || "").slice(0, 500),
      date: date.toISOString().slice(0, 10),
    });
  }
  return items;
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const m = block.match(re);
  if (!m) return null;
  const cdata = m[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return cdata ? cdata[1] : m[1];
}

async function fetchRssSource({ name, company, url }) {
  const xml = await fetchText(url);
  return parseRssItems(xml)
    .filter((item) => withinAgeWindow(item.date))
    .slice(0, MAX_PER_SOURCE)
    .map((item) => ({ ...item, company, sourceName: name }));
}

// --- Anthropic: server-rendret HTML-side (ingen RSS tilgjengelig) ---

async function fetchAnthropicNews() {
  const html = await fetchText("https://www.anthropic.com/news");
  const items = [];
  const seen = new Set();
  const linkRe = /<a href="\/news\/([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = linkRe.exec(html))) {
    const [, slug, block] = match;
    if (seen.has(slug)) continue;
    const timeMatch = block.match(/<time[^>]*>([^<]+)<\/time>/);
    const titleMatch = block.match(/<h[234][^>]*>([^<]+)<\/h[234]>/);
    const summaryMatch = block.match(/<p[^>]*>([^<]+)<\/p>/);
    if (!timeMatch || !titleMatch) continue;
    const date = parseAnthropicDate(timeMatch[1].trim());
    if (!date) continue;
    seen.add(slug);
    items.push({
      title: stripTags(titleMatch[1]),
      url: `https://www.anthropic.com/news/${slug}`,
      summary: summaryMatch ? stripTags(summaryMatch[1]).slice(0, 500) : "",
      date,
      company: "anthropic",
      sourceName: "Anthropic",
    });
  }
  return items.filter((item) => withinAgeWindow(item.date)).slice(0, MAX_PER_SOURCE);
}

function parseAnthropicDate(text) {
  // "Jul 24, 2026"
  const m = text.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const day = m[2].padStart(2, "0");
  return `${m[3]}-${month}-${day}`;
}

// --- Skriving av .md-filer ---

function existingSourceUrls() {
  const urls = new Set();
  for (const filename of readdirSync(UPDATES_DIR)) {
    if (!filename.endsWith(".md")) continue;
    const raw = readFileSync(join(UPDATES_DIR, filename), "utf-8");
    for (const m of raw.matchAll(/url:\s*"([^"]+)"/g)) {
      urls.add(m[1]);
    }
  }
  return urls;
}

function frontmatter({ title, date, company, summary, url, sourceName }) {
  return `---
title: "${title.replace(/"/g, '\\"')}"
date: ${date}
company: ${company}
summary: >
    ${(summary || title).replace(/\n/g, "\n    ")}
links:
    - label: "${sourceName}"
      url: "${url}"
---
`;
}

async function run() {
  const sources = [
    { name: "OpenAI", company: "openai", url: "https://openai.com/news/rss.xml" },
    { name: "Google", company: "google", url: "https://blog.google/technology/ai/rss/" },
  ];

  const results = await Promise.allSettled([
    ...sources.map(fetchRssSource),
    fetchAnthropicNews(),
  ]);

  const items = [];
  results.forEach((result, i) => {
    const label = i < sources.length ? sources[i].name : "Anthropic";
    if (result.status === "fulfilled") {
      items.push(...result.value);
    } else {
      console.warn(`Kunne ikke hente fra ${label}: ${result.reason?.message ?? result.reason}`);
    }
  });

  const existingUrls = existingSourceUrls();
  let written = 0;

  for (const item of items) {
    if (existingUrls.has(item.url)) continue;
    const filename = `${item.date}-${item.company}-${slugify(item.title)}.md`;
    const path = join(UPDATES_DIR, filename);
    if (existsSync(path)) continue;
    writeFileSync(path, frontmatter(item), "utf-8");
    console.log(`Skrev ${filename}`);
    written += 1;
  }

  if (written === 0) {
    console.log("Ingen nye nyheter funnet.");
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
