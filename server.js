import express from 'express';
import Stripe from 'stripe';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packagedPublicDir = join(here, 'public');
const packagedBooksDir = join(here, 'private', 'books');
const publicDir = existsSync(packagedPublicDir) ? packagedPublicDir : here;
const privateBooksDir = existsSync(packagedBooksDir) ? packagedBooksDir : join(here, 'books', 'paid');
const catalog = JSON.parse(readFileSync(join(here, 'fulfillment', 'catalog.json'), 'utf8'));
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_webhook_verification_only');
const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const dryRun = !isProduction && process.env.DELIVERY_DRY_RUN === 'true';
const subscribeAttempts = new Map();
const chatTranscriptAttempts = new Map();

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[character]);
}

function publicSiteUrl() {
  return (process.env.SITE_URL || 'https://clonecentre-site-production.up.railway.app').replace(/\/$/, '');
}

async function resendRequest(path, { method = 'POST', body, idempotencyKey } = {}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch(`https://api.resend.com${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  return { response, result };
}

async function sendResendEmail(message, idempotencyKey) {
  const { response, result } = await resendRequest('/emails', { body: message, idempotencyKey });
  if (!response.ok) {
    throw new Error(`Resend rejected email (${response.status}): ${result.message || result.name || 'unknown error'}`);
  }
  return result;
}

function assertPrivateFile(relativePath) {
  const fullPath = resolve(privateBooksDir, relativePath);
  const root = resolve(privateBooksDir) + sep;
  if (!fullPath.startsWith(root)) throw new Error(`Unsafe delivery path: ${relativePath}`);
  const details = statSync(fullPath);
  if (!details.isFile()) throw new Error(`Delivery asset is not a file: ${relativePath}`);
  return fullPath;
}

function resolveProduct(session) {
  const metadataKey = session.metadata?.catalog_key;
  const paymentLinkKey = catalog.paymentLinks[session.payment_link];
  const productKey = metadataKey || paymentLinkKey;
  const product = catalog.products[productKey];
  if (!product) throw new Error(`No delivery mapping for Checkout Session ${session.id}`);
  return { key: productKey, ...product };
}

function customerEmail(session) {
  return session.customer_details?.email || session.customer_email || null;
}

function emailMarkup(product) {
  const count = product.files.length;
  return `<!doctype html>
  <html><body style="margin:0;background:#050505;color:#e8eef4;font-family:Arial,sans-serif">
    <div style="max-width:620px;margin:auto;padding:34px 24px">
      <div style="font:12px monospace;letter-spacing:2px;color:#2e9bff">CLONE CENTRE // DELIVERY COMPLETE</div>
      <h1 style="font-size:30px;margin:18px 0 12px">Your ${product.title} files are attached.</h1>
      <p style="line-height:1.65;color:#aeb8c2">Thank you for your purchase. This email contains ${count === 1 ? 'your PDF' : `all ${count} included files`} as attachments, ready to save and read.</p>
      <p style="line-height:1.65;color:#aeb8c2">These files are licensed for your personal use. Please do not redistribute them or publish private download copies.</p>
      <div style="margin-top:26px;padding-top:18px;border-top:1px solid #26323e;color:#7f8b96;font-size:13px">Questions? Reply to this email or contact <a style="color:#2e9bff" href="mailto:hello@clonecentre.ai">hello@clonecentre.ai</a>.</div>
    </div>
  </body></html>`;
}

const profileOptions = {
  role: {
    personal: 'Personal use',
    employee: 'My work or career',
    leader: 'Leading a team',
    founder: 'Running a business'
  },
  aiStage: {
    new: 'I have barely started',
    exploring: 'I am experimenting',
    regular: 'I use AI most weeks',
    building: 'I am building systems'
  },
  goal: {
    understand: 'Understand AI clearly',
    prompt: 'Get better answers',
    save_time: 'Save time on repeat work',
    automate: 'Automate a process',
    build: 'Build an AI product or assistant',
    safe: 'Use AI safely'
  }
};

function welcomeEmailMarkup(firstName) {
  const siteUrl = publicSiteUrl();
  return `<!doctype html>
  <html><body style="margin:0;background:#050505;color:#e8eef4;font-family:Arial,sans-serif">
    <div style="max-width:620px;margin:auto;padding:34px 24px">
      <div style="font:12px monospace;letter-spacing:2px;color:#2e9bff">CLONE CENTRE // YOU ARE IN</div>
      <h1 style="font-size:30px;margin:18px 0 12px">Your Prompt Guidebook is attached.</h1>
      <p style="line-height:1.65;color:#aeb8c2">Hi ${escapeHtml(firstName)}, welcome to Clone Centre. Your guide includes the CLEAR framework, more than 30 copy-and-paste prompts and the ten mistakes that make AI feel harder than it is.</p>
      <p style="line-height:1.65;color:#aeb8c2">I have also saved the answers you shared so the advice I send is relevant to how you actually use AI.</p>
      <p style="margin:28px 0"><a style="display:inline-block;background:#2e9bff;color:#000;padding:13px 18px;text-decoration:none;font-weight:bold" href="${siteUrl}/library">EXPLORE THE LIBRARY</a></p>
      <div style="margin-top:26px;padding-top:18px;border-top:1px solid #26323e;color:#7f8b96;font-size:13px">You asked to receive Clone Centre updates. Reply with “unsubscribe” at any time and I will remove you.</div>
    </div>
  </body></html>`;
}

function chatTranscriptEmailMarkup({ conversationId, sessionId, page, title, messages }) {
  const rows = messages.map((message) => {
    const visitor = message.role === 'user';
    return `<div style="margin:0 0 12px;padding:12px 14px;border:1px solid ${visitor ? '#2e9bff' : '#263848'};background:${visitor ? '#07192a' : '#070b0f'}">
      <div style="margin-bottom:5px;font:10px monospace;letter-spacing:1.5px;color:${visitor ? '#2e9bff' : '#8292a0'}">${visitor ? 'VISITOR' : 'CLONE CENTRE AI'}</div>
      <div style="white-space:pre-wrap;color:#e1e7ec;font:13px/1.55 Arial,sans-serif">${escapeHtml(message.content)}</div>
    </div>`;
  }).join('');
  return `<!doctype html>
  <html><body style="margin:0;background:#050505;color:#e8eef4;font-family:Arial,sans-serif">
    <div style="max-width:680px;margin:auto;padding:32px 22px">
      <div style="font:11px monospace;letter-spacing:2px;color:#2e9bff">CLONE CENTRE AI // CONVERSATION</div>
      <h1 style="font-size:25px;margin:15px 0 7px">A visitor spoke with Clone Centre AI.</h1>
      <div style="margin-bottom:22px;color:#82909b;font-size:12px;line-height:1.6">
        <div><b style="color:#b9c4cd">Page:</b> ${escapeHtml(title || page)}</div>
        <div><b style="color:#b9c4cd">URL:</b> ${escapeHtml(page)}</div>
        <div><b style="color:#b9c4cd">Conversation:</b> ${escapeHtml(conversationId)} · HyperChat session ${escapeHtml(sessionId)}</div>
      </div>
      ${rows}
      <div style="margin-top:22px;padding-top:15px;border-top:1px solid #26323e;color:#6f7d89;font-size:11px">Sent automatically after the conversation became inactive. The complete session remains available in HyperChat.</div>
    </div>
  </body></html>`;
}

function leadNotificationMarkup(profile) {
  return `<!doctype html>
  <html><body style="font-family:Arial,sans-serif;background:#f3f5f7;color:#101820;margin:0;padding:28px">
    <div style="max-width:620px;margin:auto;background:#fff;border:1px solid #d9e0e7;padding:28px">
      <div style="font:12px monospace;letter-spacing:2px;color:#1676c4">NEW CLONE CENTRE PROFILE</div>
      <h1 style="font-size:28px;margin:16px 0">${escapeHtml(profile.firstName)} requested the Prompt Guidebook.</h1>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:10px;border-bottom:1px solid #e4e8ec;color:#647180">Email</td><td style="padding:10px;border-bottom:1px solid #e4e8ec">${escapeHtml(profile.email)}</td></tr>
        <tr><td style="padding:10px;border-bottom:1px solid #e4e8ec;color:#647180">Context</td><td style="padding:10px;border-bottom:1px solid #e4e8ec">${escapeHtml(profileOptions.role[profile.role])}</td></tr>
        <tr><td style="padding:10px;border-bottom:1px solid #e4e8ec;color:#647180">AI stage</td><td style="padding:10px;border-bottom:1px solid #e4e8ec">${escapeHtml(profileOptions.aiStage[profile.aiStage])}</td></tr>
        <tr><td style="padding:10px;color:#647180">Main goal</td><td style="padding:10px">${escapeHtml(profileOptions.goal[profile.goal])}</td></tr>
      </table>
    </div>
  </body></html>`;
}

async function addNewsletterContact(email, firstName) {
  const segmentId = process.env.RESEND_NEWSLETTER_SEGMENT_ID;
  const createBody = { email, first_name: firstName, unsubscribed: false };
  if (segmentId) createBody.segments = [{ id: segmentId }];

  const created = await resendRequest('/contacts', { body: createBody });
  if (!created.response.ok && created.response.status !== 409) {
    throw new Error(`Resend rejected contact (${created.response.status}): ${created.result.message || created.result.name || 'unknown error'}`);
  }

  if (created.response.status === 409) {
    const updated = await resendRequest(`/contacts/${encodeURIComponent(email)}`, {
      method: 'PATCH',
      body: { first_name: firstName, unsubscribed: false }
    });
    if (!updated.response.ok) {
      throw new Error(`Resend rejected contact update (${updated.response.status}): ${updated.result.message || updated.result.name || 'unknown error'}`);
    }
  }

  if (segmentId) {
    const segmented = await resendRequest(`/contacts/${encodeURIComponent(email)}/segments/${encodeURIComponent(segmentId)}`, {
      body: {}
    });
    if (!segmented.response.ok && segmented.response.status !== 409) {
      throw new Error(`Resend rejected segment assignment (${segmented.response.status}): ${segmented.result.message || segmented.result.name || 'unknown error'}`);
    }
  }
}

async function subscribe(profile) {
  await addNewsletterContact(profile.email, profile.firstName);
  const emailKey = createHash('sha256').update(profile.email).digest('hex').slice(0, 32);
  const guidePath = assertPrivateFile('Clone_Centre_Prompt_Guidebook.pdf');
  const result = await sendResendEmail({
    from: process.env.NEWSLETTER_FROM_EMAIL || 'Joseph at Clone Centre <hello@updates.clonecentre.ai>',
    to: [profile.email],
    reply_to: process.env.DELIVERY_REPLY_TO || 'hello@clonecentre.ai',
    subject: 'Your Clone Centre Prompt Guidebook',
    html: welcomeEmailMarkup(profile.firstName),
    attachments: [{
      filename: 'Clone_Centre_Prompt_Guidebook.pdf',
      content: readFileSync(guidePath).toString('base64')
    }],
    tags: [{ name: 'automation', value: 'guide_delivery' }]
  }, `clonecentre-guide/${emailKey}`);
  const notification = await sendResendEmail({
    from: process.env.NEWSLETTER_FROM_EMAIL || 'Joseph at Clone Centre <hello@updates.clonecentre.ai>',
    to: [process.env.DELIVERY_REPLY_TO || 'hello@clonecentre.ai'],
    reply_to: profile.email,
    subject: `New AI profile — ${profile.firstName} · ${profileOptions.aiStage[profile.aiStage]}`,
    html: leadNotificationMarkup(profile),
    tags: [{ name: 'automation', value: 'lead_profile' }]
  }, `clonecentre-lead/${emailKey}`);
  console.info(JSON.stringify({ type: 'newsletter.subscribed', resend_id: result.id, notification_id: notification.id }));
}

function bookingDetails(payload) {
  const attendee = Array.isArray(payload.attendees) ? payload.attendees.find((person) => person?.email) : null;
  return {
    email: attendee?.email || null,
    name: attendee?.name || 'there',
    title: payload.title || payload.eventTitle || 'your Clone Centre session',
    start: payload.startTime || payload.start || null,
    end: payload.endTime || payload.end || null
  };
}

function readableDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/London'
  }).format(date);
}

function bookingEmailMarkup(trigger, details) {
  const siteUrl = publicSiteUrl();
  const title = escapeHtml(details.title);
  const name = escapeHtml(details.name);
  const when = readableDate(details.start);
  const copy = {
    BOOKING_CREATED: {
      label: 'BOOKING CONFIRMED',
      heading: `You are booked for ${title}.`,
      body: 'Reply to this email with the one problem you most want to solve. Bring any examples, drafts or workflow notes that will help us get straight to useful work.'
    },
    BOOKING_RESCHEDULED: {
      label: 'BOOKING UPDATED',
      heading: `${title} has a new time.`,
      body: 'Your booking has been rescheduled. The calendar invitation contains the latest meeting time and joining link.'
    },
    BOOKING_CANCELLED: {
      label: 'BOOKING CANCELLED',
      heading: `${title} has been cancelled.`,
      body: 'Your booking has been cancelled. If that was not intentional, reply to this email and we will get it sorted.'
    },
    MEETING_ENDED: {
      label: 'SESSION COMPLETE',
      heading: `Keep the momentum from ${title}.`,
      body: 'Write down the next smallest useful action while the session is fresh. If you need another working session, the booking desk is always open.'
    }
  }[trigger];
  if (!copy) return null;
  return `<!doctype html>
  <html><body style="margin:0;background:#050505;color:#e8eef4;font-family:Arial,sans-serif">
    <div style="max-width:620px;margin:auto;padding:34px 24px">
      <div style="font:12px monospace;letter-spacing:2px;color:#2e9bff">CLONE CENTRE // ${copy.label}</div>
      <h1 style="font-size:30px;margin:18px 0 12px">${copy.heading}</h1>
      <p style="line-height:1.65;color:#aeb8c2">Hi ${name},</p>
      <p style="line-height:1.65;color:#aeb8c2">${copy.body}</p>
      ${when ? `<div style="margin:22px 0;border-left:3px solid #2e9bff;padding:12px 16px;background:#0b1117">${escapeHtml(when)} · UK time</div>` : ''}
      <p style="margin:28px 0"><a style="display:inline-block;border:2px solid #2e9bff;color:#2e9bff;padding:11px 16px;text-decoration:none;font-weight:bold" href="${siteUrl}/coaching">VIEW COACHING DESK</a></p>
      <div style="margin-top:26px;padding-top:18px;border-top:1px solid #26323e;color:#7f8b96;font-size:13px">Questions or preparation notes? Reply directly to this email.</div>
    </div>
  </body></html>`;
}

async function sendBookingAutomation(trigger, payload, rawBody) {
  const details = bookingDetails(payload);
  const html = bookingEmailMarkup(trigger, details);
  if (!html || !details.email) return { skipped: html ? 'attendee_email_missing' : 'trigger_ignored' };
  const subjectPrefix = {
    BOOKING_CREATED: 'You are booked',
    BOOKING_RESCHEDULED: 'Your booking has moved',
    BOOKING_CANCELLED: 'Your booking is cancelled',
    MEETING_ENDED: 'Your next step'
  }[trigger];
  const eventKey = createHash('sha256').update(rawBody).digest('hex').slice(0, 32);
  const result = await sendResendEmail({
    from: process.env.BOOKING_FROM_EMAIL || 'Joseph at Clone Centre <hello@updates.clonecentre.ai>',
    to: [details.email],
    reply_to: process.env.DELIVERY_REPLY_TO || 'hello@clonecentre.ai',
    subject: `${subjectPrefix} — ${details.title}`,
    html,
    tags: [{ name: 'automation', value: trigger.toLowerCase() }]
  }, `clonecentre-cal/${eventKey}`);
  console.info(JSON.stringify({ type: 'booking.email_sent', trigger, resend_id: result.id }));
  return { id: result.id, trigger };
}

function calSignatureIsValid(rawBody, providedSignature, secret) {
  if (!providedSignature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const normalizedSignature = providedSignature.trim().replace(/^sha256=/, '');
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(normalizedSignature);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

function subscriptionAllowed(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const recent = (subscribeAttempts.get(ip) || []).filter((attempt) => now - attempt < windowMs);
  if (recent.length >= 8) return false;
  recent.push(now);
  subscribeAttempts.set(ip, recent);
  if (subscribeAttempts.size > 500) {
    for (const [key, attempts] of subscribeAttempts) {
      if (!attempts.some((attempt) => now - attempt < windowMs)) subscribeAttempts.delete(key);
    }
  }
  return true;
}

function chatTranscriptAllowed(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const recent = (chatTranscriptAttempts.get(ip) || []).filter((attempt) => now - attempt < windowMs);
  if (recent.length >= 12) return false;
  recent.push(now);
  chatTranscriptAttempts.set(ip, recent);
  if (chatTranscriptAttempts.size > 1000) {
    for (const [key, attempts] of chatTranscriptAttempts) {
      if (!attempts.some((attempt) => now - attempt < windowMs)) chatTranscriptAttempts.delete(key);
    }
  }
  return true;
}

async function sendDelivery(session) {
  if (session.payment_status !== 'paid') return { skipped: 'payment_not_paid' };
  const email = customerEmail(session);
  if (!email) throw new Error(`Checkout Session ${session.id} has no customer email`);
  const product = resolveProduct(session);
  const attachments = product.files.map((relativePath) => {
    const fullPath = assertPrivateFile(relativePath);
    return { filename: basename(relativePath), content: readFileSync(fullPath).toString('base64') };
  });

  if (dryRun) {
    console.info(JSON.stringify({ type: 'delivery.dry_run', session: session.id, product: product.key, attachment_count: attachments.length }));
    return { id: `dry_run_${session.id}`, product: product.key };
  }

  const result = await sendResendEmail({
    from: process.env.DELIVERY_FROM_EMAIL || 'Clone Centre <books@updates.clonecentre.ai>',
    to: [email],
    reply_to: process.env.DELIVERY_REPLY_TO || 'hello@clonecentre.ai',
    subject: `Your Clone Centre files — ${product.title}`,
    html: emailMarkup(product),
    attachments,
    tags: [{ name: 'catalog_key', value: product.key }]
  }, `clonecentre-pdf/${session.id}`);
  console.info(JSON.stringify({ type: 'delivery.sent', session: session.id, product: product.key, resend_id: result.id }));
  return { id: result.id, product: product.key };
}

app.disable('x-powered-by');
app.enable('strict routing');
if (isProduction) app.set('trust proxy', 1);
app.use((request, response, next) => {
  response.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups'
  });
  next();
});

app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (request, response) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return response.status(503).json({ error: 'fulfillment_not_configured' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(request.body, request.get('stripe-signature'), secret);
  } catch (error) {
    console.warn(JSON.stringify({ type: 'webhook.rejected', reason: error.message }));
    return response.status(400).json({ error: 'invalid_signature' });
  }

  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    return response.status(200).json({ received: true, ignored: event.type });
  }

  try {
    const result = await sendDelivery(event.data.object);
    return response.status(200).json({ received: true, delivery: result });
  } catch (error) {
    console.error(JSON.stringify({ type: 'delivery.failed', event: event.id, session: event.data.object?.id, reason: error.message }));
    return response.status(500).json({ error: 'delivery_failed' });
  }
});

app.post('/api/cal/webhook', express.raw({ type: 'application/json', limit: '256kb' }), async (request, response) => {
  const secret = process.env.CAL_WEBHOOK_SECRET;
  if (!secret) return response.status(503).json({ error: 'booking_automation_not_configured' });
  if (!calSignatureIsValid(request.body, request.get('x-cal-signature-256'), secret)) {
    console.warn(JSON.stringify({ type: 'cal_webhook.rejected', reason: 'invalid_signature' }));
    return response.status(400).json({ error: 'invalid_signature' });
  }

  let event;
  try {
    event = JSON.parse(request.body.toString('utf8'));
  } catch {
    return response.status(400).json({ error: 'invalid_json' });
  }

  const trigger = event.triggerEvent;
  const payload = event.payload || event;
  try {
    const result = await sendBookingAutomation(trigger, payload, request.body);
    return response.status(200).json({ received: true, automation: result });
  } catch (error) {
    console.error(JSON.stringify({ type: 'booking.email_failed', trigger, reason: error.message }));
    return response.status(500).json({ error: 'booking_automation_failed' });
  }
});

app.use(express.json({ limit: '128kb' }));

app.post('/api/subscribe', async (request, response) => {
  if (!subscriptionAllowed(request.ip || 'unknown')) return response.status(429).json({ error: 'too_many_requests' });
  if (request.body?.company) return response.status(200).json({ ok: true });
  const email = String(request.body?.email || '').trim().toLowerCase();
  const firstName = String(request.body?.firstName || '').trim();
  const role = String(request.body?.role || '');
  const aiStage = String(request.body?.aiStage || '');
  const goal = String(request.body?.goal || '');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response.status(400).json({ error: 'valid_email_required' });
  }
  if (firstName.length < 2 || firstName.length > 60) return response.status(400).json({ error: 'valid_name_required' });
  if (!Object.hasOwn(profileOptions.role, role)) return response.status(400).json({ error: 'valid_role_required' });
  if (!Object.hasOwn(profileOptions.aiStage, aiStage)) return response.status(400).json({ error: 'valid_ai_stage_required' });
  if (!Object.hasOwn(profileOptions.goal, goal)) return response.status(400).json({ error: 'valid_goal_required' });
  if (request.body?.consent !== true) return response.status(400).json({ error: 'consent_required' });
  try {
    await subscribe({ email, firstName, role, aiStage, goal });
    return response.status(201).json({ ok: true });
  } catch (error) {
    console.error(JSON.stringify({ type: 'newsletter.failed', reason: error.message }));
    return response.status(502).json({ error: 'signup_temporarily_unavailable' });
  }
});

app.post('/api/chat-transcript', async (request, response) => {
  if (request.get('sec-fetch-site') === 'cross-site') return response.status(403).json({ error: 'cross_site_request_rejected' });
  const conversationId = String(request.body?.conversationId || '').trim();
  const sessionId = String(request.body?.sessionId || '').trim();
  const page = String(request.body?.page || '').trim();
  const title = String(request.body?.title || '').trim();
  const rawMessages = request.body?.messages;
  if (!/^ct_[a-z0-9]{8,80}$/i.test(conversationId)) return response.status(400).json({ error: 'invalid_conversation' });
  if (!/^cc_[a-z0-9]{8,80}$/i.test(sessionId)) return response.status(400).json({ error: 'invalid_session' });
  if (title.length > 200 || page.length > 2000) return response.status(400).json({ error: 'invalid_page' });
  try {
    const pageUrl = new URL(page);
    if (!['http:', 'https:'].includes(pageUrl.protocol)) throw new Error('invalid protocol');
  } catch {
    return response.status(400).json({ error: 'invalid_page' });
  }
  if (!Array.isArray(rawMessages) || rawMessages.length < 2 || rawMessages.length > 40) {
    return response.status(400).json({ error: 'invalid_messages' });
  }
  const messages = [];
  let transcriptLength = 0;
  for (const message of rawMessages) {
    const role = message?.role;
    const content = String(message?.content || '').trim();
    if (!['user', 'assistant'].includes(role) || !content || content.length > 4000) {
      return response.status(400).json({ error: 'invalid_messages' });
    }
    transcriptLength += content.length;
    messages.push({ role, content });
  }
  if (transcriptLength > 100_000 || !messages.some((message) => message.role === 'user')) {
    return response.status(400).json({ error: 'invalid_messages' });
  }
  if (!chatTranscriptAllowed(request.ip || 'unknown')) return response.status(429).json({ error: 'too_many_requests' });

  const userTurns = messages.filter((message) => message.role === 'user').length;
  const eventKey = createHash('sha256').update(`${conversationId}:${userTurns}`).digest('hex').slice(0, 32);
  let pageLabel = title || 'Clone Centre website';
  try {
    const pageUrl = new URL(page);
    pageLabel = `${title || 'Clone Centre'} · ${pageUrl.pathname}`;
  } catch {}
  try {
    const result = await sendResendEmail({
      from: process.env.CHAT_TRANSCRIPTS_FROM_EMAIL || process.env.BOOKING_FROM_EMAIL || 'Clone Centre AI <hello@updates.clonecentre.ai>',
      to: [process.env.CHAT_TRANSCRIPTS_EMAIL || process.env.DELIVERY_REPLY_TO || 'hello@clonecentre.ai'],
      reply_to: process.env.DELIVERY_REPLY_TO || 'hello@clonecentre.ai',
      subject: `Clone Centre AI chat — ${pageLabel.slice(0, 120)}`,
      html: chatTranscriptEmailMarkup({ conversationId, sessionId, page, title, messages }),
      tags: [{ name: 'automation', value: 'chat_transcript' }]
    }, `clonecentre-chat/${eventKey}`);
    console.info(JSON.stringify({ type: 'chat_transcript.sent', conversation: conversationId, user_turns: userTurns, resend_id: result.id }));
    return response.status(202).json({ ok: true });
  } catch (error) {
    console.error(JSON.stringify({ type: 'chat_transcript.failed', conversation: conversationId, reason: error.message }));
    return response.status(502).json({ error: 'transcript_delivery_unavailable' });
  }
});

app.get('/api/site-config', (_request, response) => {
  response.set('Cache-Control', 'public, max-age=300');
  response.json({
    booking: {
      profile: process.env.CAL_PROFILE_URL || null,
      aiFix: process.env.CAL_AI_FIX_URL || null,
      aiPower: process.env.CAL_AI_POWER_URL || null,
      buildPartner: process.env.CAL_BUILD_PARTNER_URL || null
    }
  });
});

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    service: 'clonecentre-site',
    catalog_products: Object.keys(catalog.products).length,
    paid_assets_available: Object.values(catalog.products).every((product) => product.files.every((file) => {
      try { return statSync(assertPrivateFile(file)).isFile(); } catch { return false; }
    })),
    delivery_configured: Boolean(process.env.STRIPE_WEBHOOK_SECRET && process.env.RESEND_API_KEY),
    newsletter_configured: Boolean(process.env.RESEND_API_KEY),
    chat_transcripts_configured: Boolean(process.env.RESEND_API_KEY && (process.env.CHAT_TRANSCRIPTS_EMAIL || process.env.DELIVERY_REPLY_TO)),
    booking_links_configured: Boolean(process.env.CAL_PROFILE_URL && process.env.CAL_AI_FIX_URL && process.env.CAL_AI_POWER_URL && process.env.CAL_BUILD_PARTNER_URL),
    booking_automation_configured: Boolean(process.env.CAL_WEBHOOK_SECRET && process.env.RESEND_API_KEY),
    delivery_mode: dryRun ? 'dry_run' : 'live'
  });
});

function sendHtml(response, filename, status = 200) {
  response.status(status).set('Cache-Control', 'no-cache, no-store, must-revalidate');
  return response.sendFile(join(publicDir, filename));
}

app.get('/', (_request, response) => sendHtml(response, 'index.html'));
for (const page of ['about', 'community', 'coaching', 'library', 'products']) {
  app.get(`/${page}/`, (_request, response) => response.redirect(308, `/${page}`));
  app.get(`/${page}`, (_request, response) => sendHtml(response, 'index.html'));
}
app.get('/order-complete', (_request, response) => sendHtml(response, 'order-complete.html'));
app.use('/books/Clone_Centre_Prompt_Guidebook.pdf', (_request, response) => response.status(404).json({ error: 'guide_request_required' }));
app.use('/books/paid', (_request, response) => response.status(404).json({ error: 'not_found' }));
app.use(express.static(publicDir, {
  index: false,
  maxAge: isProduction ? '7d' : 0,
  setHeaders(response, filePath) {
    if (filePath.endsWith('.html')) response.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));
app.use((_request, response) => sendHtml(response, 'index.html', 404));

const server = app.listen(port, () => {
  console.info(JSON.stringify({ type: 'server.started', port, dry_run: dryRun, catalog_products: Object.keys(catalog.products).length }));
});

function stop(signal) {
  console.info(JSON.stringify({ type: 'server.stopping', signal }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
