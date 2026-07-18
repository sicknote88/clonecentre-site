import express from 'express';
import Stripe from 'stripe';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemberStore, createOpaqueToken, hashPassword, verifyPassword } from './member-store.js';
import { brandEmail, completeEmailMessage, emailCallout, emailDetailTable, emailSteps } from './email-templates.js';

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
const memberInterestAttempts = new Map();
const accountAttempts = new Map();
const hyperChatBaseUrl = (process.env.HYPERCHAT_BASE_URL || 'https://hyperchat-app-production.up.railway.app').replace(/\/$/, '');
const hyperChatProjectId = process.env.HYPERCHAT_PROJECT_ID || '96991323-4ffc-47a7-99bd-905af714a0d5';
const memberStore = createMemberStore(process.env.DATABASE_URL);
let memberStoreError = null;
if (memberStore.enabled) {
  try {
    await memberStore.init();
    console.info(JSON.stringify({ type: 'member_store.ready' }));
  } catch (error) {
    memberStoreError = error.message;
    console.error(JSON.stringify({ type: 'member_store.init_failed', reason: error.message }));
  }
}

async function ensureMemberStore() {
  if (!memberStore.enabled) return false;
  if (memberStore.ready) return true;
  try {
    await memberStore.init();
    memberStoreError = null;
    return true;
  } catch (error) {
    memberStoreError = error.message;
    return false;
  }
}

const memberOptions = {
  interest: {
    community_monthly: 'Community monthly — £19/month',
    community_annual: 'Community annual — £190/year',
    pro_monthly: 'Pro monthly — £49/month',
    pro_annual: 'Pro annual plus included website chatbot setup — £490/year',
    accountability_monthly: 'Accountability monthly — £149/month',
    accountability_annual: 'Accountability annual — £1,490/year',
    switch_community: 'Switch to Community — £1 first month, then £19/month',
    switch_pro: 'Switch to Pro — £1 first month, then £49/month',
    clone_coach_waitlist: 'Clone Coach AI beta waitlist',
    custom_coach_bot: 'A custom AI coach built for my needs',
    help_choose: 'Help me choose'
  },
  aiStage: {
    new: 'I have barely started',
    exploring: 'I am experimenting',
    regular: 'I use AI most weeks',
    building: 'I am already building systems'
  },
  aiUse: {
    clarity: 'Understand AI clearly',
    productivity: 'Save time or improve my work',
    growth: 'Grow a business',
    automation: 'Automate a process',
    assistant: 'Build an AI assistant',
    governance: 'Use AI safely and govern it'
  }
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[character]);
}

