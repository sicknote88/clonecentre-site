import pg from 'pg';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const { Pool } = pg;
const scrypt = promisify(scryptCallback);
const PASSWORD_VERSION = 'scrypt-v1';
const SESSION_DAYS = 30;

function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function createOpaqueToken() {
  return randomBytes(32).toString('base64url');
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(String(password), salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
  return [PASSWORD_VERSION, '32768', '8', '1', salt.toString('base64url'), Buffer.from(derived).toString('base64url')].join('$');
}

export async function verifyPassword(password, encoded) {
  const [version, n, r, p, salt, expected] = String(encoded || '').split('$');
  if (version !== PASSWORD_VERSION || !salt || !expected) return false;
  const expectedBuffer = Buffer.from(expected, 'base64url');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64url'), expectedBuffer.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024
  });
  const actualBuffer = Buffer.from(actual);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function safeJson(value) {
  return JSON.stringify(value === undefined ? null : value);
}

export function createMemberStore(databaseUrl) {
  const enabled = Boolean(databaseUrl);
  const pool = enabled ? new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000 }) : null;
  const localOsDecisions = new Map();
  const localOsQueueControls = new Map();
  const localOsExperiments = new Map();
  const localOsGenerationJobs = new Map();
  const localOsConnections = new Map();
  const localOsPublications = new Map();
  const localOsAssets = new Map();
  const localOsChannelMetrics = new Map();
  const localOsBrands = new Map();
  let ready = false;

  async function init() {
    if (!pool) return false;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_users (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        email_verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS cc_member_profiles (
        user_id UUID PRIMARY KEY REFERENCES cc_users(id) ON DELETE CASCADE,
        company TEXT,
        ai_stage TEXT,
        ai_use TEXT,
        goal TEXT,
        consent_at TIMESTAMPTZ,
        consent_text TEXT,
        source_url TEXT,
        hyperchat_session_id TEXT,
        marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cc_sessions (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES cc_users(id) ON DELETE CASCADE,
        token_hash CHAR(64) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        user_agent TEXT,
        ip_hash CHAR(64),
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS cc_sessions_user_idx ON cc_sessions(user_id, expires_at DESC);
      CREATE TABLE IF NOT EXISTS cc_memberships (
        user_id UUID PRIMARY KEY REFERENCES cc_users(id) ON DELETE CASCADE,
        tier TEXT NOT NULL DEFAULT 'profile',
        status TEXT NOT NULL DEFAULT 'active',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        current_period_end TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cc_entitlements (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES cc_users(id) ON DELETE CASCADE,
        entitlement_key TEXT NOT NULL,
        source TEXT NOT NULL,
        valid_until TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, entitlement_key)
      );
      CREATE TABLE IF NOT EXISTS cc_enquiries (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES cc_users(id) ON DELETE SET NULL,
        hyperchat_session_id TEXT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        company TEXT,
        interest TEXT NOT NULL,
        ai_stage TEXT,
        ai_use TEXT,
        goal TEXT,
        consent_at TIMESTAMPTZ NOT NULL,
        consent_text TEXT NOT NULL,
        source_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS cc_enquiries_email_idx ON cc_enquiries(email, created_at DESC);
      CREATE TABLE IF NOT EXISTS cc_switch_proofs (
        enquiry_id UUID PRIMARY KEY REFERENCES cc_enquiries(id) ON DELETE CASCADE,
        current_community TEXT NOT NULL,
        current_membership_url TEXT,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_data BYTEA NOT NULL,
        verification_status TEXT NOT NULL DEFAULT 'pending',
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cc_chat_links (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES cc_users(id) ON DELETE CASCADE,
        hyperchat_session_id TEXT NOT NULL UNIQUE,
        linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cc_booking_refs (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES cc_users(id) ON DELETE SET NULL,
        attendee_email TEXT,
        cal_booking_uid TEXT UNIQUE,
        event_type TEXT,
        starts_at TIMESTAMPTZ,
        status TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cc_purchases (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES cc_users(id) ON DELETE SET NULL,
        email TEXT NOT NULL,
        stripe_checkout_session_id TEXT NOT NULL UNIQUE,
        catalog_key TEXT,
        amount_total BIGINT,
        currency TEXT,
        payment_status TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cc_email_verification_tokens (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES cc_users(id) ON DELETE CASCADE,
        token_hash CHAR(64) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cc_password_reset_tokens (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES cc_users(id) ON DELETE CASCADE,
        token_hash CHAR(64) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cc_email_outbox (
        id UUID PRIMARY KEY,
        kind TEXT NOT NULL,
        recipient TEXT,
        payload JSONB NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS cc_outbox_pending_idx ON cc_email_outbox(status, available_at);
      CREATE TABLE IF NOT EXISTS cc_deletion_requests (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES cc_users(id) ON DELETE SET NULL,
        email TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'requested',
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS cc_audit_events (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES cc_users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        subject_type TEXT,
        subject_id TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS cc_audit_user_idx ON cc_audit_events(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS cc_os_post_decisions (
        workspace_key TEXT NOT NULL,
        post_key TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('approved','changes_requested','discarded')),
        note TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_key, post_key)
      );
      CREATE TABLE IF NOT EXISTS cc_os_queue_controls (
        workspace_key TEXT NOT NULL,
        item_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('scheduled','paused','published','failed')),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_key, item_key)
      );
      CREATE TABLE IF NOT EXISTS cc_os_experiments (
        id UUID PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        name TEXT NOT NULL,
        objective TEXT,
        channels JSONB NOT NULL DEFAULT '[]'::jsonb,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','paused','completed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS cc_os_experiments_workspace_idx ON cc_os_experiments(workspace_key, created_at DESC);
      CREATE TABLE IF NOT EXISTS cc_os_experiment_variants (
        experiment_id UUID NOT NULL REFERENCES cc_os_experiments(id) ON DELETE CASCADE,
        variant_key TEXT NOT NULL,
        asset_type TEXT NOT NULL CHECK (asset_type IN ('image','video','mixed')),
        asset_label TEXT NOT NULL,
        caption_label TEXT NOT NULL,
        changed_variable TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (experiment_id, variant_key)
      );
      CREATE TABLE IF NOT EXISTS cc_os_variant_metrics (
        experiment_id UUID NOT NULL REFERENCES cc_os_experiments(id) ON DELETE CASCADE,
        variant_key TEXT NOT NULL,
        channel TEXT NOT NULL,
        spend NUMERIC,
        impressions BIGINT,
        clicks BIGINT,
        leads NUMERIC,
        sales NUMERIC,
        revenue NUMERIC,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (experiment_id, variant_key, channel)
      );
      CREATE TABLE IF NOT EXISTS cc_os_generation_jobs (
        id UUID PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        output_type TEXT NOT NULL CHECK (output_type IN ('image','video')),
        provider TEXT NOT NULL,
        prompt TEXT NOT NULL,
        aspect_ratio TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed')),
        asset_url TEXT,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS cc_os_generation_jobs_workspace_idx ON cc_os_generation_jobs(workspace_key, created_at DESC);
      CREATE TABLE IF NOT EXISTS cc_os_connections (
        workspace_key TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        account_id TEXT,
        account_label TEXT,
        token_envelope TEXT NOT NULL,
        scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_key, provider_id)
      );
      CREATE TABLE IF NOT EXISTS cc_os_publications (
        workspace_key TEXT NOT NULL,
        item_key TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('published','failed')),
        external_id TEXT,
        error TEXT,
        published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_key, item_key, channel)
      );
      CREATE TABLE IF NOT EXISTS cc_os_assets (
        id UUID PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size_bytes BIGINT NOT NULL DEFAULT 0,
        path TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS cc_os_assets_workspace_idx ON cc_os_assets(workspace_key, created_at DESC);
      CREATE TABLE IF NOT EXISTS cc_os_brands (
        id UUID PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT,
        audience TEXT,
        voice TEXT,
        style_directives TEXT,
        palette JSONB NOT NULL DEFAULT '[]'::jsonb,
        banned_words JSONB NOT NULL DEFAULT '[]'::jsonb,
        logo_asset_id UUID,
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (workspace_key, slug)
      );
      CREATE INDEX IF NOT EXISTS cc_os_brands_workspace_idx ON cc_os_brands(workspace_key, created_at DESC);
      CREATE TABLE IF NOT EXISTS cc_os_channel_metrics (
        workspace_key TEXT NOT NULL,
        channel TEXT NOT NULL,
        date DATE NOT NULL,
        spend NUMERIC,
        impressions BIGINT,
        clicks BIGINT,
        leads NUMERIC,
        sales NUMERIC,
        revenue NUMERIC,
        raw JSONB NOT NULL DEFAULT '{}'::jsonb,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_key, channel, date)
      );
      ALTER TABLE cc_os_generation_jobs ADD COLUMN IF NOT EXISTS model TEXT;
      ALTER TABLE cc_os_generation_jobs ADD COLUMN IF NOT EXISTS asset_urls JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE cc_os_generation_jobs ADD COLUMN IF NOT EXISTS input_asset_id TEXT;
      ALTER TABLE cc_os_generation_jobs ADD COLUMN IF NOT EXISTS count INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE cc_os_generation_jobs ADD COLUMN IF NOT EXISTS brand_id UUID;
      ALTER TABLE cc_os_generation_jobs ADD COLUMN IF NOT EXISTS resolved_prompt TEXT;
      ALTER TABLE cc_os_assets ADD COLUMN IF NOT EXISTS brand_id UUID;
      ALTER TABLE cc_os_queue_controls DROP CONSTRAINT IF EXISTS cc_os_queue_controls_state_check;
      ALTER TABLE cc_os_queue_controls ADD CONSTRAINT cc_os_queue_controls_state_check CHECK (state IN ('scheduled','paused','published','failed'));
      ALTER TABLE cc_memberships ALTER COLUMN tier SET DEFAULT 'profile';
      UPDATE cc_memberships SET tier='profile',updated_at=NOW() WHERE tier='free';
    `);
    ready = true;
    return true;
  }

  async function withTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function audit(client, { userId, action, subjectType, subjectId, details = {} }) {
    await client.query(
      'INSERT INTO cc_audit_events (id,user_id,action,subject_type,subject_id,details) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
      [randomUUID(), userId || null, action, subjectType || null, subjectId || null, safeJson(details)]
    );
  }

  async function enqueue(client, { kind, recipient, payload, idempotencyKey }) {
    await client.query(
      `INSERT INTO cc_email_outbox (id,kind,recipient,payload,idempotency_key)
       VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (idempotency_key) DO NOTHING`,
      [randomUUID(), kind, recipient || null, safeJson(payload), idempotencyKey]
    );
  }

  async function createAccount({ name, email, passwordHash, company, aiStage, aiUse, goal, consentText, sourceUrl, hyperchatSessionId, sessionToken, verificationToken, ipHash, userAgent }) {
    return withTransaction(async (client) => {
      const userId = randomUUID();
      await client.query('INSERT INTO cc_users (id,email,name,password_hash) VALUES ($1,$2,$3,$4)', [userId, email, name, passwordHash]);
      await client.query(
        `INSERT INTO cc_member_profiles (user_id,company,ai_stage,ai_use,goal,consent_at,consent_text,source_url,hyperchat_session_id,marketing_consent)
         VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8,FALSE)`,
        [userId, company || null, aiStage || null, aiUse || null, goal || null, consentText, sourceUrl || null, hyperchatSessionId || null]
      );
      await client.query('INSERT INTO cc_memberships (user_id,tier,status) VALUES ($1,$2,$3)', [userId, 'profile', 'active']);
      await client.query('UPDATE cc_enquiries SET user_id=$1 WHERE LOWER(email)=$2 AND user_id IS NULL', [userId, email]);
      await client.query('UPDATE cc_purchases SET user_id=$1,updated_at=NOW() WHERE LOWER(email)=$2 AND user_id IS NULL', [userId, email]);
      await client.query('UPDATE cc_booking_refs SET user_id=$1,updated_at=NOW() WHERE LOWER(attendee_email)=$2 AND user_id IS NULL', [userId, email]);
      const historicalPurchases = await client.query(
        `SELECT catalog_key,stripe_checkout_session_id,payment_status,details FROM cc_purchases
         WHERE user_id=$1 ORDER BY created_at DESC`,
        [userId]
      );
      for (const purchase of historicalPurchases.rows) {
        if (purchase.catalog_key && purchase.payment_status === 'paid') {
          await client.query(
            `INSERT INTO cc_entitlements (id,user_id,entitlement_key,source,metadata) VALUES ($1,$2,$3,'stripe',$4::jsonb)
             ON CONFLICT (user_id,entitlement_key) DO UPDATE SET source='stripe',metadata=EXCLUDED.metadata`,
            [randomUUID(), userId, `book:${purchase.catalog_key}`, safeJson({ checkoutSessionId: purchase.stripe_checkout_session_id })]
          );
        }
      }
      const historicalMembership = historicalPurchases.rows.find((purchase) => purchase.payment_status === 'paid' && purchase.details?.metadata?.membership_tier);
      if (historicalMembership) {
        await client.query('UPDATE cc_memberships SET tier=$1,status=$2,updated_at=NOW() WHERE user_id=$3', [historicalMembership.details.metadata.membership_tier, 'active', userId]);
      }
      if (hyperchatSessionId) {
        await client.query('INSERT INTO cc_chat_links (id,user_id,hyperchat_session_id) VALUES ($1,$2,$3) ON CONFLICT (hyperchat_session_id) DO UPDATE SET user_id=EXCLUDED.user_id,linked_at=NOW()', [randomUUID(), userId, hyperchatSessionId]);
      }
      await client.query(
        `INSERT INTO cc_sessions (id,user_id,token_hash,expires_at,user_agent,ip_hash)
         VALUES ($1,$2,$3,NOW()+($4||' days')::interval,$5,$6)`,
        [randomUUID(), userId, tokenHash(sessionToken), String(SESSION_DAYS), userAgent || null, ipHash || null]
      );
      await client.query(
        `INSERT INTO cc_email_verification_tokens (id,user_id,token_hash,expires_at)
         VALUES ($1,$2,$3,NOW()+INTERVAL '24 hours')`,
        [randomUUID(), userId, tokenHash(verificationToken)]
      );
      await enqueue(client, {
        kind: 'account_verify',
        recipient: email,
        payload: { name, email, token: verificationToken },
        idempotencyKey: `account-verify/${userId}`
      });
      await audit(client, { userId, action: 'account.created', subjectType: 'user', subjectId: userId, details: { sourceUrl, hyperchatSessionId } });
      return { id: userId, email, name, emailVerified: false, membership: { tier: 'profile', status: 'active' } };
    });
  }

  async function userForLogin(email) {
    const result = await pool.query('SELECT id,email,name,password_hash,email_verified_at FROM cc_users WHERE email=$1', [email]);
    return result.rows[0] || null;
  }

  async function createSession({ userId, token, ipHash, userAgent }) {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO cc_sessions (id,user_id,token_hash,expires_at,user_agent,ip_hash)
         VALUES ($1,$2,$3,NOW()+($4||' days')::interval,$5,$6)`,
        [randomUUID(), userId, tokenHash(token), String(SESSION_DAYS), userAgent || null, ipHash || null]
      );
      await client.query('UPDATE cc_users SET last_login_at=NOW(),updated_at=NOW() WHERE id=$1', [userId]);
      await audit(client, { userId, action: 'account.login', subjectType: 'session', details: { ipHash } });
    });
  }

  async function memberForToken(token) {
    if (!token) return null;
    const result = await pool.query(
      `SELECT u.id,u.email,u.name,u.email_verified_at,m.tier,m.status,m.current_period_end
       FROM cc_sessions s JOIN cc_users u ON u.id=s.user_id JOIN cc_memberships m ON m.user_id=u.id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>NOW()`,
      [tokenHash(token)]
    );
    if (!result.rows[0]) return null;
    pool.query('UPDATE cc_sessions SET last_seen_at=NOW() WHERE token_hash=$1', [tokenHash(token)]).catch(() => {});
    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      emailVerified: Boolean(row.email_verified_at),
      membership: { tier: row.tier, status: row.status, currentPeriodEnd: row.current_period_end }
    };
  }

  async function revokeSession(token) {
    if (!token) return;
    await pool.query('UPDATE cc_sessions SET revoked_at=NOW() WHERE token_hash=$1', [tokenHash(token)]);
  }

  async function verifyEmail(token) {
    return withTransaction(async (client) => {
      const found = await client.query(
        `SELECT id,user_id FROM cc_email_verification_tokens
         WHERE token_hash=$1 AND used_at IS NULL AND expires_at>NOW() FOR UPDATE`,
        [tokenHash(token)]
      );
      if (!found.rows[0]) return false;
      await client.query('UPDATE cc_email_verification_tokens SET used_at=NOW() WHERE id=$1', [found.rows[0].id]);
      await client.query('UPDATE cc_users SET email_verified_at=COALESCE(email_verified_at,NOW()),updated_at=NOW() WHERE id=$1', [found.rows[0].user_id]);
      await audit(client, { userId: found.rows[0].user_id, action: 'account.email_verified', subjectType: 'user', subjectId: found.rows[0].user_id });
      return true;
    });
  }

  async function createPasswordReset(email, resetToken) {
    return withTransaction(async (client) => {
      const found = await client.query('SELECT id,name,email FROM cc_users WHERE email=$1', [email]);
      if (!found.rows[0]) return false;
      const user = found.rows[0];
      await client.query('UPDATE cc_password_reset_tokens SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL', [user.id]);
      await client.query(
        `INSERT INTO cc_password_reset_tokens (id,user_id,token_hash,expires_at)
         VALUES ($1,$2,$3,NOW()+INTERVAL '1 hour')`,
        [randomUUID(), user.id, tokenHash(resetToken)]
      );
      await enqueue(client, {
        kind: 'password_reset',
        recipient: user.email,
        payload: { name: user.name, email: user.email, token: resetToken },
        idempotencyKey: `password-reset/${user.id}/${Date.now()}`
      });
      await audit(client, { userId: user.id, action: 'account.password_reset_requested', subjectType: 'user', subjectId: user.id });
      return true;
    });
  }

  async function resetPassword(resetToken, passwordHash) {
    return withTransaction(async (client) => {
      const found = await client.query(
        `SELECT id,user_id FROM cc_password_reset_tokens
         WHERE token_hash=$1 AND used_at IS NULL AND expires_at>NOW() FOR UPDATE`,
        [tokenHash(resetToken)]
      );
      if (!found.rows[0]) return false;
      const userId = found.rows[0].user_id;
      await client.query('UPDATE cc_password_reset_tokens SET used_at=NOW() WHERE id=$1', [found.rows[0].id]);
      await client.query('UPDATE cc_users SET password_hash=$1,updated_at=NOW() WHERE id=$2', [passwordHash, userId]);
      await client.query('UPDATE cc_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
      await audit(client, { userId, action: 'account.password_reset_completed', subjectType: 'user', subjectId: userId });
      return true;
    });
  }

  async function linkChat(userId, hyperchatSessionId) {
    if (!userId || !hyperchatSessionId) return;
    await pool.query(
      `INSERT INTO cc_chat_links (id,user_id,hyperchat_session_id) VALUES ($1,$2,$3)
       ON CONFLICT (hyperchat_session_id) DO UPDATE SET user_id=EXCLUDED.user_id,linked_at=NOW()`,
      [randomUUID(), userId, hyperchatSessionId]
    );
  }

  async function saveMemberInterest(profile, userId = null) {
    return withTransaction(async (client) => {
      const enquiryId = randomUUID();
      await client.query(
        `INSERT INTO cc_enquiries (id,user_id,hyperchat_session_id,name,email,company,interest,ai_stage,ai_use,goal,consent_at,consent_text,source_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11,$12)`,
        [enquiryId, userId, profile.sessionId || null, profile.name, profile.email, profile.company || null, profile.interest, profile.aiStage || null, profile.aiUse || null, profile.goal || null, profile.consentText, profile.page || null]
      );
      if (profile.interest === 'switch_community' || profile.interest === 'switch_pro') {
        await client.query(
          `INSERT INTO cc_switch_proofs (enquiry_id,current_community,current_membership_url,file_name,mime_type,file_data)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [enquiryId, profile.currentCommunity, profile.currentMembershipUrl || null, profile.proofFile.name, profile.proofFile.type, profile.proofFile.buffer]
        );
      }
      if (userId) {
        await client.query(
          `INSERT INTO cc_member_profiles (user_id,company,ai_stage,ai_use,goal,consent_at,consent_text,source_url,hyperchat_session_id)
           VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8)
           ON CONFLICT (user_id) DO UPDATE SET company=EXCLUDED.company,ai_stage=EXCLUDED.ai_stage,ai_use=EXCLUDED.ai_use,goal=EXCLUDED.goal,consent_at=NOW(),consent_text=EXCLUDED.consent_text,source_url=EXCLUDED.source_url,hyperchat_session_id=EXCLUDED.hyperchat_session_id,updated_at=NOW()`,
          [userId, profile.company || null, profile.aiStage || null, profile.aiUse || null, profile.goal || null, profile.consentText, profile.page || null, profile.sessionId || null]
        );
        if (profile.sessionId) {
          await client.query('INSERT INTO cc_chat_links (id,user_id,hyperchat_session_id) VALUES ($1,$2,$3) ON CONFLICT (hyperchat_session_id) DO UPDATE SET user_id=EXCLUDED.user_id,linked_at=NOW()', [randomUUID(), userId, profile.sessionId]);
        }
      }
      const key = createHash('sha256').update(`${profile.sessionId}:${profile.interest}:${profile.email}:${profile.goal}`).digest('hex').slice(0, 32);
      const notificationProfile = profile.proofFile ? { ...profile, proofFile: { name: profile.proofFile.name, type: profile.proofFile.type, stored: true, data: profile.proofFile.buffer.toString('base64') } } : profile;
      const acknowledgementProfile = profile.proofFile ? { ...profile, proofFile: { name: profile.proofFile.name, type: profile.proofFile.type, stored: true } } : profile;
      await enqueue(client, { kind: 'member_notification', recipient: profile.email, payload: notificationProfile, idempotencyKey: `member-notify/${key}` });
      await enqueue(client, { kind: 'member_acknowledgement', recipient: profile.email, payload: acknowledgementProfile, idempotencyKey: `member-ack/${key}` });
      await audit(client, { userId, action: 'enquiry.created', subjectType: 'enquiry', subjectId: enquiryId, details: { interest: profile.interest, sessionId: profile.sessionId } });
      return enquiryId;
    });
  }

  async function saveGuideProfile(profile, userId = null) {
    return withTransaction(async (client) => {
      const enquiryId = randomUUID();
      await client.query(
        `INSERT INTO cc_enquiries (id,user_id,hyperchat_session_id,name,email,interest,ai_stage,ai_use,goal,consent_at,consent_text,source_url)
         VALUES ($1,$2,$3,$4,$5,'prompt_guide',$6,$7,$8,NOW(),$9,$10)`,
        [enquiryId, userId, profile.sessionId || null, profile.firstName, profile.email, profile.aiStage, profile.role, profile.goal, profile.consentText, profile.sourceUrl]
      );
      if (userId && profile.sessionId) {
        await client.query('INSERT INTO cc_chat_links (id,user_id,hyperchat_session_id) VALUES ($1,$2,$3) ON CONFLICT (hyperchat_session_id) DO UPDATE SET user_id=EXCLUDED.user_id,linked_at=NOW()', [randomUUID(), userId, profile.sessionId]);
      }
      const key = createHash('sha256').update(`${profile.email}:${profile.aiStage}:${profile.goal}`).digest('hex').slice(0, 32);
      await enqueue(client, { kind: 'guide_profile', recipient: profile.email, payload: profile, idempotencyKey: `guide-profile/${key}` });
      await audit(client, { userId, action: 'guide.requested', subjectType: 'enquiry', subjectId: enquiryId, details: { sessionId: profile.sessionId } });
      return enquiryId;
    });
  }

  async function dashboard(userId) {
    const base = await pool.query(
      `SELECT u.id,u.email,u.name,u.email_verified_at,u.created_at,p.company,p.ai_stage,p.ai_use,p.goal,p.hyperchat_session_id,m.tier,m.status,m.current_period_end
       FROM cc_users u LEFT JOIN cc_member_profiles p ON p.user_id=u.id JOIN cc_memberships m ON m.user_id=u.id WHERE u.id=$1`,
      [userId]
    );
    if (!base.rows[0]) return null;
    const [entitlements, purchases, chats, enquiries] = await Promise.all([
      pool.query('SELECT entitlement_key,source,valid_until,metadata FROM cc_entitlements WHERE user_id=$1 ORDER BY created_at DESC', [userId]),
      pool.query('SELECT catalog_key,amount_total,currency,payment_status,created_at FROM cc_purchases WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [userId]),
      pool.query('SELECT hyperchat_session_id,linked_at FROM cc_chat_links WHERE user_id=$1 ORDER BY linked_at DESC LIMIT 50', [userId]),
      pool.query('SELECT interest,goal,created_at FROM cc_enquiries WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [userId])
    ]);
    const row = base.rows[0];
    return {
      user: { id: row.id, email: row.email, name: row.name, emailVerified: Boolean(row.email_verified_at), createdAt: row.created_at },
      profile: { company: row.company || '', aiStage: row.ai_stage || '', aiUse: row.ai_use || '', goal: row.goal || '', hyperchatSessionId: row.hyperchat_session_id || '' },
      membership: { tier: row.tier, status: row.status, currentPeriodEnd: row.current_period_end },
      entitlements: entitlements.rows,
      purchases: purchases.rows,
      chats: chats.rows,
      enquiries: enquiries.rows
    };
  }

  async function updateProfile(userId, profile) {
    await withTransaction(async (client) => {
      await client.query('UPDATE cc_users SET name=$1,updated_at=NOW() WHERE id=$2', [profile.name, userId]);
      await client.query(
        `INSERT INTO cc_member_profiles (user_id,company,ai_stage,ai_use,goal,consent_at,consent_text,source_url,hyperchat_session_id)
         VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8)
         ON CONFLICT (user_id) DO UPDATE SET company=EXCLUDED.company,ai_stage=EXCLUDED.ai_stage,ai_use=EXCLUDED.ai_use,goal=EXCLUDED.goal,consent_at=NOW(),consent_text=EXCLUDED.consent_text,source_url=EXCLUDED.source_url,hyperchat_session_id=COALESCE(EXCLUDED.hyperchat_session_id,cc_member_profiles.hyperchat_session_id),updated_at=NOW()`,
        [userId, profile.company || null, profile.aiStage || null, profile.aiUse || null, profile.goal || null, profile.consentText, profile.sourceUrl || null, profile.hyperchatSessionId || null]
      );
      if (profile.hyperchatSessionId) {
        await client.query('INSERT INTO cc_chat_links (id,user_id,hyperchat_session_id) VALUES ($1,$2,$3) ON CONFLICT (hyperchat_session_id) DO UPDATE SET user_id=EXCLUDED.user_id,linked_at=NOW()', [randomUUID(), userId, profile.hyperchatSessionId]);
      }
      await audit(client, { userId, action: 'profile.updated', subjectType: 'user', subjectId: userId });
    });
  }

  async function requestDeletion(userId, email) {
    return withTransaction(async (client) => {
      const requestId = randomUUID();
      await client.query('INSERT INTO cc_deletion_requests (id,user_id,email) VALUES ($1,$2,$3)', [requestId, userId, email]);
      await enqueue(client, { kind: 'deletion_request', recipient: email, payload: { userId, email, requestId }, idempotencyKey: `deletion/${requestId}` });
      await audit(client, { userId, action: 'account.deletion_requested', subjectType: 'deletion_request', subjectId: requestId });
      return requestId;
    });
  }

  async function recordPurchase(session, catalogKey) {
    const email = String(session.customer_details?.email || session.customer_email || '').trim().toLowerCase();
    if (!email || !session.id) return;
    await withTransaction(async (client) => {
      const user = await client.query('SELECT id FROM cc_users WHERE email=$1', [email]);
      const userId = user.rows[0]?.id || null;
      await client.query(
        `INSERT INTO cc_purchases (id,user_id,email,stripe_checkout_session_id,catalog_key,amount_total,currency,payment_status,details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (stripe_checkout_session_id) DO UPDATE SET user_id=COALESCE(EXCLUDED.user_id,cc_purchases.user_id),payment_status=EXCLUDED.payment_status,updated_at=NOW(),details=EXCLUDED.details`,
        [randomUUID(), userId, email, session.id, catalogKey || null, session.amount_total || null, session.currency || null, session.payment_status || null, safeJson({ paymentLink: session.payment_link || null, metadata: session.metadata || {} })]
      );
      if (userId && catalogKey && !session.metadata?.membership_tier && session.payment_status === 'paid') {
        await client.query(
          `INSERT INTO cc_entitlements (id,user_id,entitlement_key,source,metadata) VALUES ($1,$2,$3,'stripe',$4::jsonb)
           ON CONFLICT (user_id,entitlement_key) DO UPDATE SET source='stripe',metadata=EXCLUDED.metadata`,
          [randomUUID(), userId, `book:${catalogKey}`, safeJson({ checkoutSessionId: session.id })]
        );
      }
      if (userId && session.metadata?.membership_tier && session.payment_status === 'paid') {
        await client.query(
          `UPDATE cc_memberships SET tier=$1,status='active',stripe_customer_id=$2,stripe_subscription_id=$3,updated_at=NOW() WHERE user_id=$4`,
          [session.metadata.membership_tier, session.customer || null, session.subscription || null, userId]
        );
      }
      await audit(client, { userId, action: 'purchase.recorded', subjectType: 'stripe_checkout', subjectId: session.id, details: { catalogKey, paymentStatus: session.payment_status } });
    });
  }

  async function recordBooking(trigger, payload) {
    const attendee = Array.isArray(payload.attendees) ? payload.attendees.find((person) => person?.email) : null;
    const email = String(attendee?.email || '').trim().toLowerCase() || null;
    const uid = String(payload.uid || payload.bookingUid || payload.id || '').trim() || null;
    if (!uid) return;
    const status = trigger === 'BOOKING_CANCELLED' ? 'cancelled' : trigger === 'MEETING_ENDED' ? 'completed' : 'booked';
    const user = email ? await pool.query('SELECT id FROM cc_users WHERE email=$1', [email]) : { rows: [] };
    await pool.query(
      `INSERT INTO cc_booking_refs (id,user_id,attendee_email,cal_booking_uid,event_type,starts_at,status,details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (cal_booking_uid) DO UPDATE SET user_id=COALESCE(EXCLUDED.user_id,cc_booking_refs.user_id),attendee_email=EXCLUDED.attendee_email,event_type=EXCLUDED.event_type,starts_at=EXCLUDED.starts_at,status=EXCLUDED.status,details=EXCLUDED.details,updated_at=NOW()`,
      [randomUUID(), user.rows[0]?.id || null, email, uid, payload.eventTitle || payload.title || null, payload.startTime || payload.start || null, status, safeJson({ trigger })]
    );
  }

  async function queueOutbox(kind, recipient, payload, idempotencyKey) {
    await withTransaction((client) => enqueue(client, { kind, recipient, payload, idempotencyKey }));
  }

  async function claimOutbox(limit = 8) {
    const result = await pool.query(
      `WITH next AS (
         SELECT id FROM cc_email_outbox
         WHERE ((status='pending' AND available_at<=NOW()) OR (status='sending' AND locked_at<NOW()-INTERVAL '15 minutes'))
         ORDER BY created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE cc_email_outbox o SET status='sending',locked_at=NOW(),attempts=o.attempts+1
       FROM next WHERE o.id=next.id RETURNING o.*`,
      [limit]
    );
    return result.rows;
  }

  async function completeOutbox(id) {
    await pool.query("UPDATE cc_email_outbox SET status='sent',sent_at=NOW(),locked_at=NULL,last_error=NULL,payload='{}'::jsonb WHERE id=$1", [id]);
  }

  async function failOutbox(id, attempts, error) {
    const delaySeconds = Math.min(6 * 60 * 60, Math.max(60, 60 * (2 ** Math.min(Number(attempts || 1), 8))));
    await pool.query(
      `UPDATE cc_email_outbox SET status='pending',available_at=NOW()+($2||' seconds')::interval,locked_at=NULL,last_error=$3 WHERE id=$1`,
      [id, String(delaySeconds), String(error || 'unknown error').slice(0, 2000)]
    );
  }

  async function outboxStats() {
    const result = await pool.query("SELECT COUNT(*) FILTER (WHERE status='pending')::int AS pending,COUNT(*) FILTER (WHERE status='sent')::int AS sent,COUNT(*) FILTER (WHERE status='sending')::int AS sending FROM cc_email_outbox");
    return result.rows[0];
  }

  async function osState(workspaceKey) {
    if (!pool || !ready) {
      return {
        decisions: Object.fromEntries([...localOsDecisions.entries()].filter(([key]) => key.startsWith(`${workspaceKey}:`)).map(([key, value]) => [key.slice(workspaceKey.length + 1), value])),
        queueControls: Object.fromEntries([...localOsQueueControls.entries()].filter(([key]) => key.startsWith(`${workspaceKey}:`)).map(([key, value]) => [key.slice(workspaceKey.length + 1), value]))
      };
    }
    const [decisions, queueControls] = await Promise.all([
      pool.query('SELECT post_key,decision,note,updated_at FROM cc_os_post_decisions WHERE workspace_key=$1', [workspaceKey]),
      pool.query('SELECT item_key,state,updated_at FROM cc_os_queue_controls WHERE workspace_key=$1', [workspaceKey])
    ]);
    return {
      decisions: Object.fromEntries(decisions.rows.map((row) => [row.post_key, { decision: row.decision, note: row.note || '', updatedAt: row.updated_at }])),
      queueControls: Object.fromEntries(queueControls.rows.map((row) => [row.item_key, { state: row.state, updatedAt: row.updated_at }]))
    };
  }

  async function saveOsDecision(workspaceKey, postKey, decision, note = '') {
    const value = { decision, note, updatedAt: new Date().toISOString() };
    if (!pool || !ready) {
      localOsDecisions.set(`${workspaceKey}:${postKey}`, value);
      return { ...value, durable: false };
    }
    const result = await pool.query(
      `INSERT INTO cc_os_post_decisions (workspace_key,post_key,decision,note)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (workspace_key,post_key)
       DO UPDATE SET decision=EXCLUDED.decision,note=EXCLUDED.note,updated_at=NOW()
       RETURNING decision,note,updated_at`,
      [workspaceKey, postKey, decision, note || null]
    );
    return { decision: result.rows[0].decision, note: result.rows[0].note || '', updatedAt: result.rows[0].updated_at, durable: true };
  }

  async function saveOsQueueControl(workspaceKey, itemKey, state) {
    const value = { state, updatedAt: new Date().toISOString() };
    if (!pool || !ready) {
      localOsQueueControls.set(`${workspaceKey}:${itemKey}`, value);
      return { ...value, durable: false };
    }
    const result = await pool.query(
      `INSERT INTO cc_os_queue_controls (workspace_key,item_key,state)
       VALUES ($1,$2,$3)
       ON CONFLICT (workspace_key,item_key)
       DO UPDATE SET state=EXCLUDED.state,updated_at=NOW()
       RETURNING state,updated_at`,
      [workspaceKey, itemKey, state]
    );
    return { state: result.rows[0].state, updatedAt: result.rows[0].updated_at, durable: true };
  }

  function defaultExperimentVariants() {
    return [
      { key: 'A', assetType: 'image', assetLabel: 'Control image', captionLabel: 'Caption 1', changedVariable: 'Control' },
      { key: 'B', assetType: 'image', assetLabel: 'Image variant', captionLabel: 'Caption 1', changedVariable: 'Visual only' },
      { key: 'C', assetType: 'image', assetLabel: 'Control image', captionLabel: 'Caption 2', changedVariable: 'Caption only' },
      { key: 'D', assetType: 'video', assetLabel: 'Video variant', captionLabel: 'Caption 1', changedVariable: 'Format only' }
    ];
  }

  async function osExperiments(workspaceKey) {
    if (!pool || !ready) {
      return [...localOsExperiments.values()].filter((experiment) => experiment.workspaceKey === workspaceKey);
    }
    const [experiments, variants, metrics] = await Promise.all([
      pool.query('SELECT id,name,objective,channels,status,created_at,updated_at FROM cc_os_experiments WHERE workspace_key=$1 ORDER BY created_at DESC', [workspaceKey]),
      pool.query(`SELECT v.experiment_id,v.variant_key,v.asset_type,v.asset_label,v.caption_label,v.changed_variable
                  FROM cc_os_experiment_variants v JOIN cc_os_experiments e ON e.id=v.experiment_id
                  WHERE e.workspace_key=$1 ORDER BY v.experiment_id,v.variant_key`, [workspaceKey]),
      pool.query(`SELECT m.experiment_id,m.variant_key,m.channel,m.spend,m.impressions,m.clicks,m.leads,m.sales,m.revenue,m.synced_at
                  FROM cc_os_variant_metrics m JOIN cc_os_experiments e ON e.id=m.experiment_id
                  WHERE e.workspace_key=$1 ORDER BY m.experiment_id,m.variant_key,m.channel`, [workspaceKey])
    ]);
    return experiments.rows.map((row) => ({
      id: row.id,
      name: row.name,
      objective: row.objective || '',
      channels: row.channels || [],
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      variants: variants.rows.filter((variant) => variant.experiment_id === row.id).map((variant) => ({
        key: variant.variant_key,
        assetType: variant.asset_type,
        assetLabel: variant.asset_label,
        captionLabel: variant.caption_label,
        changedVariable: variant.changed_variable,
        metrics: metrics.rows.filter((metric) => metric.experiment_id === row.id && metric.variant_key === variant.variant_key)
      }))
    }));
  }

  async function createOsExperiment(workspaceKey, input) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const variants = defaultExperimentVariants().map((variant) => ({ ...variant, metrics: [] }));
    const experiment = { id, workspaceKey, name: input.name, objective: input.objective || '', channels: input.channels || [], status: 'draft', createdAt: now, updatedAt: now, variants };
    if (!pool || !ready) {
      localOsExperiments.set(id, experiment);
      return { ...experiment, durable: false };
    }
    await withTransaction(async (client) => {
      await client.query(
        'INSERT INTO cc_os_experiments (id,workspace_key,name,objective,channels) VALUES ($1,$2,$3,$4,$5::jsonb)',
        [id, workspaceKey, input.name, input.objective || null, safeJson(input.channels || [])]
      );
      for (const variant of variants) {
        await client.query(
          `INSERT INTO cc_os_experiment_variants (experiment_id,variant_key,asset_type,asset_label,caption_label,changed_variable)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, variant.key, variant.assetType, variant.assetLabel, variant.captionLabel, variant.changedVariable]
        );
      }
    });
    return { ...experiment, durable: true };
  }

  async function addOsExperimentVariant(workspaceKey, experimentId) {
    const experiments = await osExperiments(workspaceKey);
    const experiment = experiments.find((item) => item.id === experimentId);
    if (!experiment) return null;
    const index = experiment.variants.length;
    const key = index < 26 ? String.fromCharCode(65 + index) : `V${index + 1}`;
    const variant = { key, assetType: 'mixed', assetLabel: `Asset ${key}`, captionLabel: `Caption ${key}`, changedVariable: 'Define one variable', metrics: [] };
    if (!pool || !ready) {
      localOsExperiments.get(experimentId).variants.push(variant);
      localOsExperiments.get(experimentId).updatedAt = new Date().toISOString();
      return { ...variant, durable: false };
    }
    await pool.query(
      `INSERT INTO cc_os_experiment_variants (experiment_id,variant_key,asset_type,asset_label,caption_label,changed_variable)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [experimentId, variant.key, variant.assetType, variant.assetLabel, variant.captionLabel, variant.changedVariable]
    );
    return { ...variant, durable: true };
  }

  async function saveOsVariantMetrics(workspaceKey, experimentId, input) {
    const metric = { channel: input.channel, spend: input.spend, impressions: input.impressions, clicks: input.clicks, leads: input.leads, sales: input.sales, revenue: input.revenue, syncedAt: new Date().toISOString() };
    if (!pool || !ready) {
      const experiment = localOsExperiments.get(experimentId);
      const variant = experiment?.workspaceKey === workspaceKey ? experiment.variants.find((item) => item.key === input.variantKey) : null;
      if (!variant) return null;
      const existingIndex = variant.metrics.findIndex((item) => item.channel === input.channel);
      if (existingIndex >= 0) variant.metrics[existingIndex] = metric;
      else variant.metrics.push(metric);
      return { ...metric, durable: false };
    }
    const found = await pool.query(
      `SELECT 1 FROM cc_os_experiment_variants v JOIN cc_os_experiments e ON e.id=v.experiment_id
       WHERE e.workspace_key=$1 AND e.id=$2 AND v.variant_key=$3`,
      [workspaceKey, experimentId, input.variantKey]
    );
    if (!found.rows[0]) return null;
    const result = await pool.query(
      `INSERT INTO cc_os_variant_metrics (experiment_id,variant_key,channel,spend,impressions,clicks,leads,sales,revenue)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (experiment_id,variant_key,channel)
       DO UPDATE SET spend=EXCLUDED.spend,impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,leads=EXCLUDED.leads,sales=EXCLUDED.sales,revenue=EXCLUDED.revenue,synced_at=NOW()
       RETURNING channel,spend,impressions,clicks,leads,sales,revenue,synced_at`,
      [experimentId, input.variantKey, input.channel, input.spend, input.impressions, input.clicks, input.leads, input.sales, input.revenue]
    );
    const row = result.rows[0];
    return { channel: row.channel, spend: row.spend, impressions: row.impressions, clicks: row.clicks, leads: row.leads, sales: row.sales, revenue: row.revenue, syncedAt: row.synced_at, durable: true };
  }

  function mapOsGenerationJobRow(row) {
    return {
      id: row.id, outputType: row.output_type, provider: row.provider, prompt: row.prompt,
      aspectRatio: row.aspect_ratio, model: row.model || null, count: Number(row.count || 1),
      inputAssetId: row.input_asset_id || null, brandId: row.brand_id || row.brandId || null,
      resolvedPrompt: row.resolved_prompt ?? row.resolvedPrompt ?? null, status: row.status,
      assetUrl: row.asset_url || null, assetUrls: row.asset_urls || [],
      error: row.error || null, createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  async function osGenerationJobs(workspaceKey) {
    if (!pool || !ready) return [...localOsGenerationJobs.values()].filter((job) => job.workspaceKey === workspaceKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const result = await pool.query(
      'SELECT id,output_type,provider,prompt,aspect_ratio,model,count,input_asset_id,brand_id,resolved_prompt,status,asset_url,asset_urls,error,created_at,updated_at FROM cc_os_generation_jobs WHERE workspace_key=$1 ORDER BY created_at DESC LIMIT 50',
      [workspaceKey]
    );
    return result.rows.map(mapOsGenerationJobRow);
  }

  async function createOsGenerationJob(workspaceKey, input) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const job = {
      id, workspaceKey, outputType: input.outputType, provider: input.provider, prompt: input.prompt,
      aspectRatio: input.aspectRatio, model: input.model || null, count: input.count || 1,
      inputAssetId: input.inputAssetId || null, brandId: input.brandId || null, resolvedPrompt: null,
      status: 'queued', assetUrl: null, assetUrls: [],
      error: null, createdAt: now, updatedAt: now
    };
    if (!pool || !ready) {
      localOsGenerationJobs.set(id, job);
      return { ...job, durable: false };
    }
    await pool.query(
      `INSERT INTO cc_os_generation_jobs (id,workspace_key,output_type,provider,prompt,aspect_ratio,model,count,input_asset_id,brand_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, workspaceKey, input.outputType, input.provider, input.prompt, input.aspectRatio, input.model || null, input.count || 1, input.inputAssetId || null, input.brandId || null]
    );
    return { ...job, durable: true };
  }

  async function saveOsGenerationJobResolvedPrompt(workspaceKey, id, resolvedPrompt) {
    const prompt = String(resolvedPrompt || '').slice(0, 12000);
    const now = new Date().toISOString();
    if (!pool || !ready) {
      const job = localOsGenerationJobs.get(id);
      if (!job || job.workspaceKey !== workspaceKey) return null;
      job.resolvedPrompt = prompt;
      job.updatedAt = now;
      return { ...job };
    }
    const result = await pool.query(
      `UPDATE cc_os_generation_jobs SET resolved_prompt=$3,updated_at=NOW()
       WHERE workspace_key=$1 AND id=$2
       RETURNING id,output_type,provider,prompt,aspect_ratio,model,count,input_asset_id,brand_id,resolved_prompt,status,asset_url,asset_urls,error,created_at,updated_at`,
      [workspaceKey, id, prompt]
    );
    const row = result.rows[0];
    if (!row) return null;
    return mapOsGenerationJobRow(row);
  }

  async function claimNextOsGenerationJob(workspaceKey) {
    if (!pool || !ready) {
      const job = [...localOsGenerationJobs.values()]
        .filter((item) => item.workspaceKey === workspaceKey && item.status === 'queued')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!job) return null;
      job.status = 'processing';
      job.updatedAt = new Date().toISOString();
      return { ...job };
    }
    const result = await pool.query(
      `UPDATE cc_os_generation_jobs SET status='processing',updated_at=NOW()
       WHERE id=(SELECT id FROM cc_os_generation_jobs WHERE workspace_key=$1 AND status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id,output_type,provider,prompt,aspect_ratio,model,count,input_asset_id,brand_id,resolved_prompt,status,asset_url,asset_urls,error,created_at,updated_at`,
      [workspaceKey]
    );
    const row = result.rows[0];
    if (!row) return null;
    return mapOsGenerationJobRow(row);
  }

  async function completeOsGenerationJob(workspaceKey, id, assetUrl, assetUrls = null) {
    const now = new Date().toISOString();
    const urls = Array.isArray(assetUrls) && assetUrls.length ? assetUrls : (assetUrl ? [assetUrl] : []);
    if (!pool || !ready) {
      const job = localOsGenerationJobs.get(id);
      if (!job || job.workspaceKey !== workspaceKey) return null;
      job.status = 'completed';
      job.assetUrl = assetUrl;
      job.assetUrls = urls;
      job.error = null;
      job.updatedAt = now;
      return { ...job };
    }
    const result = await pool.query(
      `UPDATE cc_os_generation_jobs SET status='completed',asset_url=$3,asset_urls=$4::jsonb,error=NULL,updated_at=NOW()
       WHERE workspace_key=$1 AND id=$2
       RETURNING id,output_type,provider,prompt,aspect_ratio,model,count,input_asset_id,brand_id,resolved_prompt,status,asset_url,asset_urls,error,created_at,updated_at`,
      [workspaceKey, id, assetUrl, safeJson(urls)]
    );
    const row = result.rows[0];
    if (!row) return null;
    return mapOsGenerationJobRow(row);
  }

  async function failOsGenerationJob(workspaceKey, id, error) {
    const now = new Date().toISOString();
    const reason = String(error || 'unknown_error').slice(0, 500);
    if (!pool || !ready) {
      const job = localOsGenerationJobs.get(id);
      if (!job || job.workspaceKey !== workspaceKey) return null;
      job.status = 'failed';
      job.error = reason;
      job.updatedAt = now;
      return { ...job };
    }
    const result = await pool.query(
      `UPDATE cc_os_generation_jobs SET status='failed',error=$3,updated_at=NOW()
       WHERE workspace_key=$1 AND id=$2
       RETURNING id,output_type,provider,prompt,aspect_ratio,model,count,input_asset_id,brand_id,resolved_prompt,status,asset_url,asset_urls,error,created_at,updated_at`,
      [workspaceKey, id, reason]
    );
    const row = result.rows[0];
    if (!row) return null;
    return mapOsGenerationJobRow(row);
  }

  async function osConnections(workspaceKey) {
    if (!pool || !ready) return [...localOsConnections.values()].filter((connection) => connection.workspaceKey === workspaceKey).map(({ tokenEnvelope: _tokenEnvelope, ...connection }) => connection);
    const result = await pool.query(
      `SELECT provider_id,account_id,account_label,scopes,metadata,connected_at,updated_at
       FROM cc_os_connections WHERE workspace_key=$1 ORDER BY provider_id`,
      [workspaceKey]
    );
    return result.rows.map((row) => ({
      providerId: row.provider_id,
      accountId: row.account_id || null,
      accountLabel: row.account_label || null,
      scopes: row.scopes || [],
      metadata: row.metadata || {},
      connectedAt: row.connected_at,
      updatedAt: row.updated_at,
      durable: true
    }));
  }

  async function saveOsConnection(workspaceKey, input) {
    const now = new Date().toISOString();
    const connection = {
      workspaceKey,
      providerId: input.providerId,
      accountId: input.accountId || null,
      accountLabel: input.accountLabel || null,
      tokenEnvelope: input.tokenEnvelope,
      scopes: input.scopes || [],
      metadata: input.metadata || {},
      connectedAt: now,
      updatedAt: now
    };
    if (!pool || !ready) {
      localOsConnections.set(`${workspaceKey}:${input.providerId}`, connection);
      return { ...connection, tokenEnvelope: undefined, durable: false };
    }
    const result = await pool.query(
      `INSERT INTO cc_os_connections (workspace_key,provider_id,account_id,account_label,token_envelope,scopes,metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
       ON CONFLICT (workspace_key,provider_id)
       DO UPDATE SET account_id=EXCLUDED.account_id,account_label=EXCLUDED.account_label,token_envelope=EXCLUDED.token_envelope,
                     scopes=EXCLUDED.scopes,metadata=EXCLUDED.metadata,updated_at=NOW()
       RETURNING provider_id,account_id,account_label,scopes,metadata,connected_at,updated_at`,
      [workspaceKey, input.providerId, input.accountId || null, input.accountLabel || null, input.tokenEnvelope, safeJson(input.scopes || []), safeJson(input.metadata || {})]
    );
    const row = result.rows[0];
    return {
      providerId: row.provider_id,
      accountId: row.account_id || null,
      accountLabel: row.account_label || null,
      scopes: row.scopes || [],
      metadata: row.metadata || {},
      connectedAt: row.connected_at,
      updatedAt: row.updated_at,
      durable: true
    };
  }

  async function osConnectionToken(workspaceKey, providerId) {
    if (!pool || !ready) {
      const connection = localOsConnections.get(`${workspaceKey}:${providerId}`);
      if (!connection) return null;
      return { tokenEnvelope: connection.tokenEnvelope, accountId: connection.accountId, accountLabel: connection.accountLabel, metadata: connection.metadata || {} };
    }
    const result = await pool.query(
      'SELECT token_envelope,account_id,account_label,metadata FROM cc_os_connections WHERE workspace_key=$1 AND provider_id=$2',
      [workspaceKey, providerId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { tokenEnvelope: row.token_envelope, accountId: row.account_id || null, accountLabel: row.account_label || null, metadata: row.metadata || {} };
  }

  async function saveOsPublication(workspaceKey, input) {
    const value = {
      itemKey: input.itemKey,
      channel: input.channel,
      status: input.status,
      externalId: input.externalId || null,
      error: input.error ? String(input.error).slice(0, 500) : null,
      publishedAt: new Date().toISOString()
    };
    if (!pool || !ready) {
      localOsPublications.set(`${workspaceKey}:${input.itemKey}:${input.channel}`, { workspaceKey, ...value });
      return { ...value, durable: false };
    }
    const result = await pool.query(
      `INSERT INTO cc_os_publications (workspace_key,item_key,channel,status,external_id,error)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (workspace_key,item_key,channel)
       DO UPDATE SET status=EXCLUDED.status,external_id=EXCLUDED.external_id,error=EXCLUDED.error,published_at=NOW()
       RETURNING item_key,channel,status,external_id,error,published_at`,
      [workspaceKey, input.itemKey, input.channel, input.status, input.externalId || null, value.error]
    );
    const row = result.rows[0];
    return { itemKey: row.item_key, channel: row.channel, status: row.status, externalId: row.external_id || null, error: row.error || null, publishedAt: row.published_at, durable: true };
  }

  async function osPublications(workspaceKey) {
    if (!pool || !ready) {
      return [...localOsPublications.values()]
        .filter((item) => item.workspaceKey === workspaceKey)
        .map(({ workspaceKey: _workspaceKey, ...item }) => item)
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    }
    const result = await pool.query(
      'SELECT item_key,channel,status,external_id,error,published_at FROM cc_os_publications WHERE workspace_key=$1 ORDER BY published_at DESC LIMIT 200',
      [workspaceKey]
    );
    return result.rows.map((row) => ({
      itemKey: row.item_key, channel: row.channel, status: row.status,
      externalId: row.external_id || null, error: row.error || null, publishedAt: row.published_at
    }));
  }

  async function osMetricsTotals(workspaceKey) {
    const empty = { spend: 0, impressions: 0, clicks: 0, leads: 0, sales: 0, revenue: 0, rows: 0 };
    if (!pool || !ready) {
      const totals = { ...empty };
      for (const experiment of localOsExperiments.values()) {
        if (experiment.workspaceKey !== workspaceKey) continue;
        for (const variant of experiment.variants) {
          for (const metric of variant.metrics) {
            totals.spend += Number(metric.spend || 0);
            totals.impressions += Number(metric.impressions || 0);
            totals.clicks += Number(metric.clicks || 0);
            totals.leads += Number(metric.leads || 0);
            totals.sales += Number(metric.sales || 0);
            totals.revenue += Number(metric.revenue || 0);
            totals.rows += 1;
          }
        }
      }
      return totals;
    }
    const result = await pool.query(
      `SELECT COUNT(*)::int AS rows,
              COALESCE(SUM(m.spend),0)::float AS spend,
              COALESCE(SUM(m.impressions),0)::float AS impressions,
              COALESCE(SUM(m.clicks),0)::float AS clicks,
              COALESCE(SUM(m.leads),0)::float AS leads,
              COALESCE(SUM(m.sales),0)::float AS sales,
              COALESCE(SUM(m.revenue),0)::float AS revenue
       FROM cc_os_variant_metrics m JOIN cc_os_experiments e ON e.id=m.experiment_id
       WHERE e.workspace_key=$1`,
      [workspaceKey]
    );
    const row = result.rows[0] || {};
    return {
      spend: Number(row.spend || 0), impressions: Number(row.impressions || 0), clicks: Number(row.clicks || 0),
      leads: Number(row.leads || 0), sales: Number(row.sales || 0), revenue: Number(row.revenue || 0),
      rows: Number(row.rows || 0)
    };
  }

  async function createOsAsset(workspaceKey, input) {
    const id = input.id || randomUUID();
    const now = new Date().toISOString();
    const asset = { id, workspaceKey, name: input.name, mime: input.mime, sizeBytes: Number(input.sizeBytes || 0), path: input.path, brandId: input.brandId || null, createdAt: now };
    if (!pool || !ready) {
      localOsAssets.set(id, asset);
      return { ...asset, durable: false };
    }
    await pool.query(
      'INSERT INTO cc_os_assets (id,workspace_key,name,mime,size_bytes,path,brand_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, workspaceKey, input.name, input.mime, asset.sizeBytes, input.path, input.brandId || null]
    );
    return { ...asset, durable: true };
  }

  function mapOsAssetRow(row) {
    return { id: row.id, name: row.name, mime: row.mime, sizeBytes: Number(row.size_bytes || row.sizeBytes || 0), path: row.path, brandId: row.brand_id || row.brandId || null, createdAt: row.created_at || row.createdAt };
  }

  async function osAssets(workspaceKey) {
    if (!pool || !ready) {
      return [...localOsAssets.values()]
        .filter((asset) => asset.workspaceKey === workspaceKey)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 100)
        .map(mapOsAssetRow);
    }
    const result = await pool.query(
      'SELECT id,name,mime,size_bytes,path,brand_id,created_at FROM cc_os_assets WHERE workspace_key=$1 ORDER BY created_at DESC LIMIT 100',
      [workspaceKey]
    );
    return result.rows.map(mapOsAssetRow);
  }

  async function osAsset(workspaceKey, id) {
    if (!pool || !ready) {
      const asset = localOsAssets.get(id);
      return asset && asset.workspaceKey === workspaceKey ? mapOsAssetRow(asset) : null;
    }
    const result = await pool.query(
      'SELECT id,name,mime,size_bytes,path,brand_id,created_at FROM cc_os_assets WHERE workspace_key=$1 AND id=$2',
      [workspaceKey, id]
    );
    return result.rows[0] ? mapOsAssetRow(result.rows[0]) : null;
  }

  function osBrandSlug(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'brand';
  }

  function mapOsBrandRow(row) {
    return {
      id: row.id, name: row.name, slug: row.slug,
      description: row.description || null, audience: row.audience || null,
      voice: row.voice || null, styleDirectives: row.style_directives ?? row.styleDirectives ?? null,
      palette: Array.isArray(row.palette) ? row.palette : [],
      bannedWords: Array.isArray(row.banned_words) ? row.banned_words : (Array.isArray(row.bannedWords) ? row.bannedWords : []),
      logoAssetId: row.logo_asset_id || row.logoAssetId || null,
      isDefault: Boolean(row.is_default ?? row.isDefault),
      assetCount: Number(row.asset_count ?? row.assetCount ?? 0),
      createdAt: row.created_at || row.createdAt, updatedAt: row.updated_at || row.updatedAt
    };
  }

  async function osBrands(workspaceKey) {
    if (!pool || !ready) {
      return [...localOsBrands.values()]
        .filter((brand) => brand.workspaceKey === workspaceKey)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((brand) => mapOsBrandRow({
          ...brand,
          assetCount: [...localOsAssets.values()].filter((asset) => asset.workspaceKey === workspaceKey && asset.brandId === brand.id).length
        }));
    }
    const result = await pool.query(
      `SELECT b.*, (SELECT COUNT(*) FROM cc_os_assets a WHERE a.workspace_key=b.workspace_key AND a.brand_id=b.id)::int AS asset_count
       FROM cc_os_brands b WHERE b.workspace_key=$1 ORDER BY b.created_at LIMIT 100`,
      [workspaceKey]
    );
    return result.rows.map(mapOsBrandRow);
  }

  async function osBrand(workspaceKey, id) {
    if (!pool || !ready) {
      const brand = localOsBrands.get(id);
      return brand && brand.workspaceKey === workspaceKey ? mapOsBrandRow(brand) : null;
    }
    const result = await pool.query('SELECT * FROM cc_os_brands WHERE workspace_key=$1 AND id=$2', [workspaceKey, id]);
    return result.rows[0] ? mapOsBrandRow(result.rows[0]) : null;
  }

  async function osDefaultBrand(workspaceKey) {
    if (!pool || !ready) {
      const brand = [...localOsBrands.values()].find((item) => item.workspaceKey === workspaceKey && item.isDefault);
      return brand ? mapOsBrandRow(brand) : null;
    }
    const result = await pool.query('SELECT * FROM cc_os_brands WHERE workspace_key=$1 AND is_default ORDER BY created_at LIMIT 1', [workspaceKey]);
    return result.rows[0] ? mapOsBrandRow(result.rows[0]) : null;
  }

  async function uniqueOsBrandSlug(workspaceKey, base) {
    const taken = new Set();
    if (!pool || !ready) {
      for (const brand of localOsBrands.values()) if (brand.workspaceKey === workspaceKey) taken.add(brand.slug);
    } else {
      const result = await pool.query('SELECT slug FROM cc_os_brands WHERE workspace_key=$1', [workspaceKey]);
      for (const row of result.rows) taken.add(row.slug);
    }
    if (!taken.has(base)) return base;
    let index = 2;
    while (taken.has(`${base}-${index}`)) index += 1;
    return `${base}-${index}`;
  }

  async function createOsBrand(workspaceKey, input) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const slug = await uniqueOsBrandSlug(workspaceKey, osBrandSlug(input.name));
    const siblings = await osBrands(workspaceKey);
    const isDefault = Boolean(input.isDefault) || !siblings.length;
    if (!pool || !ready) {
      if (isDefault) for (const brand of localOsBrands.values()) if (brand.workspaceKey === workspaceKey) brand.isDefault = false;
      const brand = {
        id, workspaceKey, name: input.name, slug,
        description: input.description || null, audience: input.audience || null,
        voice: input.voice || null, styleDirectives: input.styleDirectives || null,
        palette: input.palette || [], bannedWords: input.bannedWords || [],
        logoAssetId: input.logoAssetId || null, isDefault, createdAt: now, updatedAt: now
      };
      localOsBrands.set(id, brand);
      return { ...mapOsBrandRow(brand), durable: false };
    }
    if (isDefault) await pool.query('UPDATE cc_os_brands SET is_default=FALSE,updated_at=NOW() WHERE workspace_key=$1 AND is_default', [workspaceKey]);
    const result = await pool.query(
      `INSERT INTO cc_os_brands (id,workspace_key,name,slug,description,audience,voice,style_directives,palette,banned_words,logo_asset_id,is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12) RETURNING *`,
      [id, workspaceKey, input.name, slug, input.description || null, input.audience || null, input.voice || null, input.styleDirectives || null, safeJson(input.palette || []), safeJson(input.bannedWords || []), input.logoAssetId || null, isDefault]
    );
    return { ...mapOsBrandRow(result.rows[0]), durable: true };
  }

  async function updateOsBrand(workspaceKey, id, patch) {
    const now = new Date().toISOString();
    if (!pool || !ready) {
      const brand = localOsBrands.get(id);
      if (!brand || brand.workspaceKey !== workspaceKey) return null;
      if (patch.isDefault === true) for (const item of localOsBrands.values()) if (item.workspaceKey === workspaceKey && item.id !== id) item.isDefault = false;
      if (patch.name !== undefined) brand.name = patch.name;
      if (patch.description !== undefined) brand.description = patch.description;
      if (patch.audience !== undefined) brand.audience = patch.audience;
      if (patch.voice !== undefined) brand.voice = patch.voice;
      if (patch.styleDirectives !== undefined) brand.styleDirectives = patch.styleDirectives;
      if (patch.palette !== undefined) brand.palette = patch.palette;
      if (patch.bannedWords !== undefined) brand.bannedWords = patch.bannedWords;
      if (patch.logoAssetId !== undefined) brand.logoAssetId = patch.logoAssetId;
      if (patch.isDefault !== undefined) brand.isDefault = Boolean(patch.isDefault);
      brand.updatedAt = now;
      return { ...mapOsBrandRow(brand), durable: false };
    }
    const values = [workspaceKey, id];
    const sets = [];
    const push = (column, value, cast = '') => { values.push(value); sets.push(`${column}=$${values.length}${cast}`); };
    if (patch.name !== undefined) push('name', patch.name);
    if (patch.description !== undefined) push('description', patch.description);
    if (patch.audience !== undefined) push('audience', patch.audience);
    if (patch.voice !== undefined) push('voice', patch.voice);
    if (patch.styleDirectives !== undefined) push('style_directives', patch.styleDirectives);
    if (patch.palette !== undefined) push('palette', safeJson(patch.palette), '::jsonb');
    if (patch.bannedWords !== undefined) push('banned_words', safeJson(patch.bannedWords), '::jsonb');
    if (patch.logoAssetId !== undefined) push('logo_asset_id', patch.logoAssetId);
    if (patch.isDefault !== undefined) push('is_default', Boolean(patch.isDefault));
    if (!sets.length) return osBrand(workspaceKey, id);
    if (patch.isDefault === true) await pool.query('UPDATE cc_os_brands SET is_default=FALSE,updated_at=NOW() WHERE workspace_key=$1 AND is_default AND id<>$2', [workspaceKey, id]);
    sets.push('updated_at=NOW()');
    const result = await pool.query(`UPDATE cc_os_brands SET ${sets.join(',')} WHERE workspace_key=$1 AND id=$2 RETURNING *`, values);
    return result.rows[0] ? { ...mapOsBrandRow(result.rows[0]), durable: true } : null;
  }

  // Deleting a brand keeps history: assets and generation jobs stay in place
  // with brand_id nulled out rather than being cascaded away.
  async function deleteOsBrand(workspaceKey, id) {
    if (!pool || !ready) {
      const brand = localOsBrands.get(id);
      if (!brand || brand.workspaceKey !== workspaceKey) return false;
      localOsBrands.delete(id);
      for (const asset of localOsAssets.values()) if (asset.workspaceKey === workspaceKey && asset.brandId === id) asset.brandId = null;
      for (const job of localOsGenerationJobs.values()) if (job.workspaceKey === workspaceKey && job.brandId === id) job.brandId = null;
      return true;
    }
    const result = await pool.query('DELETE FROM cc_os_brands WHERE workspace_key=$1 AND id=$2 RETURNING id', [workspaceKey, id]);
    if (!result.rows[0]) return false;
    await pool.query('UPDATE cc_os_assets SET brand_id=NULL WHERE workspace_key=$1 AND brand_id=$2', [workspaceKey, id]);
    await pool.query('UPDATE cc_os_generation_jobs SET brand_id=NULL WHERE workspace_key=$1 AND brand_id=$2', [workspaceKey, id]);
    return true;
  }

  async function saveOsChannelMetrics(workspaceKey, channel, date, values) {
    const row = {
      channel,
      date,
      spend: Number(values.spend || 0),
      impressions: Number(values.impressions || 0),
      clicks: Number(values.clicks || 0),
      leads: Number(values.leads || 0),
      sales: Number(values.sales || 0),
      revenue: Number(values.revenue || 0),
      raw: values.raw || {},
      syncedAt: new Date().toISOString()
    };
    if (!pool || !ready) {
      localOsChannelMetrics.set(`${workspaceKey}:${channel}:${date}`, { workspaceKey, ...row });
      return { ...row, durable: false };
    }
    const result = await pool.query(
      `INSERT INTO cc_os_channel_metrics (workspace_key,channel,date,spend,impressions,clicks,leads,sales,revenue,raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (workspace_key,channel,date)
       DO UPDATE SET spend=EXCLUDED.spend,impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,leads=EXCLUDED.leads,sales=EXCLUDED.sales,revenue=EXCLUDED.revenue,raw=EXCLUDED.raw,synced_at=NOW()
       RETURNING channel,date,spend,impressions,clicks,leads,sales,revenue,raw,synced_at`,
      [workspaceKey, channel, date, row.spend, row.impressions, row.clicks, row.leads, row.sales, row.revenue, safeJson(row.raw)]
    );
    const saved = result.rows[0];
    return {
      channel: saved.channel, date: saved.date, spend: Number(saved.spend || 0), impressions: Number(saved.impressions || 0),
      clicks: Number(saved.clicks || 0), leads: Number(saved.leads || 0), sales: Number(saved.sales || 0),
      revenue: Number(saved.revenue || 0), raw: saved.raw || {}, syncedAt: saved.synced_at, durable: true
    };
  }

  function mapOsChannelMetricRow(row) {
    return {
      channel: row.channel,
      date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date),
      spend: Number(row.spend || 0),
      impressions: Number(row.impressions || 0),
      clicks: Number(row.clicks || 0),
      leads: Number(row.leads || 0),
      sales: Number(row.sales || 0),
      revenue: Number(row.revenue || 0),
      raw: row.raw || {},
      syncedAt: row.synced_at || row.syncedAt
    };
  }

  async function osChannelMetrics(workspaceKey) {
    if (!pool || !ready) {
      return [...localOsChannelMetrics.values()]
        .filter((row) => row.workspaceKey === workspaceKey)
        .map(mapOsChannelMetricRow)
        .sort((a, b) => b.date.localeCompare(a.date));
    }
    const result = await pool.query(
      'SELECT channel,date,spend,impressions,clicks,leads,sales,revenue,raw,synced_at FROM cc_os_channel_metrics WHERE workspace_key=$1 ORDER BY date DESC LIMIT 1000',
      [workspaceKey]
    );
    return result.rows.map(mapOsChannelMetricRow);
  }

  async function osChannelMetricsTotals(workspaceKey, sinceDays = 30) {
    const empty = { spend: 0, impressions: 0, clicks: 0, leads: 0, sales: 0, revenue: 0, rows: 0, lastSyncAt: null };
    const cutoff = new Date(Date.now() - Number(sinceDays || 30) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (!pool || !ready) {
      const totals = { ...empty };
      for (const row of localOsChannelMetrics.values()) {
        if (row.workspaceKey !== workspaceKey || row.date < cutoff) continue;
        totals.spend += Number(row.spend || 0);
        totals.impressions += Number(row.impressions || 0);
        totals.clicks += Number(row.clicks || 0);
        totals.leads += Number(row.leads || 0);
        totals.sales += Number(row.sales || 0);
        totals.revenue += Number(row.revenue || 0);
        totals.rows += 1;
        if (!totals.lastSyncAt || row.syncedAt > totals.lastSyncAt) totals.lastSyncAt = row.syncedAt;
      }
      return totals;
    }
    const result = await pool.query(
      `SELECT COUNT(*)::int AS rows,
              COALESCE(SUM(spend),0)::float AS spend,
              COALESCE(SUM(impressions),0)::float AS impressions,
              COALESCE(SUM(clicks),0)::float AS clicks,
              COALESCE(SUM(leads),0)::float AS leads,
              COALESCE(SUM(sales),0)::float AS sales,
              COALESCE(SUM(revenue),0)::float AS revenue,
              MAX(synced_at) AS last_sync_at
       FROM cc_os_channel_metrics WHERE workspace_key=$1 AND date>=$2`,
      [workspaceKey, cutoff]
    );
    const row = result.rows[0] || {};
    return {
      spend: Number(row.spend || 0), impressions: Number(row.impressions || 0), clicks: Number(row.clicks || 0),
      leads: Number(row.leads || 0), sales: Number(row.sales || 0), revenue: Number(row.revenue || 0),
      rows: Number(row.rows || 0), lastSyncAt: row.last_sync_at || null
    };
  }

  async function ping() {
    if (!pool || !ready) return false;
    await pool.query('SELECT 1');
    return true;
  }

  async function close() {
    if (pool) await pool.end();
  }

  return {
    enabled,
    get ready() { return ready; },
    init,
    ping,
    close,
    createAccount,
    userForLogin,
    createSession,
    memberForToken,
    revokeSession,
    verifyEmail,
    createPasswordReset,
    resetPassword,
    linkChat,
    saveMemberInterest,
    saveGuideProfile,
    dashboard,
    updateProfile,
    requestDeletion,
    recordPurchase,
    recordBooking,
    queueOutbox,
    claimOutbox,
    completeOutbox,
    failOutbox,
    outboxStats,
    osState,
    saveOsDecision,
    saveOsQueueControl,
    osExperiments,
    createOsExperiment,
    addOsExperimentVariant,
    saveOsVariantMetrics,
    osGenerationJobs,
    createOsGenerationJob,
    claimNextOsGenerationJob,
    completeOsGenerationJob,
    failOsGenerationJob,
    saveOsGenerationJobResolvedPrompt,
    osConnections,
    saveOsConnection,
    osConnectionToken,
    saveOsPublication,
    osPublications,
    osMetricsTotals,
    createOsAsset,
    osAssets,
    osAsset,
    osBrands,
    osBrand,
    osDefaultBrand,
    createOsBrand,
    updateOsBrand,
    deleteOsBrand,
    saveOsChannelMetrics,
    osChannelMetrics,
    osChannelMetricsTotals
  };
}
