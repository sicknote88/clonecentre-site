#!/usr/bin/env node
// Refresh /data/trend-map.json from free, unauthenticated sources:
//   - Google autocomplete (what people actually type)
//   - YouTube suggest    (what video viewers search)
//   - Google Trends daily-trending RSS, geo=GB (marks AI nodes "hot")
// Run with: npm run trends

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public-data');
const outFile = join(outDir, 'trend-map.json');

const SEEDS = [
  { cluster: 'ChatGPT', seeds: ['chatgpt', 'chatgpt prompts', 'chatgpt for work'] },
  { cluster: 'AI Tools', seeds: ['best ai tools', 'free ai tools', 'ai tools for business'] },
  { cluster: 'AI Agents', seeds: ['ai agents', 'ai agent builder', 'autonomous ai'] },
  { cluster: 'Make Money with AI', seeds: ['ai side hustle', 'how to make money with ai', 'ai business ideas'] },
  { cluster: 'AI Video', seeds: ['ai video generator', 'text to video ai', 'ai avatar video'] },
  { cluster: 'AI for Small Business', seeds: ['ai for small business', 'ai automation for business', 'ai for marketing'] },
  { cluster: 'AI Jobs & Careers', seeds: ['ai jobs', 'will ai take my job', 'ai careers'] },
  { cluster: 'AI Art & Images', seeds: ['ai art generator', 'ai image generator', 'ai photo editing'] },
  { cluster: 'Claude & Gemini', seeds: ['claude ai', 'gemini ai', 'claude vs chatgpt'] },
  { cluster: 'AI Automation', seeds: ['ai automation', 'automate with ai', 'ai workflow automation'] },
  { cluster: 'AI Voice & Music', seeds: ['ai voice generator', 'ai music generator', 'ai voice cloning'] },
  { cluster: 'Prompt Engineering', seeds: ['prompt engineering', 'how to write ai prompts', 'ai prompt examples'] },
  { cluster: 'AI in the UK', seeds: ['ai uk', 'ai courses uk', 'ai grants for small business uk'] },
  { cluster: 'AI News & Fear', seeds: ['ai news', 'is ai dangerous', 'ai taking over'] }
];

const AI_HOTWORDS = /\b(ai|a\.i\.|chatgpt|openai|gemini|claude|copilot|midjourney|sora|llm|gpt|artificial intelligence)\b/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (CloneCentre trend research)' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function suggest(query, dataset) {
  const ds = dataset ? `&ds=${dataset}` : '';
  const url = `https://suggestqueries.google.com/complete/search?client=firefox${ds}&q=${encodeURIComponent(query)}`;
  const data = await fetchJson(url);
  return Array.isArray(data?.[1]) ? data[1] : [];
}

async function fetchHotHeadlines() {
  try {
    const response = await fetch('https://trends.google.com/trending/rss?geo=GB', {
      headers: { 'User-Agent': 'Mozilla/5.0 (CloneCentre trend research)' }
    });
    if (!response.ok) return [];
    const xml = await response.text();
    const titles = [...xml.matchAll(/<title>([^<]+)<\/title>/g)].map((match) => match[1]);
    return titles.filter((title) => AI_HOTWORDS.test(title));
  } catch {
    return [];
  }
}

// Unofficial Google Trends widget API (same flow pytrends uses, no key).
function parseTrendsJson(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('unexpected trends response');
  return JSON.parse(text.slice(start));
}

async function trendsTimeline(keyword) {
  const delays = [0, 5000];
  for (const delay of delays) {
    if (delay) await sleep(delay);
    const timeline = await trendsTimelineOnce(keyword).catch(() => null);
    if (timeline && timeline.length) return timeline;
  }
  return null;
}

async function trendsTimelineOnce(keyword) {
  const headers = { 'User-Agent': 'Mozilla/5.0 (CloneCentre trend research)' };
  const exploreReq = JSON.stringify({ comparisonItem: [{ keyword, geo: 'GB', time: 'today 12-m' }], category: 0, property: '' });
  const exploreRes = await fetch(`https://trends.google.com/trends/api/explore?hl=en-GB&tz=0&req=${encodeURIComponent(exploreReq)}`, { headers });
  if (!exploreRes.ok) return null;
  const explore = parseTrendsJson(await exploreRes.text());
  const widget = (explore.widgets || []).find((item) => item.id === 'TIMESERIES');
  if (!widget) return null;
  const url = `https://trends.google.com/trends/api/widgetdata/multiline?hl=en-GB&tz=0&req=${encodeURIComponent(JSON.stringify(widget.request))}&token=${encodeURIComponent(widget.token)}`;
  const response = await fetch(url, { headers });
  if (!response.ok) return null;
  const data = parseTrendsJson(await response.text());
  const points = data?.default?.timelineData || [];
  return points.map((point) => ({ date: point.formattedTime, value: point.value?.[0] ?? 0 }));
}