function proofFileMatchesType(buffer, type) {
  if (type === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (type === 'image/png') return buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (type === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (type === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function publicSiteUrl() {
  return (process.env.SITE_URL || 'https://clonecentre-site-production.up.railway.app').replace(/\/$/, '');
}

function cookieValue(request, name) {
  const source = request.get('cookie') || '';
  for (const part of source.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function sessionCookie(token, maxAge = 30 * 24 * 60 * 60) {
  const secure = isProduction ? '; Secure' : '';
  return `cc_session=${encodeURIComponent(token || '')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function requestIpHash(request) {
  return createHash('sha256').update(String(request.ip || 'unknown')).digest('hex');
}

function accountAllowed(ip, action, limit = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const key = `${ip}:${action}`;
  const recent = (accountAttempts.get(key) || []).filter((attempt) => now - attempt < windowMs);
  if (recent.length >= limit) return false;
  recent.push(now);
  accountAttempts.set(key, recent);
  if (accountAttempts.size > 2000) {
    for (const [attemptKey, attempts] of accountAttempts) {
      if (!attempts.some((attempt) => now - attempt < windowMs)) accountAttempts.delete(attemptKey);
    }
  }
  return true;
}

function validAccountPassword(password) {
  return typeof password === 'string' && password.length >= 10 && password.length <= 200;
}

async function requestMember(request) {
  if (!memberStore.ready) return null;
  return memberStore.memberForToken(cookieValue(request, 'cc_session'));
}

function rejectCrossSite(request, response) {
  if (request.get('sec-fetch-site') === 'cross-site') {
    response.status(403).json({ error: 'cross_site_request_rejected' });
    return true;
  }
  return false;
}

async function persistHyperChatLead({ sessionId, name, email, company, enquiry, sourceUrl }) {
  const result = await fetch(`${hyperChatBaseUrl}/api/leads/${hyperChatProjectId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      name,
      email,
      company: company || null,
      enquiry,
      source_url: sourceUrl,
      consent: true
    })
  });
  const body = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(`HyperChat rejected lead (${result.status}): ${body.detail || body.error || 'unknown error'}`);
  return body;
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
  const { response, result } = await resendRequest('/emails', { body: completeEmailMessage(message), idempotencyKey });
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

function membershipTierFromSession(session) {
  return session.metadata?.membership_tier || catalog.membershipLinks?.[session.payment_link] || null;
}

function customerEmail(session) {
  return session.customer_details?.email || session.customer_email || null;
}

function emailMarkup(product) {
  const count = product.files.length;
  const attachmentLabel = count === 1 ? '1 private file attached' : `${count} private files attached`;
  return brandEmail({
    siteUrl: publicSiteUrl(),
    preheader: `${product.title} is attached and ready to use.`,
    eyebrow: 'PURCHASE COMPLETE // FILES DELIVERED',
    heading: 'Your Clone Centre library just landed.',
    lead: `Your ${product.title} purchase is complete. Everything included is attached to this email and ready to save.`,
    content: `${emailCallout('DELIVERY STATUS', attachmentLabel, 'Keep this email somewhere safe so your files are easy to find.')}
      ${emailSteps([
        'Download the attached files to a folder you will remember.',
        'Open the guide that solves the problem in front of you today.',
        'Reply to this email if you want Joseph to point you to the right starting page.'
      ])}
      <p style="margin:12px 0 0;color:#7f91a1;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6">Your purchase is licensed for your personal use. Please do not redistribute the files or publish private download copies.</p>`,
    action: `${publicSiteUrl()}/library`,
    actionLabel: 'EXPLORE THE LIBRARY',
    secondaryAction: `${publicSiteUrl()}/member`,
    secondaryActionLabel: 'OPEN MEMBER CENTRE',
    footer: 'Purchase receipt and private file delivery from Clone Centre. Questions? Reply directly to this email.'
  });
}

function membershipPaymentMarkup(name, tier) {
  const label = tier === 'accountability' ? 'Accountability' : tier === 'pro' ? 'Pro' : 'Community';
  const access = {
    Community: 'Member chat, the Plain English AI library, weekly prompts and accountability drops.',
    Pro: 'Everything in Community plus Joseph’s live AI Lab, build sessions, office hours and the recordings vault.',
    Accountability: 'Everything in Pro plus personal check-ins, private reviews and your 90-day goal tracker.'
  }[label];
  return brandEmail({
    siteUrl: publicSiteUrl(),
    preheader: `Stripe confirmed your Clone Centre ${label} membership.`,
    eyebrow: 'MEMBERSHIP ACTIVE // WELCOME IN',
    heading: `Welcome to Clone Centre ${label}.`,
    lead: `Hi ${name || 'there'}, your payment is confirmed and your membership journey starts now.`,
    content: `${emailCallout('YOUR MEMBERSHIP', label, access)}
      ${emailSteps([
        'Create your Member Centre account or sign in.',
        'Use the same email address you entered at Stripe so access connects automatically.',
        'Complete your AI profile and choose the first thing you want to build.'
      ])}`,
    action: `${publicSiteUrl()}/member`,
    actionLabel: 'ENTER THE MEMBER CENTRE',
    secondaryAction: `${publicSiteUrl()}/community`,
    secondaryActionLabel: 'SEE YOUR MEMBERSHIP',
    footer: 'Your membership is managed securely by Stripe. Reply directly if your access does not connect or you need a human.'
  });
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
  return brandEmail({
    siteUrl,
    preheader: 'Your Prompt Guidebook is attached. Start with the CLEAR framework.',
    eyebrow: 'YOUR AI STARTING POINT // ATTACHED',
    heading: 'Make AI useful from the very next prompt.',
    lead: `Hi ${firstName}, your Clone Centre Prompt Guidebook is attached. It is built to get you from vague instructions to work you can actually use.`,
    content: `${emailDetailTable([
      ['Inside', 'The CLEAR prompting framework'],
      ['Use immediately', '30+ copy-and-paste prompts'],
      ['Avoid', 'The 10 mistakes that make AI harder than it needs to be']
    ])}
      ${emailCallout('YOUR PROFILE IS SAVED', 'You will not need to start from zero.', 'The answers you shared help Clone Centre make future guidance relevant to how you actually use AI.')}`,
    action: `${siteUrl}/library`,
    actionLabel: 'EXPLORE THE AI LIBRARY',
    secondaryAction: `${siteUrl}/member`,
    secondaryActionLabel: 'CREATE MY MEMBER PROFILE',
    footer: 'You requested the Prompt Guidebook and practical Clone Centre updates. Reply with “unsubscribe” at any time and you will be removed.'
  });
}

function chatTranscriptEmailMarkup({ conversationId, sessionId, page, title, messages }) {
  const rows = messages.map((message) => {
    const visitor = message.role === 'user';
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 10px;border:1px solid ${visitor ? '#2e9bff' : '#1d3448'};background:${visitor ? '#061827' : '#060b10'}"><tr><td style="padding:13px 15px">
      <div style="margin-bottom:6px;color:${visitor ? '#2e9bff' : '#8292a0'};font-family:'Courier New',Courier,monospace;font-size:9px;font-weight:700;letter-spacing:1.5px">${visitor ? 'VISITOR' : 'CLONE CENTRE AI'}</div>
      <div style="white-space:pre-wrap;color:#e1e7ec;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6">${escapeHtml(message.content)}</div>
    </td></tr></table>`;
  }).join('');
  return brandEmail({
    siteUrl: publicSiteUrl(),
    preheader: `New Clone Centre AI conversation on ${title || page}.`,
    eyebrow: 'CLONE CENTRE AI // CONVERSATION CAPTURED',
    heading: 'A visitor spoke with Clone Centre AI.',
    lead: 'The useful context is below, ready for follow-up without losing the thread.',
    content: `${emailDetailTable([
      ['Page', title || page],
      ['URL', page],
      ['Conversation', conversationId],
      ['HyperChat session', sessionId]
    ])}${rows}`,
    footer: 'Sent automatically after the conversation became inactive. The complete session remains available in HyperChat and its Railway-backed records.',
    internal: true,
    wide: true
  });
}

function leadNotificationMarkup(profile) {
  return brandEmail({
    siteUrl: publicSiteUrl(),
    preheader: `${profile.firstName} requested the Prompt Guidebook.`,
    eyebrow: 'NEW GUIDE PROFILE // FOLLOW-UP READY',
    heading: `${profile.firstName} requested the Prompt Guidebook.`,
    lead: 'Their consented AI starting point is stored and ready to make future contact relevant.',
    content: emailDetailTable([
      ['Email', profile.email],
      ['Context', profileOptions.role[profile.role]],
      ['AI stage', profileOptions.aiStage[profile.aiStage]],
      ['Main goal', profileOptions.goal[profile.goal]],
      ['Session', profile.sessionId]
    ]),
    action: `mailto:${profile.email}`,
    actionLabel: 'REPLY TO THIS LEAD',
    footer: 'Private Clone Centre lead notification. Consent and source details are stored in Railway.',
    internal: true
  });
}

function memberNotificationMarkup(profile) {
  const details = [
    ['Email', profile.email],
    ['Interest', memberOptions.interest[profile.interest] || profile.interest],
    ['Company / website', profile.company || 'Not provided'],
    ['AI stage', memberOptions.aiStage[profile.aiStage]],
    ['Main AI use', memberOptions.aiUse[profile.aiUse]],
    ['Session', profile.sessionId],
    ['Source', profile.page]
  ];
  if (profile.currentCommunity) {
    details.push(
      ['Current paid community', profile.currentCommunity],
      ['Community website', profile.currentMembershipUrl || 'Not provided'],
      ['Proof', profile.proofFile?.name ? `${profile.proofFile.name} · attached and stored` : 'Not supplied']
    );
  }
  return brandEmail({
    siteUrl: publicSiteUrl(),
    preheader: `${profile.name} submitted a Clone Centre enquiry.`,
    eyebrow: profile.currentCommunity ? '£1 SWITCH CHECK // REVIEW REQUIRED' : 'NEW MEMBER ENQUIRY // ACTION READY',
    heading: `${profile.name} chose ${memberOptions.interest[profile.interest] || profile.interest}.`,
    lead: profile.currentCommunity ? 'Review the attached proof before issuing any private £1 checkout link.' : 'Their brief is captured below so the next reply can be specific and useful.',
    content: `${emailDetailTable(details)}${emailCallout('THE OUTCOME THEY WANT', profile.goal, 'Reply directly to this email to continue the conversation.')}`,
    action: `mailto:${profile.email}`,
    actionLabel: 'REPLY TO THIS ENQUIRY',
    footer: 'The visitor explicitly consented to storage and follow-up. Railway holds the master member record and links the HyperChat session when available.',
    internal: true,
    wide: true
  });
}

function memberAcknowledgementMarkup(profile) {
  const siteUrl = publicSiteUrl();
  const isSwitch = profile.interest === 'switch_community' || profile.interest === 'switch_pro';
  return brandEmail({
    siteUrl,
    preheader: isSwitch ? 'Your £1 switch evidence is safely stored for review.' : 'Your Clone Centre brief is saved.',
    eyebrow: isSwitch ? 'SWITCH CHECK RECEIVED // REVIEW PENDING' : 'PROFILE SAVED // NEXT STEP READY',
    heading: isSwitch ? `Thanks, ${profile.name}. Your evidence is in review.` : `Thanks, ${profile.name}. You will not need to repeat yourself.`,
    lead: isSwitch
      ? 'No payment has been taken. Joseph will review the active membership proof and send the private £1 Stripe link only if the offer is eligible.'
      : `Your interest in ${memberOptions.interest[profile.interest]} and the outcome you want are now safely captured.`,
    content: `${emailDetailTable([
      ['Your route', memberOptions.interest[profile.interest]],
      ['Where you are', memberOptions.aiStage[profile.aiStage]],
      ['Main AI use', memberOptions.aiUse[profile.aiUse]],
      ...(isSwitch ? [['Evidence', profile.proofFile?.name || 'Stored securely']] : [])
    ])}${emailCallout('YOUR BRIEF', profile.goal, isSwitch ? 'You will receive a personal eligibility response rather than a generic checkout link.' : 'Joseph can now reply with the most relevant next step.')}`,
    action: `${siteUrl}/community`,
    actionLabel: 'RETURN TO THE COMMUNITY',
    secondaryAction: `${siteUrl}/member`,
    secondaryActionLabel: 'OPEN MEMBER CENTRE',
    footer: 'Replies come from joseph@clonecentre.ai or clone@clonecentre.ai. Reply directly if anything in your brief needs correcting.'
  });
}

function memberAcknowledgementSubject(profile) {
  return profile.interest === 'switch_community' || profile.interest === 'switch_pro'
    ? 'Your £1 switch check is safely in review'
    : 'We saved your Clone Centre brief';
}

function accountActionEmailMarkup({ name, heading, body, action, actionLabel, footer, internal = false }) {
  return brandEmail({
    siteUrl: publicSiteUrl(),
    preheader: body,
    eyebrow: internal ? 'MEMBER ADMIN // ACTION REQUIRED' : 'MEMBER ACCOUNT // SECURE ACTION',
    heading,
    lead: internal ? body : `Hi ${name || 'there'}, ${body}`,
    content: action
      ? emailCallout('SECURE LINK', 'Use the button below to continue.', 'Clone Centre will never ask you to email your password or payment details.')
      : emailCallout('REQUEST RECORDED', name || 'Member account', body),
    action,
    actionLabel,
    footer: footer || 'If you did not request this, you can safely ignore this email.',
    internal
  });
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
    reply_to: process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai',
    subject: 'Your Prompt Guidebook is here — start with CLEAR',
    html: welcomeEmailMarkup(profile.firstName),
    headers: { 'List-Unsubscribe': '<mailto:joseph@clonecentre.ai?subject=Unsubscribe%20from%20Clone%20Centre>' },
    attachments: [{
      filename: 'Clone_Centre_Prompt_Guidebook.pdf',
      content: readFileSync(guidePath).toString('base64')
    }],
    tags: [{ name: 'automation', value: 'guide_delivery' }]
  }, `clonecentre-guide/${emailKey}`);
  const notification = await sendResendEmail({
    from: process.env.NEWSLETTER_FROM_EMAIL || 'Joseph at Clone Centre <hello@updates.clonecentre.ai>',
    to: [process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai'],
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
  const title = details.title;
  const name = details.name;
  const when = readableDate(details.start);
  const copy = {
    BOOKING_CREATED: {
      label: 'BOOKING CONFIRMED',
      heading: `You are booked for ${title}.`,
      body: `Hi ${name}, the time is in the diary. Reply with the one problem you most want to solve so we can get straight to useful work.`,
      status: 'CONFIRMED'
    },
    BOOKING_RESCHEDULED: {
      label: 'BOOKING UPDATED',
      heading: `${title} has a new time.`,
      body: `Hi ${name}, your booking has been rescheduled. The calendar invitation contains the latest meeting time and joining link.`,
      status: 'UPDATED'
    },
    BOOKING_CANCELLED: {
      label: 'BOOKING CANCELLED',
      heading: `${title} has been cancelled.`,
      body: `Hi ${name}, the booking is cancelled. If that was not intentional, reply and we will get it sorted.`,
      status: 'CANCELLED'
    },
    MEETING_ENDED: {
      label: 'SESSION COMPLETE',
      heading: `Keep the momentum from ${title}.`,
      body: `Hi ${name}, write down the next smallest useful action while the session is fresh. Progress beats a perfect plan.`,
      status: 'COMPLETE'
    }
  }[trigger];
  if (!copy) return null;
  const preparation = trigger === 'BOOKING_CREATED'
    ? emailSteps([
      'Reply with the one outcome that would make the session worthwhile.',
      'Bring any examples, drafts, prompts or workflow notes we should see.',
      'Join from somewhere you can share your screen and build.'
    ])
    : '';
  return brandEmail({
    siteUrl,
    preheader: when ? `${copy.status}: ${title} · ${when} UK time.` : `${copy.status}: ${title}.`,
    eyebrow: `${copy.label} // UK TIME`,
    heading: copy.heading,
    lead: copy.body,
    content: `${emailCallout('SESSION STATUS', copy.status, when ? `${when} · UK time` : 'See the calendar invitation for the latest details.')}${preparation}`,
    action: `${siteUrl}/coaching`,
    actionLabel: trigger === 'BOOKING_CANCELLED' ? 'BOOK ANOTHER SESSION' : 'VIEW THE COACHING DESK',
    secondaryAction: `${siteUrl}/member`,
    secondaryActionLabel: 'OPEN MEMBER CENTRE',
    footer: 'Questions, changes or preparation notes? Reply directly to this email and they will reach Joseph.'
  });
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
    reply_to: process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai',
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

function memberInterestAllowed(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const recent = (memberInterestAttempts.get(ip) || []).filter((attempt) => now - attempt < windowMs);
  if (recent.length >= 8) return false;
  recent.push(now);
  memberInterestAttempts.set(ip, recent);
  if (memberInterestAttempts.size > 1000) {
    for (const [key, attempts] of memberInterestAttempts) {
      if (!attempts.some((attempt) => now - attempt < windowMs)) memberInterestAttempts.delete(key);
    }
  }
  return true;
}

async function sendDelivery(session) {
  if (session.payment_status !== 'paid') return { skipped: 'payment_not_paid' };
  const email = customerEmail(session);
  if (!email) throw new Error(`Checkout Session ${session.id} has no customer email`);
  const membershipTier = membershipTierFromSession(session);
  if (membershipTier) {
    if (dryRun) return { id: `dry_run_${session.id}`, membership: membershipTier };
    const result = await sendResendEmail({
      from: process.env.MEMBER_FROM_EMAIL || 'Joseph at Clone Centre <hello@updates.clonecentre.ai>',
      to: [email],
      reply_to: process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai',
      subject: `You’re in — welcome to Clone Centre ${membershipTier === 'accountability' ? 'Accountability' : membershipTier === 'pro' ? 'Pro' : 'Community'}`,
      html: membershipPaymentMarkup(session.customer_details?.name, membershipTier),
      tags: [{ name: 'automation', value: 'membership_welcome' }]
    }, `clonecentre-membership/${session.id}`);
    return { id: result.id, membership: membershipTier };
  }
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
    reply_to: process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai',
    subject: `Your ${product.title} files are ready`,
    html: emailMarkup(product),
    attachments,
    tags: [{ name: 'catalog_key', value: product.key }]
  }, `clonecentre-pdf/${session.id}`);
  console.info(JSON.stringify({ type: 'delivery.sent', session: session.id, product: product.key, resend_id: result.id }));
  return { id: result.id, product: product.key };
}

async function deliverOutboxItem(item) {
  const payload = item.payload || {};
  const from = process.env.MEMBER_FROM_EMAIL || process.env.NEWSLETTER_FROM_EMAIL || 'Joseph at Clone Centre <hello@updates.clonecentre.ai>';
  if (item.kind === 'account_verify') {
    return sendResendEmail({
      from,
      to: [payload.email],
      reply_to: process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai',
      subject: 'One click to confirm your Clone Centre account',
      html: accountActionEmailMarkup({
        name: payload.name,
        heading: 'Confirm your member account.',
        body: 'Your account and AI profile are safely stored. Confirm this email address to finish connecting your member identity.',
        action: `${publicSiteUrl()}/verify-email?token=${encodeURIComponent(payload.token)}`,
        actionLabel: 'CONFIRM MY ACCOUNT',
        footer: 'This link expires after 24 hours. If you did not create the account, no action is needed.'
      }),
      tags: [{ name: 'automation', value: 'account_verify' }]
    }, item.idempotency_key);
  }
  if (item.kind === 'password_reset') {
    return sendResendEmail({
      from,
      to: [payload.email],
      reply_to: process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai',
      subject: 'Your secure Clone Centre password reset',
      html: accountActionEmailMarkup({
        name: payload.name,
        heading: 'Reset your password.',
        body: 'Use the secure link below to choose a new password for your Clone Centre member account.',
        action: `${publicSiteUrl()}/member?reset=${encodeURIComponent(payload.token)}`,
        actionLabel: 'RESET MY PASSWORD',
        footer: 'This link expires after one hour and can only be used once.'
      }),
      tags: [{ name: 'automation', value: 'password_reset' }]
    }, item.idempotency_key);
  }
  if (item.kind === 'member_notification') {
    const attachments = payload.proofFile?.data ? [{ filename: payload.proofFile.name, content: payload.proofFile.data }] : undefined;
    return sendResendEmail({
      from,
      to: [process.env.MEMBER_NOTIFICATIONS_EMAIL || process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai'],
      reply_to: payload.email,
      subject: `Clone Centre enquiry — ${memberOptions.interest[payload.interest] || payload.interest} · ${payload.name}`.slice(0, 190),
      html: memberNotificationMarkup(payload),
      attachments,
      tags: [{ name: 'automation', value: 'member_interest' }]
    }, item.idempotency_key);
  }
  if (item.kind === 'member_acknowledgement') {
    return sendResendEmail({
      from,
      to: [payload.email],
      reply_to: process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai',
      subject: memberAcknowledgementSubject(payload),
      html: memberAcknowledgementMarkup(payload),
      tags: [{ name: 'automation', value: 'member_acknowledgement' }]
    }, item.idempotency_key);
  }
  if (item.kind === 'guide_profile') return subscribe(payload);
  if (item.kind === 'chat_transcript') {
    const pageLabel = `${payload.title || 'Clone Centre'} · ${new URL(payload.page).pathname}`;
    return sendResendEmail({
      from: process.env.CHAT_TRANSCRIPTS_FROM_EMAIL || process.env.BOOKING_FROM_EMAIL || 'Clone Centre AI <hello@updates.clonecentre.ai>',
      to: [process.env.CHAT_TRANSCRIPTS_EMAIL || process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai'],
      reply_to: process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai',
      subject: `Clone Centre AI chat — ${pageLabel.slice(0, 120)}`,
      html: chatTranscriptEmailMarkup(payload),
      tags: [{ name: 'automation', value: 'chat_transcript' }]
    }, item.idempotency_key);
  }
  if (item.kind === 'booking') return sendBookingAutomation(payload.trigger, payload.payload, JSON.stringify(payload.event));
  if (item.kind === 'stripe_delivery') return sendDelivery(payload.session);
  if (item.kind === 'deletion_request') {
    return sendResendEmail({
      from,
      to: [process.env.MEMBER_NOTIFICATIONS_EMAIL || process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai'],
      reply_to: payload.email,
      subject: `Account deletion request — ${payload.email}`,
      html: accountActionEmailMarkup({ name: 'Joseph', heading: 'A member requested account deletion.', body: `Review deletion request ${payload.requestId} for ${payload.email}. The request and audit event are stored in Railway.`, footer: 'Complete the request from the Railway-backed member administration workflow.', internal: true }),
      tags: [{ name: 'automation', value: 'deletion_request' }]
    }, item.idempotency_key);
  }
  throw new Error(`Unknown outbox kind: ${item.kind}`);
}

let outboxRunning = false;
async function processEmailOutbox() {
  if (!memberStore.ready || outboxRunning) return;
  outboxRunning = true;
  try {
    const items = await memberStore.claimOutbox(8);
    for (const item of items) {
      try {
        await deliverOutboxItem(item);
        await memberStore.completeOutbox(item.id);
        console.info(JSON.stringify({ type: 'outbox.sent', kind: item.kind, id: item.id }));
      } catch (error) {
        await memberStore.failOutbox(item.id, item.attempts, error.message);
        console.error(JSON.stringify({ type: 'outbox.retry_scheduled', kind: item.kind, id: item.id, reason: error.message }));
      }
    }
  } finally {
    outboxRunning = false;
  }
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

  if (memberStore.ready) {
    try {
      const session = event.data.object;
      const membershipTier = membershipTierFromSession(session);
      if (membershipTier) session.metadata = { ...(session.metadata || {}), membership_tier: membershipTier };
      const product = membershipTier ? null : resolveProduct(session);
      await memberStore.recordPurchase(session, product?.key || null);
    } catch (error) {
      console.error(JSON.stringify({ type: 'purchase.storage_failed', event: event.id, reason: error.message }));
    }
  }
  try {
    const result = await sendDelivery(event.data.object);
    return response.status(200).json({ received: true, delivery: result });
  } catch (error) {
    console.error(JSON.stringify({ type: 'delivery.failed', event: event.id, session: event.data.object?.id, reason: error.message }));
    if (memberStore.ready) {
      await memberStore.queueOutbox('stripe_delivery', customerEmail(event.data.object), { session: event.data.object }, `stripe-delivery/${event.data.object.id}`);
      void processEmailOutbox();
      return response.status(202).json({ received: true, delivery: { queued: true } });
    }
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
  if (memberStore.ready) {
    try { await memberStore.recordBooking(trigger, payload); }
    catch (error) { console.error(JSON.stringify({ type: 'booking.storage_failed', trigger, reason: error.message })); }
  }
  try {
    const result = await sendBookingAutomation(trigger, payload, request.body);
    return response.status(200).json({ received: true, automation: result });
  } catch (error) {
    console.error(JSON.stringify({ type: 'booking.email_failed', trigger, reason: error.message }));
    if (memberStore.ready) {
      const eventKey = createHash('sha256').update(request.body).digest('hex').slice(0, 32);
      await memberStore.queueOutbox('booking', bookingDetails(payload).email, { trigger, payload, event }, `booking/${eventKey}`);
      void processEmailOutbox();
      return response.status(202).json({ received: true, automation: { queued: true } });
    }
    return response.status(500).json({ error: 'booking_automation_failed' });
  }
});

app.use('/api/member-interest', express.json({ limit: '5mb' }));
app.use(express.json({ limit: '128kb' }));

app.post('/api/account/register', async (request, response) => {
  if (rejectCrossSite(request, response)) return;
  if (!accountAllowed(request.ip || 'unknown', 'register', 6, 60 * 60 * 1000)) return response.status(429).json({ error: 'too_many_requests' });
  if (!await ensureMemberStore()) return response.status(503).json({ error: 'member_database_unavailable' });
  if (request.body?.fax) return response.status(200).json({ ok: true });
  const name = String(request.body?.name || '').trim();
  const email = String(request.body?.email || '').trim().toLowerCase();
  const password = request.body?.password;
  const company = String(request.body?.company || '').trim();
  const aiStage = String(request.body?.aiStage || '');
  const aiUse = String(request.body?.aiUse || '');
  const goal = String(request.body?.goal || '').trim();
  const sourceUrl = String(request.body?.sourceUrl || `${publicSiteUrl()}/member`).trim();
  const hyperchatSessionId = String(request.body?.hyperchatSessionId || '').trim();
  if (name.length < 2 || name.length > 80) return response.status(400).json({ error: 'valid_name_required' });
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ error: 'valid_email_required' });
  if (!validAccountPassword(password)) return response.status(400).json({ error: 'strong_password_required' });
  if (company.length > 160) return response.status(400).json({ error: 'valid_company_required' });
  if (!Object.hasOwn(memberOptions.aiStage, aiStage)) return response.status(400).json({ error: 'valid_ai_stage_required' });
  if (!Object.hasOwn(memberOptions.aiUse, aiUse)) return response.status(400).json({ error: 'valid_ai_use_required' });
  if (goal.length < 5 || goal.length > 1500) return response.status(400).json({ error: 'valid_goal_required' });
  if (request.body?.consent !== true) return response.status(400).json({ error: 'consent_required' });
  if (hyperchatSessionId && !/^cc_[a-z0-9]{8,120}$/i.test(hyperchatSessionId)) return response.status(400).json({ error: 'valid_chat_session_required' });
  try {
    const passwordHash = await hashPassword(password);
    const sessionToken = createOpaqueToken();
    const verificationToken = createOpaqueToken();
    const member = await memberStore.createAccount({
      name,
      email,
      passwordHash,
      company,
      aiStage,
      aiUse,
      goal,
      consentText: 'I agree that Clone Centre may store my member profile and account data to provide the services I request.',
      sourceUrl,
      hyperchatSessionId: hyperchatSessionId || null,
      sessionToken,
      verificationToken,
      ipHash: requestIpHash(request),
      userAgent: String(request.get('user-agent') || '').slice(0, 500)
    });
    response.append('Set-Cookie', sessionCookie(sessionToken));
    void processEmailOutbox();
    return response.status(201).json({ ok: true, member, emailQueued: true });
  } catch (error) {
    if (error.code === '23505') return response.status(409).json({ error: 'account_already_exists' });
    console.error(JSON.stringify({ type: 'account.register_failed', reason: error.message }));
    return response.status(500).json({ error: 'account_creation_failed' });
  }
});

app.post('/api/account/login', async (request, response) => {
  if (rejectCrossSite(request, response)) return;
  if (!accountAllowed(request.ip || 'unknown', 'login', 12, 15 * 60 * 1000)) return response.status(429).json({ error: 'too_many_requests' });
  if (!await ensureMemberStore()) return response.status(503).json({ error: 'member_database_unavailable' });
  const email = String(request.body?.email || '').trim().toLowerCase();
  const password = request.body?.password;
  if (!email || typeof password !== 'string') return response.status(400).json({ error: 'credentials_required' });
  try {
    const user = await memberStore.userForLogin(email);
    const valid = user ? await verifyPassword(password, user.password_hash) : false;
    if (!valid) return response.status(401).json({ error: 'invalid_credentials' });
    const token = createOpaqueToken();
    await memberStore.createSession({ userId: user.id, token, ipHash: requestIpHash(request), userAgent: String(request.get('user-agent') || '').slice(0, 500) });
    response.append('Set-Cookie', sessionCookie(token));
    return response.json({ ok: true, member: { id: user.id, email: user.email, name: user.name, emailVerified: Boolean(user.email_verified_at) } });
  } catch (error) {
    console.error(JSON.stringify({ type: 'account.login_failed', reason: error.message }));
    return response.status(500).json({ error: 'login_failed' });
  }
});

app.post('/api/account/logout', async (request, response) => {
  if (rejectCrossSite(request, response)) return;
  if (memberStore.ready) await memberStore.revokeSession(cookieValue(request, 'cc_session'));
  response.append('Set-Cookie', sessionCookie('', 0));
  return response.json({ ok: true });
});

app.get('/api/account/me', async (request, response) => {
  response.set('Cache-Control', 'no-store');
  const member = await requestMember(request);
  if (!member) return response.status(401).json({ error: 'not_signed_in' });
  return response.json({ member });
});

app.get('/api/account/dashboard', async (request, response) => {
  response.set('Cache-Control', 'no-store');
  const member = await requestMember(request);
  if (!member) return response.status(401).json({ error: 'not_signed_in' });
  const dashboard = await memberStore.dashboard(member.id);
  return response.json(dashboard);
});

app.post('/api/account/profile', async (request, response) => {
  if (rejectCrossSite(request, response)) return;
  const member = await requestMember(request);
  if (!member) return response.status(401).json({ error: 'not_signed_in' });
  const profile = {
    name: String(request.body?.name || '').trim(),
    company: String(request.body?.company || '').trim(),
    aiStage: String(request.body?.aiStage || ''),
    aiUse: String(request.body?.aiUse || ''),
    goal: String(request.body?.goal || '').trim(),
    hyperchatSessionId: String(request.body?.hyperchatSessionId || '').trim(),
    sourceUrl: `${publicSiteUrl()}/member`,
    consentText: 'I asked Clone Centre to update and store this member profile.'
  };
  if (profile.name.length < 2 || profile.name.length > 80) return response.status(400).json({ error: 'valid_name_required' });
  if (profile.company.length > 160) return response.status(400).json({ error: 'valid_company_required' });
  if (!Object.hasOwn(memberOptions.aiStage, profile.aiStage)) return response.status(400).json({ error: 'valid_ai_stage_required' });
  if (!Object.hasOwn(memberOptions.aiUse, profile.aiUse)) return response.status(400).json({ error: 'valid_ai_use_required' });
  if (profile.goal.length < 5 || profile.goal.length > 1500) return response.status(400).json({ error: 'valid_goal_required' });
  if (profile.hyperchatSessionId && !/^cc_[a-z0-9]{8,120}$/i.test(profile.hyperchatSessionId)) return response.status(400).json({ error: 'valid_chat_session_required' });
  await memberStore.updateProfile(member.id, profile);
  return response.json({ ok: true });
});

app.post('/api/account/link-chat', async (request, response) => {
  if (rejectCrossSite(request, response)) return;
  const member = await requestMember(request);
  if (!member) return response.status(401).json({ error: 'not_signed_in' });
  const sessionId = String(request.body?.sessionId || '').trim();
  if (!/^cc_[a-z0-9]{8,120}$/i.test(sessionId)) return response.status(400).json({ error: 'valid_chat_session_required' });
  await memberStore.linkChat(member.id, sessionId);
  return response.json({ ok: true });
});

app.post('/api/account/forgot-password', async (request, response) => {
  if (rejectCrossSite(request, response)) return;
  if (!accountAllowed(request.ip || 'unknown', 'forgot', 6, 60 * 60 * 1000)) return response.status(429).json({ error: 'too_many_requests' });
  if (!await ensureMemberStore()) return response.status(503).json({ error: 'member_database_unavailable' });
  const email = String(request.body?.email || '').trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) await memberStore.createPasswordReset(email, createOpaqueToken());
  void processEmailOutbox();
  return response.status(202).json({ ok: true, emailQueued: true });
});

app.post('/api/account/reset-password', async (request, response) => {
  if (rejectCrossSite(request, response)) return;
  if (!accountAllowed(request.ip || 'unknown', 'reset', 8, 60 * 60 * 1000)) return response.status(429).json({ error: 'too_many_requests' });
  if (!await ensureMemberStore()) return response.status(503).json({ error: 'member_database_unavailable' });
  const token = String(request.body?.token || '');
  const password = request.body?.password;
  if (token.length < 30 || token.length > 200 || !validAccountPassword(password)) return response.status(400).json({ error: 'valid_reset_required' });
  const changed = await memberStore.resetPassword(token, await hashPassword(password));
  if (!changed) return response.status(400).json({ error: 'reset_link_invalid_or_expired' });
  response.append('Set-Cookie', sessionCookie('', 0));
  return response.json({ ok: true });
});

app.post('/api/account/delete-request', async (request, response) => {
  if (rejectCrossSite(request, response)) return;
  const member = await requestMember(request);
  if (!member) return response.status(401).json({ error: 'not_signed_in' });
  const requestId = await memberStore.requestDeletion(member.id, member.email);
  void processEmailOutbox();
  return response.status(202).json({ ok: true, requestId });
});

app.get('/verify-email', async (request, response) => {
  if (!await ensureMemberStore()) return response.redirect(303, '/member?verified=unavailable');
  const token = String(request.query?.token || '');
  const verified = token.length >= 30 && token.length <= 200 ? await memberStore.verifyEmail(token) : false;
  return response.redirect(303, `/member?verified=${verified ? '1' : 'invalid'}`);
});

app.post('/api/subscribe', async (request, response) => {
  if (!subscriptionAllowed(request.ip || 'unknown')) return response.status(429).json({ error: 'too_many_requests' });
  if (request.body?.company) return response.status(200).json({ ok: true });
  const email = String(request.body?.email || '').trim().toLowerCase();
  const firstName = String(request.body?.firstName || '').trim();
  const role = String(request.body?.role || '');
  const aiStage = String(request.body?.aiStage || '');
  const goal = String(request.body?.goal || '');
  const requestedSessionId = String(request.body?.sessionId || '').trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response.status(400).json({ error: 'valid_email_required' });
  }
  if (firstName.length < 2 || firstName.length > 60) return response.status(400).json({ error: 'valid_name_required' });
  if (!Object.hasOwn(profileOptions.role, role)) return response.status(400).json({ error: 'valid_role_required' });
  if (!Object.hasOwn(profileOptions.aiStage, aiStage)) return response.status(400).json({ error: 'valid_ai_stage_required' });
  if (!Object.hasOwn(profileOptions.goal, goal)) return response.status(400).json({ error: 'valid_goal_required' });
  if (request.body?.consent !== true) return response.status(400).json({ error: 'consent_required' });
  const sessionId = /^cc_[a-z0-9]{8,120}$/i.test(requestedSessionId)
    ? requestedSessionId
    : `cc_profile_${createHash('sha256').update(email).digest('hex').slice(0, 24)}`;
  const profile = {
    email,
    firstName,
    role,
    aiStage,
    goal,
    sessionId,
    consentText: 'Email my guide and send practical Clone Centre updates based on these answers.',
    sourceUrl: `${publicSiteUrl()}/library#guide-gate`
  };
  if (memberStore.ready) {
    try {
      const member = await requestMember(request);
      await memberStore.saveGuideProfile(profile, member?.id || null);
    } catch (error) {
      console.error(JSON.stringify({ type: 'newsletter.railway_storage_failed', reason: error.message }));
      return response.status(502).json({ error: 'profile_storage_unavailable' });
    }
  }
  try {
    await persistHyperChatLead({
      sessionId,
      name: firstName,
      email,
      enquiry: [
        'Prompt Guidebook AI profile',
        `Context: ${profileOptions.role[role]}`,
        `AI stage: ${profileOptions.aiStage[aiStage]}`,
        `Main goal: ${profileOptions.goal[goal]}`
      ].join('\n'),
      sourceUrl: `${publicSiteUrl()}/library#guide-gate`
    });
  } catch (error) {
    console.error(JSON.stringify({ type: 'newsletter.hyperchat_storage_failed', reason: error.message }));
    if (!memberStore.ready) return response.status(502).json({ error: 'profile_storage_unavailable' });
  }
  if (memberStore.ready) {
    void processEmailOutbox();
    return response.status(202).json({ ok: true, stored: true, emailQueued: true, emailSent: false });
  }
  try {
    await subscribe(profile);
    return response.status(201).json({ ok: true, stored: true, emailSent: true });
  } catch (error) {
    console.error(JSON.stringify({ type: 'newsletter.failed', reason: error.message }));
    return response.status(202).json({ ok: true, stored: true, emailSent: false });
  }
});

app.post('/api/member-interest', async (request, response) => {
  if (request.get('sec-fetch-site') === 'cross-site') return response.status(403).json({ error: 'cross_site_request_rejected' });
  if (!memberInterestAllowed(request.ip || 'unknown')) return response.status(429).json({ error: 'too_many_requests' });
  if (request.body?.fax) return response.status(200).json({ ok: true });
  const profile = {
    sessionId: String(request.body?.sessionId || '').trim(),
    name: String(request.body?.name || '').trim(),
    email: String(request.body?.email || '').trim().toLowerCase(),
    company: String(request.body?.company || '').trim(),
    interest: String(request.body?.interest || ''),
    aiStage: String(request.body?.aiStage || ''),
    aiUse: String(request.body?.aiUse || ''),
    goal: String(request.body?.goal || '').trim(),
    currentCommunity: String(request.body?.currentCommunity || '').trim(),
    currentMembershipUrl: String(request.body?.currentMembershipUrl || '').trim(),
    proofFile: null,
    page: String(request.body?.page || '').trim(),
    consentText: 'I agree that Clone Centre may save these details and contact me about this enquiry.'
  };
  if (!/^cc_[a-z0-9]{8,120}$/i.test(profile.sessionId)) return response.status(400).json({ error: 'valid_session_required' });
  if (profile.name.length < 2 || profile.name.length > 80) return response.status(400).json({ error: 'valid_name_required' });
  if (profile.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) return response.status(400).json({ error: 'valid_email_required' });
  if (profile.company.length > 160) return response.status(400).json({ error: 'valid_company_required' });
  if (!Object.hasOwn(memberOptions.interest, profile.interest)) return response.status(400).json({ error: 'valid_interest_required' });
  if (!Object.hasOwn(memberOptions.aiStage, profile.aiStage)) return response.status(400).json({ error: 'valid_ai_stage_required' });
  if (!Object.hasOwn(memberOptions.aiUse, profile.aiUse)) return response.status(400).json({ error: 'valid_ai_use_required' });
  if (profile.goal.length < 5 || profile.goal.length > 1500) return response.status(400).json({ error: 'valid_goal_required' });
  if (request.body?.consent !== true) return response.status(400).json({ error: 'consent_required' });
  const isSwitch = profile.interest === 'switch_community' || profile.interest === 'switch_pro';
  if (isSwitch) {
    if (profile.currentCommunity.length < 2 || profile.currentCommunity.length > 160) return response.status(400).json({ error: 'current_community_required' });
    if (profile.currentMembershipUrl) {
      try {
        const membershipUrl = new URL(profile.currentMembershipUrl);
        if (!['http:', 'https:'].includes(membershipUrl.protocol)) throw new Error('invalid protocol');
      } catch { return response.status(400).json({ error: 'valid_membership_url_required' }); }
    }
    const incomingProof = request.body?.proofFile;
    const allowedProofTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);
    if (!incomingProof || typeof incomingProof.data !== 'string' || typeof incomingProof.name !== 'string' || !allowedProofTypes.has(incomingProof.type)) return response.status(400).json({ error: 'valid_switch_proof_required' });
    const proofBuffer = Buffer.from(incomingProof.data, 'base64');
    if (!proofBuffer.length || proofBuffer.length > 3 * 1024 * 1024 || incomingProof.name.length > 180 || !proofFileMatchesType(proofBuffer, incomingProof.type)) return response.status(400).json({ error: 'valid_switch_proof_required' });
    profile.proofFile = { name: incomingProof.name, type: incomingProof.type, buffer: proofBuffer };
    if (!memberStore.ready) return response.status(503).json({ error: 'switch_verification_storage_unavailable' });
  }
  try {
    const pageUrl = new URL(profile.page);
    if (!['http:', 'https:'].includes(pageUrl.protocol)) throw new Error('invalid protocol');
  } catch {
    return response.status(400).json({ error: 'valid_page_required' });
  }
  const enquiry = [
    `Interest: ${memberOptions.interest[profile.interest]}`,
    `AI stage: ${memberOptions.aiStage[profile.aiStage]}`,
    `Main AI use: ${memberOptions.aiUse[profile.aiUse]}`,
    ...(isSwitch ? [`Current paid community: ${profile.currentCommunity}`, `Proof stored: ${profile.proofFile.name}`] : []),
    `Goal: ${profile.goal}`
  ].join('\n');
  if (memberStore.ready) {
    try {
      const member = await requestMember(request);
      await memberStore.saveMemberInterest(profile, member?.id || null);
    } catch (error) {
      console.error(JSON.stringify({ type: 'member.railway_storage_failed', session: profile.sessionId, reason: error.message }));
      return response.status(502).json({ error: 'profile_storage_unavailable' });
    }
  }
  try {
    await persistHyperChatLead({
      sessionId: profile.sessionId,
      name: profile.name,
      email: profile.email,
      company: profile.company,
      enquiry,
      sourceUrl: profile.page
    });
  } catch (error) {
    console.error(JSON.stringify({ type: 'member.hyperchat_storage_failed', session: profile.sessionId, reason: error.message }));
    if (!memberStore.ready) return response.status(502).json({ error: 'profile_storage_unavailable' });
  }

  if (memberStore.ready) {
    void processEmailOutbox();
    return response.status(202).json({ ok: true, stored: true, emailQueued: true, emailSent: false });
  }
  const eventKey = createHash('sha256').update(`${profile.sessionId}:${profile.interest}:${profile.email}`).digest('hex').slice(0, 32);
  try {
    const [notification, acknowledgement] = await Promise.all([
      sendResendEmail({
        from: process.env.MEMBER_FROM_EMAIL || process.env.NEWSLETTER_FROM_EMAIL || 'Joseph at Clone Centre <hello@updates.clonecentre.ai>',
        to: [process.env.MEMBER_NOTIFICATIONS_EMAIL || process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai'],
        reply_to: profile.email,
        subject: `Clone Centre enquiry — ${memberOptions.interest[profile.interest]} · ${profile.name}`.slice(0, 190),
        html: memberNotificationMarkup(profile),
        tags: [{ name: 'automation', value: 'member_interest' }]
      }, `clonecentre-member-notify/${eventKey}`),
      sendResendEmail({
        from: process.env.MEMBER_FROM_EMAIL || process.env.NEWSLETTER_FROM_EMAIL || 'Joseph at Clone Centre <hello@updates.clonecentre.ai>',
        to: [profile.email],
        reply_to: process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai',
        subject: memberAcknowledgementSubject(profile),
        html: memberAcknowledgementMarkup(profile),
        tags: [{ name: 'automation', value: 'member_acknowledgement' }]
      }, `clonecentre-member-ack/${eventKey}`)
    ]);
    console.info(JSON.stringify({ type: 'member.saved', session: profile.sessionId, notification_id: notification.id, acknowledgement_id: acknowledgement.id }));
    return response.status(201).json({ ok: true, stored: true, emailSent: true });
  } catch (error) {
    console.error(JSON.stringify({ type: 'member.email_pending', session: profile.sessionId, reason: error.message }));
    return response.status(202).json({ ok: true, stored: true, emailSent: false });
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
  if (memberStore.ready) {
    try {
      const member = await requestMember(request);
      if (member) await memberStore.linkChat(member.id, sessionId);
      await memberStore.queueOutbox('chat_transcript', process.env.CHAT_TRANSCRIPTS_EMAIL || process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai', {
        conversationId,
        sessionId,
        page,
        title,
        messages
      }, `clonecentre-chat/${eventKey}`);
      void processEmailOutbox();
      return response.status(202).json({ ok: true, stored: true, emailQueued: true });
    } catch (error) {
      console.error(JSON.stringify({ type: 'chat_transcript.queue_failed', conversation: conversationId, reason: error.message }));
      return response.status(502).json({ error: 'transcript_storage_unavailable' });
    }
  }
  try {
    const result = await sendResendEmail({
      from: process.env.CHAT_TRANSCRIPTS_FROM_EMAIL || process.env.BOOKING_FROM_EMAIL || 'Clone Centre AI <hello@updates.clonecentre.ai>',
      to: [process.env.CHAT_TRANSCRIPTS_EMAIL || process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai'],
      reply_to: process.env.DELIVERY_REPLY_TO || 'joseph@clonecentre.ai',
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

app.get('/api/health', async (_request, response) => {
  let memberDatabaseReady = false;
  let outbox = null;
  if (memberStore.ready) {
    try {
      memberDatabaseReady = await memberStore.ping();
      outbox = await memberStore.outboxStats();
    } catch (error) {
      memberStoreError = error.message;
    }
  }
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
    member_capture_configured: Boolean(hyperChatBaseUrl && hyperChatProjectId),
    member_notifications_configured: Boolean(process.env.RESEND_API_KEY && (process.env.MEMBER_NOTIFICATIONS_EMAIL || process.env.DELIVERY_REPLY_TO)),
    member_database_configured: memberStore.enabled,
    member_database_ready: memberDatabaseReady,
    account_system_ready: memberDatabaseReady,
    email_outbox: outbox,
    member_database_error: memberDatabaseReady ? null : memberStoreError,
    booking_links_configured: Boolean(process.env.CAL_PROFILE_URL && process.env.CAL_AI_FIX_URL && process.env.CAL_AI_POWER_URL && process.env.CAL_BUILD_PARTNER_URL),
    booking_automation_configured: Boolean(process.env.CAL_WEBHOOK_SECRET && process.env.RESEND_API_KEY),
    delivery_mode: dryRun ? 'dry_run' : 'live'
  });
});

function sendHtml(response, filename, status = 200) {
  response.status(status).set('Cache-Control', 'no-cache, no-store, must-revalidate');
  return response.sendFile(join(publicDir, filename));
}

if (!isProduction) {
  const previewProfile = {
    firstName: 'Alex',
    name: 'Alex Morgan',
    email: 'alex@example.com',
    role: 'founder',
    interest: 'switch_pro',
    aiStage: 'exploring',
    aiUse: 'automation',
    goal: 'Turn a manual client onboarding process into a clear AI-assisted workflow without losing the personal touch.',
    sessionId: 'cc_preview_12345678',
    company: 'Northstar Studio',
    page: `${publicSiteUrl()}/community`,
    currentCommunity: 'Founder Network',
    currentMembershipUrl: 'https://example.com/community',
    proofFile: { name: 'membership-receipt.pdf' }
  };
  const previewTemplates = {
    guide: () => welcomeEmailMarkup(previewProfile.firstName),
    membership: () => membershipPaymentMarkup(previewProfile.name, 'pro'),
    purchase: () => emailMarkup({ title: 'The Full Library', files: Array.from({ length: 8 }, (_, index) => `book-${index + 1}.pdf`) }),
    booking: () => bookingEmailMarkup('BOOKING_CREATED', { name: previewProfile.name, title: 'AI Power Session', start: '2026-07-22T18:00:00.000Z' }),
    enquiry: () => memberNotificationMarkup(previewProfile),
    acknowledgement: () => memberAcknowledgementMarkup(previewProfile),
    account: () => accountActionEmailMarkup({ name: previewProfile.name, heading: 'Confirm your member account.', body: 'Your account and AI profile are safely stored. Confirm this email address to connect your member identity.', action: `${publicSiteUrl()}/verify-email?token=preview`, actionLabel: 'CONFIRM MY ACCOUNT' }),
    chat: () => chatTranscriptEmailMarkup({ conversationId: 'ct_preview_12345678', sessionId: previewProfile.sessionId, page: `${publicSiteUrl()}/products`, title: 'Clone Centre Products', messages: [{ role: 'user', content: 'Which product would help me automate onboarding?' }, { role: 'assistant', content: 'Start with The AI Automation Playbook, then use HyperChat when you are ready to put the workflow in front of customers.' }] })
  };
  app.get('/__email-preview', (request, response) => {
    const render = previewTemplates[String(request.query.template || 'guide')];
    if (!render) return response.status(404).send('Unknown email preview');
    return response.type('html').send(render());
  });
}

app.get('/', (_request, response) => sendHtml(response, 'index.html'));
for (const page of ['about', 'community', 'coaching', 'library', 'products']) {
  app.get(`/${page}/`, (_request, response) => response.redirect(308, `/${page}`));
  app.get(`/${page}`, (_request, response) => sendHtml(response, 'index.html'));
}
app.get('/order-complete', (_request, response) => sendHtml(response, 'order-complete.html'));
app.get('/chatbot-knowledge', (_request, response) => sendHtml(response, 'chatbot-knowledge.html'));
app.get('/member/', (_request, response) => response.redirect(308, '/member'));
app.get('/member', (_request, response) => sendHtml(response, 'member.html'));
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
const outboxInterval = setInterval(() => {
  if (!memberStore.ready) void ensureMemberStore();
  void processEmailOutbox();
}, 60_000);
outboxInterval.unref();
if (memberStore.ready) void processEmailOutbox();

function stop(signal) {
  console.info(JSON.stringify({ type: 'server.stopping', signal }));
  clearInterval(outboxInterval);
  server.close(() => memberStore.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
