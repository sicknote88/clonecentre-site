import express from 'express';
import Stripe from 'stripe';
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

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `clonecentre-pdf/${session.id}`
    },
    body: JSON.stringify({
      from: process.env.DELIVERY_FROM_EMAIL || 'Clone Centre <books@clonecentre.ai>',
      to: [email],
      reply_to: process.env.DELIVERY_REPLY_TO || 'hello@clonecentre.ai',
      subject: `Your Clone Centre files — ${product.title}`,
      html: emailMarkup(product),
      attachments,
      tags: [{ name: 'catalog_key', value: product.key }]
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Resend rejected delivery (${response.status}): ${body.message || body.name || 'unknown error'}`);
  console.info(JSON.stringify({ type: 'delivery.sent', session: session.id, product: product.key, resend_id: body.id }));
  return { id: body.id, product: product.key };
}

app.disable('x-powered-by');
app.enable('strict routing');
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

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    service: 'clonecentre-site',
    catalog_products: Object.keys(catalog.products).length,
    paid_assets_available: Object.values(catalog.products).every((product) => product.files.every((file) => {
      try { return statSync(assertPrivateFile(file)).isFile(); } catch { return false; }
    })),
    delivery_configured: Boolean(process.env.STRIPE_WEBHOOK_SECRET && process.env.RESEND_API_KEY),
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
