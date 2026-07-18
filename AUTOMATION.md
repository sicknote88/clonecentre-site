# Clone Centre automation

The production site keeps fulfilment on the shortest reliable path and holds its first-party member record in a dedicated PostgreSQL service inside the Clone Centre Railway project:

`Clone Centre website → Railway Express server → Railway PostgreSQL`

Stripe, Cal.com, HyperChat and Resend update or support that central record through signed webhooks and server-to-server requests. Those services continue to retain the operational data they require; PostgreSQL is the master Clone Centre member layer.

1. Stripe sends signed Checkout events directly to `/api/stripe/webhook`.
2. The server maps book and membership Payment Links through `fulfillment/catalog.json`.
3. Resend sends purchased files or a membership welcome to the Checkout email address. If sending is unavailable, Railway's outbox retries without losing the payment record.

The same server also owns the other customer email flows:

- `/api/subscribe` validates the visitor's AI profile, adds the explicitly opted-in address to the **Clone Centre Community** Resend segment, emails the private Prompt Guidebook as an attachment, and sends Joseph a concise lead-profile notification.
- `/api/cal/webhook` verifies Cal.com's HMAC signature and sends branded booking, reschedule, cancellation, and post-meeting emails.
- `/api/chat-transcript` validates and rate-limits first-party HyperChat transcripts, then emails Joseph the conversation after 45 seconds of inactivity or when the visitor leaves. HyperChat remains the complete conversation record.
- Standard Community, Pro and Accountability buttons open their exact monthly or annual Stripe subscription checkout directly; visitors do not repeat their plan choice in a form.
- `/api/member-interest` is reserved for £1 switch verification, custom coach, waitlist and help-me-choose enquiries. Switch applications require the current paid community plus a redacted PNG, JPG, WEBP or PDF proof file, stored privately in PostgreSQL for manual review before a discounted link is issued.
- `/api/subscribe` stores the visitor's AI profile in PostgreSQL before attempting the Prompt Guidebook email, so a temporary sending suspension does not lose the lead. HyperChat receives a secondary linked lead record.
- `/member` provides account registration, secure sessions, email verification, password reset, profile editing, linked-chat references, membership status and purchased-access records.
- The PostgreSQL email outbox retries account, guide, booking, chat, member and Stripe delivery emails with exponential backoff while Resend is unavailable.
- Cal.com itself sends a default 24-hour reminder with the calendar event attached.

All Resend messages use the shared `email-templates.js` design system. It provides the Clone Centre logo, black and electric-blue styling, mobile-safe table layouts, hidden preview text, consistent actions and an automatic plain-text alternative. Customer and internal templates cover guide delivery, purchased files, memberships, bookings, account verification, password resets, enquiries, £1 switch reviews and HyperChat transcripts. Marketing-enabled guide delivery also includes a visible unsubscribe instruction and a `List-Unsubscribe` mail header.

## Railway member data

The dedicated service stores:

- Member accounts, password hashes and secure session-token hashes
- AI profiles, explicit consent records and enquiries
- Pending £1 switch evidence and review status
- HyperChat session links (full conversations remain in HyperChat)
- Membership tier and Stripe subscription references
- Cal.com booking references
- Purchased-product and entitlement records
- A retryable Resend email outbox
- Audit events and account-deletion requests

## Production resources

- Stripe event destination ID: `we_1TuN6mFn1JbEKmslGeFtBLxA`
- Stripe events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`
- Cal.com event types: `ai-fix-session`, `ai-power-session`, `ai-build-partner`
- Resend segment: `Clone Centre Community`
- Resend sending domain: `updates.clonecentre.ai`
- Railway member database: dedicated `Postgres` service connected through `DATABASE_URL`

## Required Railway variables

See `.env.example` for the complete list. Secrets must only be stored in Railway and their source dashboards; never commit them.

## Safe test sequence

1. Confirm `/api/health` reports `member_database_ready`, `account_system_ready`, delivery, profile capture, chat, member, Cal link and Cal automation flags as `true`.
2. Submit one owned email address through the AI-profile form and confirm both the attached guide delivery and Joseph's lead notification arrive.
3. Book a Cal.com test slot, then cancel it.
4. Use a low-value Stripe test-mode Payment Link before testing a live purchase.
5. Check Stripe event deliveries and Railway logs for a `2xx` response and `delivery.sent` entry.
6. After Resend restores API sending, hold one short owned test chat and confirm the transcript email arrives at `CHAT_TRANSCRIPTS_EMAIL`.
7. Submit one owned annual-Pro enquiry and confirm it appears in HyperChat Leads, reaches `MEMBER_NOTIFICATIONS_EMAIL`, and sends the visitor acknowledgement.
8. Create an owned test account at `/member`, confirm the current HyperChat session links to it, sign out and back in, update the AI profile, then remove the QA data after verification.
