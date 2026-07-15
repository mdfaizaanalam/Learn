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

  // Tracks Razorpay payment IDs that have already been redeemed for a
  // subscription upgrade, so the same payment can never be replayed against
  // this account or a different one to grant premium access twice.
  const usedPaymentsTableQuery = `
    CREATE TABLE IF NOT EXISTS used_payment_ids (
      payment_id VARCHAR(255) PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redeemed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // Stores single-use, expiring tokens for the "Forgot Password" flow. A
  // token is only ever valid until used_at is set or expires_at passes.
  const passwordResetTokensTableQuery = `
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token VARCHAR(255) PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      used_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  try {
    await query(userTableQuery);
    await query(usedPaymentsTableQuery);
    await query(passwordResetTokensTableQuery);

    // Create the user subscription sync trigger function
    await query(`
      CREATE OR REPLACE FUNCTION sync_user_subscription_trigger()
      RETURNS TRIGGER AS $$
      BEGIN
        -- If is_subscribed is manually set to TRUE, and the query did NOT explicitly provide/change the plan_end_date,
        -- then automatically calculate and sync the premium plan details.
        IF NEW.is_subscribed = TRUE 
           AND (TG_OP = 'INSERT' 
                OR (OLD.is_subscribed = FALSE OR OLD.is_subscribed IS NULL)
                   AND (NEW.plan_end_date IS NOT DISTINCT FROM OLD.plan_end_date OR NEW.plan_end_date IS NULL)
               )
        THEN
          IF NEW.plan_type = 'trial' OR NEW.plan_type IS NULL THEN
            NEW.plan_type := 'monthly';
          END IF;
          
          -- If plan_end_date is NULL or has expired, start the subscription from now
          IF NEW.plan_end_date IS NULL OR NEW.plan_end_date <= CURRENT_TIMESTAMP THEN
            NEW.plan_start_date := CURRENT_TIMESTAMP;
            IF NEW.plan_type = 'quarterly' THEN
              NEW.plan_end_date := CURRENT_TIMESTAMP + INTERVAL '90 days';
            ELSE
              NEW.plan_end_date := CURRENT_TIMESTAMP + INTERVAL '30 days';
            END IF;
          -- If it's not expired but the end date is a short trial duration, extend it to a full subscription
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

    // Create the trigger itself, dropping it first if it exists to be safe
    await query(`DROP TRIGGER IF EXISTS trg_sync_user_subscription ON users;`);
    await query(`
      CREATE TRIGGER trg_sync_user_subscription
      BEFORE INSERT OR UPDATE ON users
      FOR EACH ROW
      EXECUTE FUNCTION sync_user_subscription_trigger();
    `);

    // Add additional fields dynamically if they do not exist
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS xp INTEGER DEFAULT 0;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 1;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS streak INTEGER DEFAULT 0;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_played_date VARCHAR(100);`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS accuracy REAL DEFAULT 100;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played INTEGER DEFAULT 0;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS games_won INTEGER DEFAULT 0;`);
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
        is_subscribed = CASE
          WHEN (CASE WHEN is_subscribed = TRUE AND plan_type IN ('monthly', 'quarterly') THEN plan_type WHEN is_subscribed = TRUE THEN 'monthly' WHEN plan_type IN ('trial', 'monthly', 'quarterly') THEN plan_type ELSE 'trial' END) IN ('monthly', 'quarterly')
               AND COALESCE(
                 CASE
                   WHEN plan_end_date IS NOT NULL AND NOT (is_subscribed = TRUE AND plan_end_date <= COALESCE(plan_start_date, created_at, CURRENT_TIMESTAMP) + INTERVAL '3 days') THEN plan_end_date
                   ELSE COALESCE(plan_start_date, created_at, CURRENT_TIMESTAMP) + CASE
                     WHEN (CASE WHEN is_subscribed = TRUE AND plan_type IN ('monthly', 'quarterly') THEN plan_type WHEN is_subscribed = TRUE THEN 'monthly' WHEN plan_type IN ('trial', 'monthly', 'quarterly') THEN plan_type ELSE 'trial' END) = 'quarterly' THEN INTERVAL '90 days'
                     WHEN (CASE WHEN is_subscribed = TRUE AND plan_type IN ('monthly', 'quarterly') THEN plan_type WHEN is_subscribed = TRUE THEN 'monthly' WHEN plan_type IN ('trial', 'monthly', 'quarterly') THEN plan_type ELSE 'trial' END) = 'monthly' THEN INTERVAL '30 days'
                     ELSE INTERVAL '3 days'
                   END
                 END,
                 CURRENT_TIMESTAMP - INTERVAL '1 second'
               ) > CURRENT_TIMESTAMP
               AND COALESCE(subscription_status, 'active') = 'active'
          THEN TRUE
          ELSE FALSE
        END,
        latin_used_today = COALESCE(latin_used_today, 0),
        figure_used_today = COALESCE(figure_used_today, 0),
        math_used_today = COALESCE(math_used_today, 0),
        last_usage_reset_date = COALESCE(last_usage_reset_date, CURRENT_DATE),
        updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)
      WHERE
        plan_type IS NULL
        OR plan_start_date IS NULL
        OR plan_end_date IS NULL
        OR subscription_status IS NULL
        OR last_usage_reset_date IS NULL
        OR updated_at IS NULL
        OR (is_subscribed = TRUE AND plan_type = 'trial')
        OR (is_subscribed = TRUE AND plan_end_date <= plan_start_date + INTERVAL '3 days');
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