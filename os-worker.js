import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

const OPENAI_IMAGE_SIZES = { '1:1': '1024x1024', '4:5': '1024x1536', '9:16': '1024x1536', '16:9': '1536x1024' };
const HIGGSFIELD_IMAGE_SIZES = { '1:1': '1024x1024', '4:5': '1152x1440', '9:16': '1152x2048', '16:9': '1696x960' };

// Compose the final provider-agnostic prompt for a brand-scoped job: brand
// context first, negative constraints, output framing, then the operator's
// brief verbatim. Without a brand the brief is returned unchanged.
export function buildBrandPrompt(brand, brief, { outputType, aspectRatio } = {}) {
  if (!brand) return brief;
  const lines = [];
  lines.push(`Brand: ${brand.name}${brand.description ? ` — ${brand.description}` : ''}`);
  if (brand.audience) lines.push(`Target audience: ${brand.audience}`);
  if (brand.voice) lines.push(`Tone of voice: ${brand.voice}`);
  if (brand.styleDirectives) lines.push(`Visual style: ${brand.styleDirectives}`);
  const palette = Array.isArray(brand.palette) ? brand.palette.filter(Boolean) : [];
  if (palette.length) lines.push(`Dominant brand colours: ${palette.join(', ')}. Use these colours prominently and keep the palette consistent.`);
  const bannedWords = Array.isArray(brand.bannedWords) ? brand.bannedWords.filter(Boolean) : [];
  if (bannedWords.length) lines.push(`Never include: ${bannedWords.join(', ')}.`);
  lines.push(`Output: ${outputType === 'video' ? 'short-form social video' : 'social ad creative image'}, aspect ratio ${aspectRatio || '4:5'}.`);
  lines.push('');
  lines.push(`Creative brief: ${String(brief || '').trim()}`);
  return lines.join('\n');
}

// Must match osQueueKey in server.js exactly so queue controls and
// publications line up with the operator view.
function osQueueKey(row) {
  return createHash('sha256').update([row.brand, row.postOrder, row.date, row.time].join(':')).digest('hex').slice(0, 20);
}

function queueItemDate(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const match = /^(\d{2}):(\d{2})/.exec(String(time || ''));
  const when = new Date(`${date}T${match ? `${match[1]}:${match[2]}` : '00:00'}:00`);
  return Number.isNaN(when.getTime()) ? null : when;
}

