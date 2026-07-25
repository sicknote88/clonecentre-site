import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = resolve(here, '..');
const workspaceDir = resolve(siteDir, '..');
const sourceDir = process.env.OS_CONTENT_DIR ? resolve(process.env.OS_CONTENT_DIR) : join(workspaceDir, 'social_output');
const postsPath = join(sourceDir, 'posts.json');
const schedulePath = join(sourceDir, 'schedule.csv');
const outputPath = join(siteDir, 'os-data', 'snapshot.json');
const imageDir = join(siteDir, 'assets', 'os', 'content');

if (!existsSync(postsPath)) throw new Error(`No content pipeline found at ${postsPath}`);

mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(imageDir, { recursive: true });

function keyFor(parts) {
  return createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 20);
}

function parseCsv(source) {
  const rows = [[]]; let field = ''; let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' && quoted && source[index + 1] === '"') { field += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { rows.at(-1).push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      rows.at(-1).push(field); field = ''; rows.push([]);
    } else field += char;
  }
  if (field || rows.at(-1).length) rows.at(-1).push(field);
  return rows.filter((row) => row.length > 1);
}

function publishImage(source, key) {
  if (!source || !existsSync(source)) return null;
  const jpegName = `${key}.jpg`;
  const jpegPath = join(imageDir, jpegName);
  const converted = spawnSync('sips', ['-Z', '720', '-s', 'format', 'jpeg', '-s', 'formatOptions', '78', source, '--out', jpegPath], { stdio: 'ignore' });
  if (converted.status === 0 && existsSync(jpegPath)) return `/assets/os/content/${jpegName}`;
  const extension = extname(source).toLowerCase() || '.png';
  const fallbackName = `${key}${extension}`;
  copyFileSync(source, join(imageDir, fallbackName));
  return `/assets/os/content/${fallbackName}`;
}

const sourcePosts = JSON.parse(readFileSync(postsPath, 'utf8'));
const latestPosts = new Map();
for (const post of sourcePosts) {
  const identity = `${post.brand}:${post.post_id}`;
  if (!latestPosts.has(identity)) latestPosts.set(identity, { ...post });
  else if (!latestPosts.get(identity).image_path && post.image_path) latestPosts.get(identity).image_path = post.image_path;
}
const posts = [...latestPosts.values()].map((post) => {
  const key = keyFor([post.run_id, post.post_id, post.created_at, post.title]);
  return {
    key,
    brand: post.brand_display || post.brand,
    brand_slug: post.brand,
    title: post.title,
    subheadline: post.subheadline,
    pillar: post.pillar,
    status: post.creative_loop_status || 'review',
    score: post.creative_loop_scores ? Math.round(Object.values(post.creative_loop_scores).reduce((a, b) => a + b, 0) / Object.values(post.creative_loop_scores).length * 10) : null,
    image: publishImage(post.image_path, key),
    caption: post.caption || post.caption_override || '',
    createdAt: post.created_at
  };
});

let schedule = [];
if (existsSync(schedulePath)) {
  const rows = parseCsv(readFileSync(schedulePath, 'utf8'));
  const headers = rows[0] || [];
  schedule = rows.slice(1).map((row) => {
    const item = Object.fromEntries(headers.map((header, index) => [header, row[index] || '']));
    return {
      key: keyFor([item.brand, item.post_order, item.date, item.time]),
      brand: item.brand,
      postOrder: item.post_order,
      date: item.date,
      time: item.time,
      caption: item.caption,
      state: 'scheduled'
    };
  });
}

writeFileSync(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), posts, schedule }, null, 2)}\n`);
console.info(JSON.stringify({ type: 'os_snapshot.synced', posts: posts.length, schedule: schedule.length, output: outputPath }));
