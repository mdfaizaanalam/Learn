import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("CRITICAL: DATABASE_URL is not set in environment variables!");
  process.exit(1);
}

const hasSslModeInUrl = /sslmode=/.test(connectionString);
const isLocalDb = /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  ...(hasSslModeInUrl
    ? {} // trust the sslmode already encoded in the URL
    : { ssl: isLocalDb ? false : { rejectUnauthorized: false } }),
  options: '-c timezone=UTC'
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle pg client', err);
});

// Helper query function
export const query = (text, params) => pool.query(text, params);

// Initialize DB schema
export const initSchema = async () => {
  // ── Core users table ────────────────────────────────────────────────────────
  const userTableQuery = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      is_subscribed BOOLEAN DEFAULT FALSE,
      subscription_id VARCHAR(255),
      plan_type VARCHAR(20) DEFAULT 'trial',
      plan_start_date TIMESTAMP WITH TIME ZONE,
      plan_end_date TIMESTAMP WITH TIME ZONE,
      subscription_status VARCHAR(20) DEFAULT 'active',
      latin_used_today INTEGER DEFAULT 0,
      figure_used_today INTEGER DEFAULT 0,
      math_used_today INTEGER DEFAULT 0,
      last_usage_reset_date DATE,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // ── Payment replay-prevention table ────────────────────────────────────────
  const usedPaymentsTableQuery = `
    CREATE TABLE IF NOT EXISTS used_payment_ids (
      payment_id VARCHAR(255) PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redeemed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // ── Single-use password reset tokens ───────────────────────────────────────
  const passwordResetTokensTableQuery = `
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token VARCHAR(255) PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      used_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // ── Daily 30-question streak challenge ─────────────────────────────────────
  const dailyChallengesTableQuery = `
    CREATE TABLE IF NOT EXISTS daily_challenges (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      challenge_date DATE NOT NULL,
      questions JSONB NOT NULL,
      answers JSONB DEFAULT '{}',
      score INTEGER DEFAULT 0,
      is_completed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, challenge_date)
    );
  `;

  // ── Exam session history ────────────────────────────────────────────────────
  // Records every EXAM attempt (Core Module subtests, Subject Modules, Full TestAS).
  // This table is ONLY for timed exam simulator sessions, NOT free practice.
  // module values: 'figure-sequence' | 'math-equations' | 'latin-square' |
  //                'medicine' | 'engineering' | 'math-cs' | 'full'
  const examSessionsTableQuery = `
    CREATE TABLE IF NOT EXISTS exam_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      module VARCHAR(60) NOT NULL,
      exam_type VARCHAR(20) NOT NULL DEFAULT 'core',
      total_questions INTEGER NOT NULL DEFAULT 0,
      correct_answers INTEGER NOT NULL DEFAULT 0,
      wrong_answers INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      score_percent REAL NOT NULL DEFAULT 0,
      time_taken_seconds INTEGER DEFAULT 0,
      plan_type VARCHAR(20) DEFAULT 'trial',
      completed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // ── Core practice session log ───────────────────────────────────────────────
  // Records every FREE PRACTICE question solved in the Core Module practice
  // pages: Latin Square, Figure Sequences, Math Reasoning.
  // Only stores CORRECT questions solved — no wrong/skipped tracking for free practice.
  // module values: 'latin-square' | 'figure-sequence' | 'math-equations'
  const practiceSessionsTableQuery = `
    CREATE TABLE IF NOT EXISTS practice_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      module VARCHAR(60) NOT NULL,
      correct_count INTEGER NOT NULL DEFAULT 0,
      plan_type VARCHAR(20) DEFAULT 'trial',
      practiced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // ── User achievements ───────────────────────────────────────────────────────
  // Stores which achievements each user has unlocked, with timestamp.
  const userAchievementsTableQuery = `
    CREATE TABLE IF NOT EXISTS user_achievements (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      achievement_id VARCHAR(100) NOT NULL,
      unlocked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, achievement_id)
    );
  `;

  try {
    await query(userTableQuery);
    await query(usedPaymentsTableQuery);
    await query(passwordResetTokensTableQuery);
    await query(dailyChallengesTableQuery);
    await query(examSessionsTableQuery);
    await query(practiceSessionsTableQuery);
    await query(userAchievementsTableQuery);

    // ── Subscription sync trigger ───────────────────────────────────────────
    await query(`
      CREATE OR REPLACE FUNCTION sync_user_subscription_trigger()
      RETURNS TRIGGER AS $$
      BEGIN
        -- If user transitions to premium (or premium status is initialized), reset solved counts to 0
        IF NEW.is_subscribed = TRUE AND (TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.is_subscribed IS DISTINCT FROM TRUE)) THEN
          NEW.latin_used_today := 0;
          NEW.figure_used_today := 0;
          NEW.math_used_today := 0;
          NEW.xp := 0;
          NEW.level := 1;
          NEW.streak := 0;
          NEW.last_played_date := NULL;
          NEW.games_played := 0;
          NEW.fastest_solve_seconds := NULL;
          NEW.cognitive_profile := '{"figureReasoning":50,"mathLogic":50,"verbal":50,"speed":50,"accuracy":50,"consistency":50}'::jsonb;
          NEW.topic_mastery := '{}'::jsonb;

          IF TG_OP = 'UPDATE' THEN
            DELETE FROM practice_sessions WHERE user_id = NEW.id;
            DELETE FROM exam_sessions WHERE user_id = NEW.id;
            DELETE FROM user_achievements WHERE user_id = NEW.id;
          END IF;
        END IF;

        IF NEW.is_subscribed = TRUE 
           AND (TG_OP = 'INSERT' 
                OR (TG_OP = 'UPDATE' AND (OLD.is_subscribed = FALSE OR OLD.is_subscribed IS NULL)
                    AND (NEW.plan_end_date IS NOT DISTINCT FROM OLD.plan_end_date OR NEW.plan_end_date IS NULL))
               )
        THEN
          IF NEW.plan_type = 'trial' OR NEW.plan_type IS NULL THEN
            NEW.plan_type := 'monthly';
          END IF;
          
          IF NEW.plan_end_date IS NULL OR NEW.plan_end_date <= CURRENT_TIMESTAMP THEN
            NEW.plan_start_date := CURRENT_TIMESTAMP;
            IF NEW.plan_type = 'quarterly' THEN
              NEW.plan_end_date := CURRENT_TIMESTAMP + INTERVAL '90 days';
            ELSE
              NEW.plan_end_date := CURRENT_TIMESTAMP + INTERVAL '30 days';
            END IF;
          ELSIF NEW.plan_end_date <= COALESCE(NEW.plan_start_date, CURRENT_TIMESTAMP) + INTERVAL '3 days' THEN
            IF NEW.plan_start_date IS NULL THEN
              NEW.plan_start_date := CURRENT_TIMESTAMP;
            END IF;
            IF NEW.plan_type = 'quarterly' THEN
              NEW.plan_end_date := NEW.plan_start_date + INTERVAL '90 days';
            ELSE
              NEW.plan_end_date := NEW.plan_start_date + INTERVAL '30 days';
            END IF;
          END IF;
          
          NEW.subscription_status := 'active';
          NEW.subscribed_at := COALESCE(NEW.subscribed_at, NEW.plan_start_date);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await query(`DROP TRIGGER IF EXISTS trg_sync_user_subscription ON users;`);
    await query(`
      CREATE TRIGGER trg_sync_user_subscription
      BEFORE INSERT OR UPDATE ON users
      FOR EACH ROW
      EXECUTE FUNCTION sync_user_subscription_trigger();
    `);

    // ── Additive ALTER TABLE migrations (safe, non-destructive) ────────────
    // Gamification fields
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS xp INTEGER DEFAULT 0;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 1;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS streak INTEGER DEFAULT 0;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_played_date VARCHAR(100);`);
    // games_played = total exam sessions attempted (repurposed counter)
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played INTEGER DEFAULT 0;`);
    // fastest_solve_seconds — persisted server-side so clearing browser doesn't lose it
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fastest_solve_seconds INTEGER DEFAULT NULL;`);

    // Cognitive profile & topic mastery stored as JSONB for 100% DB persistence
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS cognitive_profile JSONB DEFAULT '{"figureReasoning":50,"mathLogic":50,"verbal":50,"speed":50,"accuracy":50,"consistency":50}';`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS topic_mastery JSONB DEFAULT '{}';`);

    // UI/app settings (theme, symbol system, sound, etc.) stored as JSONB —
    // replaces the old localStorage-only 'latin-square-settings' store so
    // preferences persist across devices/browsers instead of living only
    // in the browser.
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{"theme":"dark","symbolSystem":"alphabets","soundEnabled":true,"reducedMotion":false,"notifications":true,"language":"en"}';`);

    // E-book library columns to sync favorites, recents, and page progress
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS library_favorites JSONB DEFAULT '[]';`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS library_recents JSONB DEFAULT '[]';`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS library_progress JSONB DEFAULT '{}';`);

    // Subscription fields
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscribed_at TIMESTAMP WITH TIME ZONE;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_subscribed BOOLEAN DEFAULT FALSE;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_type VARCHAR(20) DEFAULT 'trial';`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_start_date TIMESTAMP WITH TIME ZONE;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_end_date TIMESTAMP WITH TIME ZONE;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) DEFAULT 'active';`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS latin_used_today INTEGER DEFAULT 0;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS figure_used_today INTEGER DEFAULT 0;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS math_used_today INTEGER DEFAULT 0;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_usage_reset_date DATE;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS max_pages_read INTEGER DEFAULT 0;`);

    // ── Remove unused columns (if they exist) ──────────────────────────────
    // games_won is now computed from exam_sessions (score_percent >= 50)
    // accuracy is computed from exam_sessions
    // These are dropped with IF EXISTS so it's safe on fresh DBs
    await query(`ALTER TABLE users DROP COLUMN IF EXISTS games_won;`);
    await query(`ALTER TABLE users DROP COLUMN IF EXISTS accuracy;`);

    // ── Backfill defaults for existing rows ────────────────────────────────
    await query(`
      UPDATE users
      SET
        plan_type = CASE
          WHEN is_subscribed = TRUE AND plan_type IN ('monthly', 'quarterly') THEN plan_type
          WHEN is_subscribed = TRUE THEN 'monthly'
          WHEN plan_type IN ('trial', 'monthly', 'quarterly') THEN plan_type
          ELSE 'trial'
        END,
        plan_start_date = COALESCE(plan_start_date, created_at, CURRENT_TIMESTAMP),
        plan_end_date = CASE
          WHEN plan_end_date IS NOT NULL AND NOT (is_subscribed = TRUE AND plan_end_date <= COALESCE(plan_start_date, created_at, CURRENT_TIMESTAMP) + INTERVAL '3 days') THEN plan_end_date
          ELSE COALESCE(plan_start_date, created_at, CURRENT_TIMESTAMP) + CASE
            WHEN (CASE WHEN is_subscribed = TRUE AND plan_type IN ('monthly', 'quarterly') THEN plan_type WHEN is_subscribed = TRUE THEN 'monthly' WHEN plan_type IN ('trial', 'monthly', 'quarterly') THEN plan_type ELSE 'trial' END) = 'quarterly' THEN INTERVAL '90 days'
            WHEN (CASE WHEN is_subscribed = TRUE AND plan_type IN ('monthly', 'quarterly') THEN plan_type WHEN is_subscribed = TRUE THEN 'monthly' WHEN plan_type IN ('trial', 'monthly', 'quarterly') THEN plan_type ELSE 'trial' END) = 'monthly' THEN INTERVAL '30 days'
            ELSE INTERVAL '3 days'
          END
        END,
        subscribed_at = CASE 
          WHEN (CASE WHEN is_subscribed = TRUE AND plan_type IN ('monthly', 'quarterly') THEN plan_type WHEN is_subscribed = TRUE THEN 'monthly' WHEN plan_type IN ('trial', 'monthly', 'quarterly') THEN plan_type ELSE 'trial' END) IN ('monthly', 'quarterly') THEN COALESCE(subscribed_at, plan_start_date, created_at, CURRENT_TIMESTAMP) 
          ELSE NULL 
        END,
        subscription_status = CASE
          WHEN subscription_status = 'cancelled' THEN 'cancelled'
          WHEN COALESCE(
            CASE
              WHEN plan_end_date IS NOT NULL AND NOT (is_subscribed = TRUE AND plan_end_date <= COALESCE(plan_start_date, created_at, CURRENT_TIMESTAMP) + INTERVAL '3 days') THEN plan_end_date
              ELSE COALESCE(plan_start_date, created_at, CURRENT_TIMESTAMP) + CASE
                WHEN (CASE WHEN is_subscribed = TRUE AND plan_type IN ('monthly', 'quarterly') THEN plan_type WHEN is_subscribed = TRUE THEN 'monthly' WHEN plan_type IN ('trial', 'monthly', 'quarterly') THEN plan_type ELSE 'trial' END) = 'quarterly' THEN INTERVAL '90 days'
                WHEN (CASE WHEN is_subscribed = TRUE AND plan_type IN ('monthly', 'quarterly') THEN plan_type WHEN is_subscribed = TRUE THEN 'monthly' WHEN plan_type IN ('trial', 'monthly', 'quarterly') THEN plan_type ELSE 'trial' END) = 'monthly' THEN INTERVAL '30 days'
                ELSE INTERVAL '3 days'
              END
            END,
            CURRENT_TIMESTAMP
          ) <= CURRENT_TIMESTAMP THEN 'expired'
          WHEN subscription_status IN ('active', 'expired') THEN subscription_status
          ELSE 'active'
        END,
        latin_used_today = COALESCE(latin_used_today, 0),
        figure_used_today = COALESCE(figure_used_today, 0),
        math_used_today = COALESCE(math_used_today, 0),
        last_usage_reset_date = COALESCE(last_usage_reset_date, CURRENT_DATE),
        updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP),
        games_played = COALESCE(games_played, 0),
        xp = COALESCE(xp, 0),
        level = COALESCE(level, 1),
        streak = COALESCE(streak, 0),
        library_favorites = COALESCE(library_favorites, '[]'::jsonb),
        library_recents = COALESCE(library_recents, '[]'::jsonb),
        library_progress = COALESCE(library_progress, '{}'::jsonb)
      WHERE
        plan_type IS NULL
        OR plan_start_date IS NULL
        OR plan_end_date IS NULL
        OR subscription_status IS NULL
        OR last_usage_reset_date IS NULL
        OR updated_at IS NULL
        OR (is_subscribed = TRUE AND plan_type = 'trial')
        OR (is_subscribed = TRUE AND plan_end_date <= plan_start_date + INTERVAL '3 days')
        OR library_favorites IS NULL
        OR library_recents IS NULL
        OR library_progress IS NULL;
    `);

    console.log("Database tables initialized successfully or already exist.");
  } catch (err) {
    console.error("Error creating database tables:", err);
    throw err;
  }
};

export default {
  query,
  initSchema,
  pool
};