export function startOsWorker(deps) {
  const { memberStore, osWorkspaceKey, osContentDir, loadOsContent, decryptOsToken } = deps;
  const log = deps.log || ((event) => console.info(JSON.stringify(event)));
  let loggedMissingMeta = false;

  async function saveGeneratedAsset(bytes, filename) {
    const directory = join(osContentDir, 'generated');
    await mkdir(directory, { recursive: true });
    const filePath = join(directory, filename);
    await writeFile(filePath, bytes);
    return `/os/media/${encodeURIComponent(filePath)}`;
  }

  async function downloadGeneratedBytes(url, label) {
    const download = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!download.ok) throw new Error(`${label}_download_http_${download.status}`);
    const bytes = Buffer.from(await download.arrayBuffer());
    if (!bytes.length) throw new Error(`${label}_download_empty`);
    return bytes;
  }

  function jobImageCount(job) {
    return Math.min(Math.max(Number(job.count || 1), 1), 4);
  }

  async function generateOpenAiImages(job) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('missing OPENAI_API_KEY');
    const model = job.model || 'gpt-image-2';
    const count = jobImageCount(job);
    const urls = [];
    for (let index = 0; index < count; index += 1) {
      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: job.prompt, size: OPENAI_IMAGE_SIZES[job.aspectRatio] || '1024x1024' }),
        signal: AbortSignal.timeout(120_000)
      });
      if (!response.ok) throw new Error(`openai_http_${response.status}: ${(await response.text()).slice(0, 300)}`);
      const payload = await response.json().catch(() => ({}));
      const image = payload?.data?.[0];
      let bytes = null;
      if (image?.b64_json) {
        bytes = Buffer.from(image.b64_json, 'base64');
      } else if (image?.url) {
        bytes = await downloadGeneratedBytes(image.url, 'openai_asset');
      }
      if (!bytes || !bytes.length) throw new Error('openai_returned_no_image');
      const filename = count > 1 ? `${job.id}-${index}.png` : `${job.id}.png`;
      urls.push(await saveGeneratedAsset(bytes, filename));
    }
    return urls;
  }

  function higgsfieldHeaders() {
    const apiKey = process.env.HIGGSFIELD_API_KEY;
    const secret = process.env.HIGGSFIELD_API_SECRET;
    if (!apiKey || !secret) throw new Error('missing_higgsfield_credentials');
    return { 'hf-api-key': apiKey, 'hf-secret': secret, 'content-type': 'application/json' };
  }

  async function higgsfieldSubmit(path, params) {
    const response = await fetch(`https://platform.higgsfield.ai${path}`, {
      method: 'POST',
      headers: higgsfieldHeaders(),
      body: JSON.stringify({ params }),
      signal: AbortSignal.timeout(15_000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`higgsfield_http_${response.status}: ${JSON.stringify(payload).slice(0, 300)}`);
    const requestId = payload?.id || payload?.request_id || payload?.requestId;
    if (!requestId) {
      console.error(JSON.stringify({ type: 'os.higgsfield_unexpected_response', body: JSON.stringify(payload).slice(0, 1000) }));
      throw new Error('higgsfield_missing_request_id');
    }
    return requestId;
  }

  async function higgsfieldPoll(requestId) {
    const deadline = Date.now() + 10 * 60 * 1000;
    for (;;) {
      const response = await fetch(`https://platform.higgsfield.ai/v1/requests/${requestId}/status`, {
        headers: higgsfieldHeaders(),
        signal: AbortSignal.timeout(15_000)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`higgsfield_status_http_${response.status}`);
      const status = String(payload?.status || '').toLowerCase();
      if (status === 'completed') {
        const entries = Array.isArray(payload?.jobs) ? payload.jobs : [];
        const urls = entries.map((entry) => entry?.results?.raw?.url).filter(Boolean);
        if (!urls.length) {
          console.error(JSON.stringify({ type: 'os.higgsfield_unexpected_response', body: JSON.stringify(payload).slice(0, 1000) }));
          throw new Error('higgsfield_missing_result_url');
        }
        return urls;
      }
      if (status === 'failed' || status === 'nsfw') throw new Error(`higgsfield_request_${status}`);
      if (Date.now() > deadline) throw new Error('higgsfield_request_timeout');
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }

  async function generateHiggsfieldImages(job) {
    const count = jobImageCount(job);
    const requestId = await higgsfieldSubmit('/v1/text2image/soul', {
      prompt: job.prompt,
      width_and_height: HIGGSFIELD_IMAGE_SIZES[job.aspectRatio] || '1024x1024',
      quality: job.model === 'soul-1080p' ? '1080p' : '720p',
      batch_size: count,
      enhance_prompt: true
    });
    const resultUrls = await higgsfieldPoll(requestId);
    const urls = [];
    for (let index = 0; index < resultUrls.length; index += 1) {
      const bytes = await downloadGeneratedBytes(resultUrls[index], 'higgsfield_image');
      const filename = resultUrls.length > 1 ? `${job.id}-${index}.png` : `${job.id}.png`;
      urls.push(await saveGeneratedAsset(bytes, filename));
    }
    return urls;
  }

  async function generateHiggsfieldVideo(job) {
    const asset = job.inputAssetId ? await memberStore.osAsset(osWorkspaceKey, job.inputAssetId) : null;
    if (!asset) throw new Error('input_asset_not_found');
    const publicBase = (process.env.OS_PUBLIC_URL || process.env.SITE_URL || '').replace(/\/$/, '');
    if (!publicBase) throw new Error('public_url_required_for_video');
    const imageUrl = `${publicBase}/os/media/${encodeURIComponent(asset.path)}`;
    const requestId = await higgsfieldSubmit('/v1/image2video/dop', {
      model: job.model || 'dop-turbo',
      prompt: job.prompt,
      input_images: [{ type: 'image_url', image_url: imageUrl }]
    });
    const [resultUrl] = await higgsfieldPoll(requestId);
    const bytes = await downloadGeneratedBytes(resultUrl, 'higgsfield_video');
    return [await saveGeneratedAsset(bytes, `${job.id}.mp4`)];
  }

  async function runGenerationCycle() {
    if (!process.env.OPENAI_API_KEY && !process.env.HIGGSFIELD_API_KEY) return;
    const job = await memberStore.claimNextOsGenerationJob(osWorkspaceKey);
    if (!job) return;
    try {
      const brand = job.brandId ? await memberStore.osBrand(osWorkspaceKey, job.brandId) : null;
      const resolvedPrompt = buildBrandPrompt(brand, job.prompt, { outputType: job.outputType, aspectRatio: job.aspectRatio });
      await memberStore.saveOsGenerationJobResolvedPrompt(osWorkspaceKey, job.id, resolvedPrompt);
      const brandedJob = { ...job, prompt: resolvedPrompt };
      let assetUrls = null;
      if (job.provider === 'openai' && job.outputType === 'image') assetUrls = await generateOpenAiImages(brandedJob);
      else if (job.provider === 'higgsfield' && job.outputType === 'image') assetUrls = await generateHiggsfieldImages(brandedJob);
      else if (job.provider === 'higgsfield' && job.outputType === 'video') assetUrls = await generateHiggsfieldVideo(brandedJob);
      if (!assetUrls || !assetUrls.length) {
        await memberStore.failOsGenerationJob(osWorkspaceKey, job.id, `provider_not_implemented: ${job.provider}/${job.outputType}`);
        return;
      }
      await memberStore.completeOsGenerationJob(osWorkspaceKey, job.id, assetUrls[0], assetUrls);
      log({ type: 'os.generation_job_completed', job: job.id, provider: job.provider, assets: assetUrls.length });
    } catch (error) {
      await memberStore.failOsGenerationJob(osWorkspaceKey, job.id, error.message);
      console.error(JSON.stringify({ type: 'os.generation_job_failed', job: job.id, reason: error.message }));
    }
  }

  function resolveQueueImage(image) {
    if (!image) return null;
    let candidate = String(image);
    if (candidate.startsWith('/os/media/')) candidate = decodeURIComponent(candidate.slice('/os/media/'.length));
    const filePath = isAbsolute(candidate) ? candidate : join(osContentDir, candidate);
    return existsSync(filePath) ? filePath : null;
  }

  async function resolveMetaPage(connection) {
    const token = decryptOsToken(connection.tokenEnvelope);
    const userToken = token?.access_token;
    if (!userToken) throw new Error('meta_token_missing_access_token');
    const response = await fetch(`https://graph.facebook.com/v21.0/me/accounts?access_token=${encodeURIComponent(userToken)}`, {
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`meta_pages_http_${response.status}`);
    const payload = await response.json();
    const pages = Array.isArray(payload?.data) ? payload.data : [];
    const preferred = connection.metadata?.pageId ? pages.find((page) => page.id === connection.metadata.pageId) : null;
    const page = preferred || pages[0];
    if (!page?.id || !page?.access_token) throw new Error('meta_no_page_available');
    return page;
  }

  async function publishToMeta(page, item) {
    const caption = item.caption || '';
    const imagePath = resolveQueueImage(item.image);
    if (imagePath) {
      const form = new FormData();
      form.set('caption', caption);
      form.set('access_token', page.access_token);
      form.set('source', new Blob([await readFile(imagePath)]), basename(imagePath));
      const response = await fetch(`https://graph.facebook.com/v21.0/${page.id}/photos`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(60_000)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`meta_photo_http_${response.status}: ${payload?.error?.message || 'unknown'}`.slice(0, 300));
      return payload.post_id || payload.id || null;
    }
    const response = await fetch(`https://graph.facebook.com/v21.0/${page.id}/feed`, {
      method: 'POST',
      body: new URLSearchParams({ message: caption, access_token: page.access_token }),
      signal: AbortSignal.timeout(30_000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`meta_feed_http_${response.status}: ${payload?.error?.message || 'unknown'}`.slice(0, 300));
    return payload.id || null;
  }

  async function recordPublication(item, status, externalId, error) {
    await memberStore.saveOsPublication(osWorkspaceKey, { itemKey: item.key, channel: 'facebook', status, externalId, error });
    await memberStore.saveOsQueueControl(osWorkspaceKey, item.key, status === 'published' ? 'published' : 'failed');
  }

  async function runPublishCycle() {
    const content = loadOsContent();
    const operatorState = await memberStore.osState(osWorkspaceKey);
    const now = new Date();
    const due = [];
    for (const item of content.schedule) {
      const row = {
        brand: item.brand || '',
        postOrder: item.postOrder || item.post_order || '',
        date: item.date || '',
        time: item.time || '',
        caption: item.caption || '',
        image: item.image || item.image_path || ''
      };
      const key = item.key || osQueueKey(row);
      const state = operatorState.queueControls[key]?.state || item.state || 'scheduled';
      if (state !== 'scheduled') continue;
      const when = queueItemDate(row.date, row.time);
      if (when && when <= now) due.push({ key, ...row });
    }
    if (!due.length) return;
    const connection = await memberStore.osConnectionToken(osWorkspaceKey, 'meta');
    if (!connection) {
      if (!loggedMissingMeta) {
        loggedMissingMeta = true;
        log({ type: 'os.publisher_no_meta_connection', due: due.length });
      }
      return;
    }
    let page = null;
    try {
      page = await resolveMetaPage(connection);
    } catch (error) {
      for (const item of due) await recordPublication(item, 'failed', null, error.message);
      console.error(JSON.stringify({ type: 'os.publish_failed', reason: error.message, due: due.length }));
      return;
    }
    for (const item of due) {
      try {
        const externalId = await publishToMeta(page, item);
        await recordPublication(item, 'published', externalId, null);
        log({ type: 'os.queue_item_published', item: item.key, channel: 'facebook' });
      } catch (error) {
        await recordPublication(item, 'failed', null, error.message);
        console.error(JSON.stringify({ type: 'os.publish_failed', item: item.key, reason: error.message }));
      }
    }
  }

  const metricsSyncStatus = new Map();

  function recordMetricsSync(provider, state, detail = {}) {
    metricsSyncStatus.set(provider, { state, checkedAt: new Date().toISOString(), ...detail });
  }

  function metricNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function sumActionValues(list, types) {
    if (!Array.isArray(list)) return 0;
    return list.reduce((total, entry) => total + (types.includes(entry?.action_type) ? metricNumber(entry?.value) : 0), 0);
  }

  async function persistConnectionMetadata(provider, connection, extraMetadata) {
    const full = (await memberStore.osConnections(osWorkspaceKey)).find((item) => item.providerId === provider);
    await memberStore.saveOsConnection(osWorkspaceKey, {
      providerId: provider,
      accountId: connection.accountId,
      accountLabel: connection.accountLabel,
      tokenEnvelope: connection.tokenEnvelope,
      scopes: full?.scopes || [],
      metadata: { ...(connection.metadata || {}), ...extraMetadata }
    });
  }

  async function syncMetaMetrics(connection, token) {
    const accessToken = token?.access_token;
    if (!accessToken) throw new Error('meta_token_missing_access_token');
    let adAccountId = connection.metadata?.adAccountId || '';
    if (!adAccountId) {
      const response = await fetch(`https://graph.facebook.com/v21.0/me/adaccounts?fields=id,name&access_token=${encodeURIComponent(accessToken)}`, {
        signal: AbortSignal.timeout(15_000)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`meta_adaccounts_http_${response.status}`);
      const account = Array.isArray(payload?.data) ? payload.data[0] : null;
      if (!account?.id) throw new Error('meta_no_ad_account_available');
      adAccountId = account.id;
      await persistConnectionMetadata('meta', connection, { adAccountId });
    }
    const actId = String(adAccountId).startsWith('act_') ? adAccountId : `act_${adAccountId}`;
    const query = new URLSearchParams({
      fields: 'spend,impressions,clicks,actions,action_values',
      date_preset: 'last_30d',
      time_increment: '1',
      limit: '100',
      access_token: accessToken
    });
    const response = await fetch(`https://graph.facebook.com/v21.0/${actId}/insights?${query}`, { signal: AbortSignal.timeout(15_000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`meta_insights_http_${response.status}: ${payload?.error?.message || 'unknown'}`.slice(0, 300));
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const saleTypes = ['purchase', 'offsite_conversion.fb_pixel_purchase'];
    for (const row of rows) {
      const date = String(row?.date_start || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      await memberStore.saveOsChannelMetrics(osWorkspaceKey, 'meta', date, {
        spend: metricNumber(row.spend),
        impressions: metricNumber(row.impressions),
        clicks: metricNumber(row.clicks),
        leads: sumActionValues(row.actions, ['lead']),
        sales: sumActionValues(row.actions, saleTypes),
        revenue: sumActionValues(row.action_values, saleTypes),
        raw: row
      });
    }
    return rows.length;
  }

  async function syncTikTokMetrics(connection, token) {
    const accessToken = token?.access_token;
    if (!accessToken) throw new Error('tiktok_token_missing_access_token');
    const advertiserId = connection.accountId || connection.metadata?.advertiserId || (Array.isArray(token?.advertiser_ids) ? token.advertiser_ids[0] : null);
    if (!advertiserId) throw new Error('tiktok_advertiser_missing');
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const response = await fetch('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/', {
      method: 'POST',
      headers: { 'Access-Token': accessToken, 'content-type': 'application/json' },
      body: JSON.stringify({
        advertiser_id: advertiserId,
        report_type: 'BASIC',
        data_level: 'AUCTION_ADVERTISER',
        dimensions: ['stat_time_day'],
        metrics: ['spend', 'impressions', 'clicks', 'conversion', 'total_purchase_value'],
        start_date: startDate,
        end_date: endDate,
        page_size: 100
      }),
      signal: AbortSignal.timeout(15_000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload?.code) !== 0) throw new Error(`tiktok_report_failed: ${payload?.message || `http_${response.status}`}`.slice(0, 300));
    const rows = Array.isArray(payload?.data?.list) ? payload.data.list : [];
    for (const row of rows) {
      const metrics = row?.metrics || {};
      const date = String(row?.dimensions?.stat_time_day || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      await memberStore.saveOsChannelMetrics(osWorkspaceKey, 'tiktok', date, {
        spend: metricNumber(metrics.spend),
        impressions: metricNumber(metrics.impressions),
        clicks: metricNumber(metrics.clicks),
        leads: metricNumber(metrics.conversion),
        sales: metricNumber(metrics.conversion),
        revenue: metricNumber(metrics.total_purchase_value),
        raw: { ...metrics, leadsFrom: 'conversion', salesFrom: 'conversion' }
      });
    }
    return rows.length;
  }

  async function syncGoogleMetrics(connection, token) {
    const refreshToken = token?.refresh_token;
    if (!refreshToken) throw new Error('google_token_missing_refresh_token');
    const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    if (!developerToken) throw new Error('missing GOOGLE_ADS_DEVELOPER_TOKEN');
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }),
      signal: AbortSignal.timeout(15_000)
    });
    const tokenPayload = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenPayload?.access_token) throw new Error('google_token_refresh_failed');
    const accessToken = tokenPayload.access_token;
    let customerId = connection.metadata?.customerId || '';
    if (!customerId) {
      const response = await fetch('https://googleads.googleapis.com/v17/customers:listAccessibleCustomers', {
        headers: { authorization: `Bearer ${accessToken}`, 'developer-token': developerToken },
        signal: AbortSignal.timeout(15_000)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`google_customers_http_${response.status}`);
      const first = Array.isArray(payload?.resourceNames) ? payload.resourceNames[0] : null;
      customerId = first ? String(first).split('/')[1] : '';
      if (!customerId) throw new Error('google_no_customer_available');
      await persistConnectionMetadata('google', connection, { customerId });
    }
    const response = await fetch(`https://googleads.googleapis.com/v17/customers/${customerId}/googleAds:search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'developer-token': developerToken, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM customer WHERE segments.date DURING LAST_30_DAYS' }),
      signal: AbortSignal.timeout(15_000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`google_ads_http_${response.status}`.slice(0, 300));
    const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.results) ? payload.results : []);
    for (const row of rows) {
      const metrics = row?.metrics || {};
      const date = String(row?.segments?.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      await memberStore.saveOsChannelMetrics(osWorkspaceKey, 'google', date, {
        spend: metricNumber(metrics.costMicros ?? metrics.cost_micros) / 1e6,
        impressions: metricNumber(metrics.impressions),
        clicks: metricNumber(metrics.clicks),
        leads: metricNumber(metrics.conversions),
        sales: metricNumber(metrics.conversions),
        revenue: metricNumber(metrics.conversionsValue ?? metrics.conversions_value),
        raw: { segments: row?.segments || {}, metrics, leadsFrom: 'metrics.conversions', salesFrom: 'metrics.conversions' }
      });
    }
    return rows.length;
  }

  const metricsSyncers = { meta: syncMetaMetrics, tiktok: syncTikTokMetrics, google: syncGoogleMetrics };

  // Never throws: providers without a stored connection are skipped quietly and
  // any sync failure is recorded in-memory plus logged for the operator.
  async function runMetricsSyncCycle() {
    for (const [provider, syncer] of Object.entries(metricsSyncers)) {
      try {
        const connection = await memberStore.osConnectionToken(osWorkspaceKey, provider);
        if (!connection?.tokenEnvelope) continue;
        const token = decryptOsToken(connection.tokenEnvelope);
        const rows = await syncer(connection, token);
        recordMetricsSync(provider, 'synced', { rows });
        log({ type: 'os.metrics_synced', provider, rows });
      } catch (error) {
        recordMetricsSync(provider, 'failed', { reason: String(error.message || 'unknown_error').slice(0, 300) });
        console.error(JSON.stringify({ type: 'os.metrics_sync_failed', provider, reason: error.message }));
      }
    }
  }

  if (!process.env.OPENAI_API_KEY && !process.env.HIGGSFIELD_API_KEY) log({ type: 'os.generation_worker_disabled', reason: 'missing OPENAI_API_KEY and HIGGSFIELD_API_KEY' });
  const generationInterval = setInterval(() => {
    runGenerationCycle().catch((error) => console.error(JSON.stringify({ type: 'os.worker_generation_failed', reason: error.message })));
  }, 15_000);
  generationInterval.unref();
  const publishInterval = setInterval(() => {
    runPublishCycle().catch((error) => console.error(JSON.stringify({ type: 'os.worker_publish_failed', reason: error.message })));
  }, 60_000);
  publishInterval.unref();
  const metricsInterval = setInterval(() => {
    runMetricsSyncCycle().catch((error) => console.error(JSON.stringify({ type: 'os.worker_metrics_failed', reason: error.message })));
  }, 15 * 60 * 1000);
  metricsInterval.unref();
  const metricsBootTimer = setTimeout(() => {
    runMetricsSyncCycle().catch((error) => console.error(JSON.stringify({ type: 'os.worker_metrics_failed', reason: error.message })));
  }, 60_000);
  metricsBootTimer.unref();
  runGenerationCycle().catch((error) => console.error(JSON.stringify({ type: 'os.worker_generation_failed', reason: error.message })));

  return function stopOsWorker() {
    clearInterval(generationInterval);
    clearInterval(publishInterval);
    clearInterval(metricsInterval);
    clearTimeout(metricsBootTimer);
  };
}