function growthFrom(timeline) {
  if (!timeline || timeline.length < 16) return null;
  const values = timeline.map((point) => point.value);
  const avg = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
  const recent = avg(values.slice(-8));
  const prior = avg(values.slice(-16, -8));
  if (prior === 0) return null;
  return Math.round(((recent - prior) / prior) * 100);
}

function hookFrom(query) {
  const q = query.trim();
  if (/^how to|^how do|^how can/.test(q)) return ['howto', `"${q}" — everyone googles this. Here's the actual answer in 60 seconds.`];
  if (/^what is|^what are/.test(q)) return ['whatis', `Stop scrolling — "${q}" explained like you're five, by a Scouser.`];
  if (/^best |^top /.test(q)) return ['best', `I tested everything so you don't have to: "${q}" — the honest version.`];
  if (/vs | versus /.test(q)) return ['vs', `"${q}" — I ran both for a week. The winner surprised me.`];
  if (/free/.test(q)) return ['free', `"${q}" — yes, actually free. No catch, I'll show you.`];
  if (/job|career|salary/.test(q)) return ['job', `People keep searching "${q}" — here's the truth nobody tells you.`];
  return ['generic', `"${q}" — this is what people are really searching, so here's my straight answer.`];
}

const FALLBACK_HOOKS = [
  (q) => `"${q}" — thousands search this every week. Here's the shortcut.`,
  (q) => `POV: you finally understand "${q}". Watch this twice.`,
  (q) => `Nobody explains "${q}" properly. So I will.`
];

function hooksFor(queries) {
  const hooks = [];
  const used = new Set();
  for (const query of queries) {
    const [category, hook] = hookFrom(query.label);
    if (!used.has(category)) {
      used.add(category);
      hooks.push(hook);
    } else {
      hooks.push(FALLBACK_HOOKS[hooks.length % FALLBACK_HOOKS.length](query.label));
    }
    if (hooks.length === 3) break;
  }
  return hooks;
}

// --- per-query content pack: video format + ready title, from the query shape ---
function titleCase(value) {
  return value.replace(/\b\w/g, (char) => char.toUpperCase()).replace(/\bAi\b/g, 'AI').replace(/\bGpt\b/g, 'GPT');
}

function contentPack(query) {
  const q = query.trim();
  if (/^how to|^how do|^how can/.test(q))
    return { format: 'Screen-demo tutorial', title: `${titleCase(q)} (the way that actually works)` };
  if (/vs | versus /.test(q))
    return { format: 'Comparison video', title: `${titleCase(q)} — I tested both so you don't have to` };
  if (/^best |^top /.test(q))
    return { format: 'Tools roundup', title: `I ranked every option: ${titleCase(q)}` };
  if (/free/.test(q))
    return { format: 'Tools roundup', title: `${titleCase(q)} — free tools that actually work` };
  if (/^what is|^what are/.test(q))
    return { format: 'Explainer', title: `${titleCase(q)}? Explained in 60 seconds` };
  if (/job|career|salary/.test(q))
    return { format: 'Talking-head take', title: `The truth about "${q}" nobody tells you` };
  return { format: 'Talking-head take', title: `${titleCase(q)} — what nobody explains` };
}

// --- which Clone Centre offer each cluster feeds ---
const OFFERS = {
  'Make Money with AI': { label: 'Sell as a 1-to-1 AI Fix Session', href: '/coaching' },
  'AI for Small Business': { label: 'Sell as a 1-to-1 AI Fix Session', href: '/coaching' },
  'AI Automation': { label: 'Sell as a 1-to-1 AI Fix Session', href: '/coaching' },
  'AI Jobs & Careers': { label: 'Sell as a 1-to-1 Power Session', href: '/coaching' },
  'AI Video': { label: 'Free mini-lesson lead magnet → group call', href: '/community' },
  'AI Tools': { label: 'Free mini-lesson lead magnet → group call', href: '/community' }
};
const DEFAULT_OFFER = { label: 'Teach it live in the weekly group call', href: '/community' };

