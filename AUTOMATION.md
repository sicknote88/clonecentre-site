# Clone Centre automation

The production site keeps fulfilment on the shortest reliable path:

1. Stripe sends signed Checkout events directly to `/api/stripe/webhook`.
2. The server maps the Payment Link to `fulfillment/catalog.json`.
3. Resend sends the purchased files to the Checkout email address.

The same server also owns the other customer email flows:

- `/api/subscribe` validates the visitor's AI profile, adds the explicitly opted-in address to the **Clone Centre Community** Resend segment, emails the private Prompt Guidebook as an attachment, and sends Joseph a concise lead-profile notification.
- `/api/cal/webhook` verifies Cal.com's HMAC signature and sends branded booking, reschedule, cancellation, and post-meeting emails.
- `/api/chat-transcript` validates and rate-limits first-party HyperChat transcripts, then emails Joseph the conversation after 45 seconds of inactivity or when the visitor leaves. HyperChat remains the complete conversation record.
- `/api/member-interest` stores every consented membership, annual-Pro chatbot, switch, waitlist and help-me-choose profile in HyperChat before attempting email. Resend then notifies Joseph and acknowledges the visitor; a Resend outage never discards the stored profile.
- `/api/subscribe` now stores the visitor's AI profile in HyperChat before attempting the Prompt Guidebook email, so a temporary sending suspension does not lose the lead.
- Cal.com itself sends a default 24-hour reminder with the calendar event attached.

## Production resources

- Stripe event destination ID: `we_1TuN6mFn1JbEKmslGeFtBLxA`
- Stripe events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`
- Cal.com event types: `ai-fix-session`, `ai-power-session`, `ai-build-partner`
- Resend segment: `Clone Centre Community`
- Resend sending domain: `updates.clonecentre.ai`

## Required Railway variables

See `.env.example` for the complete list. Secrets must only be stored in Railway and their source dashboards; never commit them.

## Safe test sequence

1. Confirm `/api/health` reports the delivery, profile capture, chat, member, Cal link and Cal automation flags as `true`.
2. Submit one owned email address through the AI-profile form and confirm both the attached guide delivery and Joseph's lead notification arrive.
3. Book a Cal.com test slot, then cancel it.
4. Use a low-value Stripe test-mode Payment Link before testing a live purchase.
5. Check Stripe event deliveries and Railway logs for a `2xx` response and `delivery.sent` entry.
6. After Resend restores API sending, hold one short owned test chat and confirm the transcript email arrives at `CHAT_TRANSCRIPTS_EMAIL`.
7. Submit one owned annual-Pro enquiry and confirm it appears in HyperChat Leads, reaches `MEMBER_NOTIFICATIONS_EMAIL`, and sends the visitor acknowledgement.
