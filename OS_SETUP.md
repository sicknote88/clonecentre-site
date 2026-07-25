# CloneCentre OS activation

The pilot runs at `/os`. Its production home should be:

`https://os.clonecentre.ai`

Keep `clonecentre.ai` as the product and company site, and link authenticated
operators into the OS subdomain.

## What already works

- Reads the Clone Centre content pipeline and keeps a deployable snapshot.
- Presents one decision at a time across Command, Creative, Publishing,
  Test Lab, Learning and Connections workspaces.
- Stores creative approvals, change requests, removals and publishing pauses in
  PostgreSQL when `DATABASE_URL` is configured (in-memory otherwise).
- Stores unlimited experiment variants, per-channel creative metrics and
  provider-neutral image/video generation jobs.
- Syncs channel metrics automatically every 15 minutes from connected Meta,
  TikTok and Google Ads accounts into daily per-channel records, once the
  corresponding OAuth connection exists. Meta and Google ad account/customer
  IDs are discovered on first sync and stored on the connection. Insights turn
  `live` from synced channel data when present, otherwise from manually entered
  experiment metrics, otherwise `pipeline_only`.
- Runs a generation worker that processes queued OpenAI image jobs into
  `social_output/generated/` and serves them back under `/os/media/`. The
  operator picks the model per job (`gpt-image-2` default, `gpt-image-1`,
  `gpt-image-1-mini`) and can request 1-4 images per job as a carousel
  (`asset_urls` on the job; `asset_url` stays the first frame). Runway,
  Stability and Google jobs are still marked `provider_not_implemented`.
- Renders Higgsfield jobs when `HIGGSFIELD_API_KEY` and
  `HIGGSFIELD_API_SECRET` are set: Soul text-to-image (`soul-720p`,
  `soul-1080p`, batch size up to 4) and DoP image-to-video (`dop-lite`,
  `dop-turbo` default, `dop-standard`). Video jobs require an input asset from
  the brand asset library plus a publicly reachable `OS_PUBLIC_URL` or
  `SITE_URL`, otherwise the job fails with an explicit reason.
- Stores uploaded brand assets (png/jpeg/webp/gif/mp4/pdf, up to 15 MB, base64
  JSON upload, magic-byte verified) in `social_output/assets/` and the asset
  library API, ready to seed Higgsfield video jobs.
- Stores brand brains (name, description, audience, tone of voice, visual
  style, palette, banned words, logo, default flag) with CRUD under
  `/api/os/brands`; asset uploads and generation jobs can be brand-scoped
  (jobs fall back to the default brand), and the worker composes the final
  on-brand prompt, stored as `resolved_prompt` on the job, before rendering.
- Runs a publisher that posts due, scheduled queue items to the connected
  Meta Facebook Page (photo or text post) and records every attempt as a
  publication. Paused items are skipped; failures stay visible on the queue.
  TikTok, Google and YouTube publishing are not yet implemented.
- Validates intelligence API keys against each provider and reports honest
  connection states (`connected`, `auth_failed`, `unreachable`,
  `key_configured`, `token_invalid`).
- Protects the pilot with `OS_ACCESS_KEY` in production.

## Accounts Joseph needs to create

### Meta

- Meta Business Portfolio
- Facebook Page
- Instagram Professional account linked to that Page
- Meta ad account and pixel
- Meta developer app owned by the Business Portfolio

### TikTok

- TikTok Business account
- TikTok Business Center and Ads Manager account
- TikTok pixel
- TikTok developer app for content posting and marketing access

### Google

- Google Cloud project
- Google Ads manager account and developer token application
- GA4 property for each website
- YouTube channel
- OAuth consent screen owned by Clone Centre

### Creative and intelligence

- OpenAI API project
- Anthropic Console account
- Google AI Studio or Vertex AI project
- Higgsfield account with commercial credits and supported server access

Use organisation-owned accounts, require two-factor authentication, and add a
second trusted administrator before submitting any app for review.

## Production variables

Set these only in the production host:

```text
OS_ACCESS_KEY
OS_WORKSPACE_KEY
OS_PUBLIC_URL
OS_TOKEN_ENCRYPTION_KEY
META_APP_ID
META_APP_SECRET
TIKTOK_MARKETING_APP_ID
TIKTOK_MARKETING_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_ADS_DEVELOPER_TOKEN
OPENAI_API_KEY
ANTHROPIC_API_KEY
GOOGLE_AI_API_KEY
HIGGSFIELD_API_KEY
HIGGSFIELD_API_SECRET
RUNWAY_API_KEY
STABILITY_API_KEY
```

Customer OAuth tokens are encrypted server-side with
`OS_TOKEN_ENCRYPTION_KEY` and stored against the OS workspace. Never reuse the
OS access password as this encryption key, never expose it to the browser, and
back it up in the production secret manager. Add these exact redirect URIs to
the reviewed provider apps:

```text
https://os.clonecentre.ai/api/os/integrations/meta/callback
https://os.clonecentre.ai/api/os/integrations/tiktok/callback
https://os.clonecentre.ai/api/os/integrations/google/callback
```

Use the optional `META_OAUTH_SCOPES`, `TIKTOK_OAUTH_SCOPES` and
`GOOGLE_OAUTH_SCOPES` variables when the reviewed scopes differ from the safe
defaults. Disconnect and provider-token revocation controls should be enabled
before customer organisations are invited.

## Activation order

1. Point `os.clonecentre.ai` at the existing production service and set a long
   `OS_ACCESS_KEY`.
2. Connect Clone Centre's own Meta and Google accounts first.
3. Pull GA4, Meta Ads and Google Ads metrics into one campaign result record.
4. Enable Instagram, Facebook and YouTube publishing behind human approval.
5. Add TikTok publishing and ads after its app review.
6. Add OpenAI, Anthropic, Gemini, Higgsfield, Runway and Stability AI as
   replaceable providers behind server-side usage limits.
7. Replace pilot access with organisations, users, roles and encrypted
   per-customer OAuth tokens before inviting customers.

MCP servers belong behind the product as tools used by CloneCentre agents.
Customers should see clear connection buttons and approval controls, not MCP
configuration or raw credentials.