// --- 60-second shooting script per query, built from the real data we hold ---
function scriptFor(query, hook) {
  const q = query.label;
  const related = (query.related || []).map((item) => item.label);
  const followUps = related.length
    ? `These are what people search next, so name-drop them: ${related.slice(0, 3).join(', ')}.`
    : 'Answer it properly, no fluff.';
  const middles = {
    'Screen-demo tutorial': [
      `Don't talk about it — show it. Screen-record yourself doing "${q}" in real time, no cuts.`,
      `Narrate each click like the viewer is sat next to you. ${followUps}`,
      'End on the finished result and how long it took.'
    ],
    'Comparison video': [
      `Run both options live, side by side, same task: "${q}".`,
      `Score each out loud on speed, quality and price. ${followUps}`,
      'Give a clear winner — fence-sitting kills shares.'
    ],
    'Tools roundup': [
      `Three options for "${q}", ten seconds each: what it does, what it costs, who it's for.`,
      `${followUps}`,
      'Crown one winner and say exactly why.'
    ],
    'Explainer': [
      `Define it in one line, like you're telling your nan: "${q}".`,
      `One concrete example of it being used. ${followUps}`,
      'End with why it matters this year specifically.'
    ],
    'Talking-head take': [
      `Your take in one sentence, straight to camera: "${q}" — agree, disagree, or "it's more complicated".`,
      `Back it with one story or number. ${followUps}`,
      'Land on the one thing the viewer should do about it.'
    ]
  };
  const middle = middles[query.format] || middles['Talking-head take'];
  return [
    { beat: 'HOOK · 0–3s', line: hook },
    { beat: 'SETUP · 3–10s', line: `"People keep searching '${q}' — so here's the straight answer, no sponsorship, no fluff."` },
    { beat: 'VALUE · 10–50s', line: middle.join(' ') },
    { beat: 'CTA · 50–60s', line: `"I mapped everything people search about AI — link's in my bio, joseph.clonecentre.ai/trends. And I teach this live every week in the group call. Liverpool, let's go."` }
  ];
}

const hot = await fetchHotHeadlines();
console.log(`hot headlines (GB): ${hot.length}`);
for (const title of hot.slice(0, 5)) console.log(`  - ${title}`);

const clusters = [];
for (const { cluster, seeds } of SEEDS) {
  const counts = new Map();
  for (const seed of seeds) {
    for (const dataset of ['', 'yt']) {
      try {
        const results = await suggest(seed, dataset);
        results.forEach((label, index) => {
          const key = label.toLowerCase().trim();
          if (!key || key.length < 4) return;
          const entry = counts.get(key) || { score: 0, appearances: 0, sources: new Set() };
          entry.score += (results.length - index) + (dataset === 'yt' ? 2 : 0);
          entry.appearances += 1;
          entry.sources.add(dataset === 'yt' ? 'youtube' : 'google');
          counts.set(key, entry);
        });
      } catch (error) {
        console.warn(`suggest failed for "${seed}" (${dataset || 'web'}): ${error.message}`);
      }
      await sleep(150);
    }
  }
  const hotWords = new Set(hot.flatMap((title) => title.toLowerCase().split(/[^a-z]+/)).filter((word) => word.length > 4));
  const queries = [...counts.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 10)
    .map(([label, metrics], index) => ({
      label,
      rank: index + 1,
      score: metrics.score,
      appearances: metrics.appearances,
      sources: [...metrics.sources],
      hot: label.split(/[^a-z]+/).some((word) => hotWords.has(word)),
      hook: hookFrom(label)[1]
    }));

  const topLabel = queries[0]?.label || seeds[0];

  // "people search next": autocomplete on the top queries themselves
  for (const query of queries.slice(0, 5)) {
    const related = new Map();
    for (const dataset of ['', 'yt']) {
      try {
        const results = await suggest(query.label, dataset);
        for (const label of results) {
          const key = label.toLowerCase().trim();
          if (key.length < 4 || key === query.label) continue;
          if (!related.has(key)) related.set(key, dataset === 'yt' ? 'youtube' : 'google');
          if (related.size >= 5) break;
        }
      } catch (error) {
        console.warn(`related failed for "${query.label}": ${error.message}`);
      }
      if (related.size >= 5) break;
      await sleep(150);
    }
    query.related = [...related.entries()].slice(0, 5).map(([label, source]) => ({ label, source }));
    Object.assign(query, contentPack(query.label));
  }
  for (const query of queries.slice(5)) Object.assign(query, contentPack(query.label));
  for (const query of queries) query.script = scriptFor(query, query.hook);

  const timeline = await trendsTimeline(topLabel).catch(() => null);
  await sleep(300);

  clusters.push({
    name: cluster,
    score: queries.reduce((sum, query) => sum + query.score, 0),
    analyzed: counts.size,
    queries,
    hooks: hooksFor(queries),
    offer: OFFERS[cluster] || DEFAULT_OFFER,
    trends: timeline && timeline.length
      ? { keyword: topLabel, current: timeline.at(-1).value, growthPct: growthFrom(timeline), timeline }
      : null
  });
  console.log(`${cluster}: ${queries.length} queries (of ${counts.size}), score ${clusters.at(-1).score}, trends ${timeline ? 'ok' : 'unavailable'}`);
}

clusters.sort((a, b) => b.score - a.score);

const payload = {
  generatedAt: new Date().toISOString(),
  geo: 'GB',
  sources: ['google-autocomplete', 'youtube-suggest', 'google-trends-daily-gb', 'google-trends-12m-gb'],
  hotHeadlines: hot.slice(0, 10),
  totalAnalyzed: clusters.reduce((sum, cluster) => sum + cluster.analyzed, 0),
  clusters
};

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(payload, null, 2));
console.log(`wrote ${outFile} (${clusters.length} clusters)`);
