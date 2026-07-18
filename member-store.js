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
    outboxStats
  };
}
