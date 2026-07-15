import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import db, { initSchema } from './db.js';
import { askAI, askAIVision, generateNIMImage } from './aiService.js';

dotenv.config();


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VALID_PLAN_TYPES = new Set(['trial', 'monthly', 'quarterly']);
const VALID_STATUSES = new Set(['active', 'expired', 'cancelled']);
const TRIAL_DAILY_LIMIT = 5;
const USAGE_COLUMN_BY_TYPE = {
  latin: 'latin_used_today',
  figure: 'figure_used_today',
  math: 'math_used_today'
};
const TRIAL_LIMIT_MESSAGE_BY_TYPE = {
  latin: 'Daily Latin Square limit reached. Upgrade to Premium or come back tomorrow.',
  figure: 'Daily Figure Sequence limit reached. Upgrade to Premium or come back tomorrow.',
  math: 'Daily Math limit reached. Upgrade to Premium or come back tomorrow.'
};

const parseDateSafe = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const getUtcStartOfDay = (dateValue = new Date()) => {
  const date = parseDateSafe(dateValue) || new Date();
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
};

const toIsoDateString = (dateValue) => {
  if (typeof dateValue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    return dateValue;
  }
  const date = parseDateSafe(dateValue);
  if (!date) return null;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const calculateRemainingDays = (endDateValue) => {
  const endDate = parseDateSafe(endDateValue);
  if (!endDate) return 0;
  const diffMs = getUtcStartOfDay(endDate).getTime() - getUtcStartOfDay().getTime();
  return Math.max(0, Math.floor(diffMs / 86400000));
};

const isSubscriptionExpired = (endDateValue) => {
  const endDate = parseDateSafe(endDateValue);
  if (!endDate) return true;
  return Date.now() > endDate.getTime();
};

const normalizePlanType = (user) => {
  if (VALID_PLAN_TYPES.has(user.plan_type)) return user.plan_type;

  const planStartDate = parseDateSafe(user.plan_start_date);
  const planEndDate = parseDateSafe(user.plan_end_date);
  if (planStartDate && planEndDate) {
    const days = Math.round((planEndDate.getTime() - planStartDate.getTime()) / 86400000);
    if (Math.abs(days - 90) <= 5) return 'quarterly';
    if (Math.abs(days - 30) <= 5) return 'monthly';
  }

  return 'trial';
};

const resolveSubscriptionDates = (user) => {
  const planType = normalizePlanType(user);
  const planStartDate = parseDateSafe(user.plan_start_date) || parseDateSafe(user.created_at);
  const planEndDate = parseDateSafe(user.plan_end_date);
  return { planType, planStartDate, planEndDate };
};

const isPremiumPlan = (planType) => planType === 'monthly' || planType === 'quarterly';

const checkSubscriptionStatus = (user) => {
  const { planType, planEndDate } = resolveSubscriptionDates(user);
  const status = VALID_STATUSES.has(user.subscription_status) ? user.subscription_status : 'active';
  return isPremiumPlan(planType) && status === 'active' && !isSubscriptionExpired(planEndDate);
};

const normalizeUsageType = (usageTypeRaw) => {
  if (!usageTypeRaw || typeof usageTypeRaw !== 'string') return null;
  const value = usageTypeRaw.trim().toLowerCase();
  if (value === 'latin' || value === 'latin-square' || value === 'latinsquare') return 'latin';
  if (value === 'figure' || value === 'figure-sequence' || value === 'figuresequence') return 'figure';
  if (value === 'math' || value === 'mathematics') return 'math';
  return null;
};

const syncUserSubscriptionState = async (user) => {
  let { planType, planStartDate, planEndDate } = resolveSubscriptionDates(user);

  // Developer override logic: if is_subscribed is marked true manually in the
  // database (e.g. for testing), make sure the plan actually reflects a real
  // premium duration instead of leftover/inconsistent dates.
  if (user.is_subscribed) {
    if (planType === 'trial') {
      // Manually flipped is_subscribed=true but plan_type was never changed
      // from 'trial' — treat it as a monthly upgrade.
      planType = 'monthly';
    }

    // Whatever premium plan_type it now is, make sure plan_start_date /
    // plan_end_date actually span the real duration for that plan (30 days
    // for monthly, 90 for quarterly) instead of some stale/hand-edited gap.
    const expectedDurationDays = planType === 'quarterly' ? 90 : 30;

    // If the plan has expired or has no start date, we start the new premium duration from now (new Date()).
    // Otherwise, we preserve the existing planStartDate.
    const referenceStart = (planStartDate && !isSubscriptionExpired(planEndDate))
      ? planStartDate
      : new Date();

    const actualSpanDays = planEndDate
      ? Math.round((planEndDate.getTime() - referenceStart.getTime()) / 86400000)
      : null;
    const spanLooksWrong = actualSpanDays === null || Math.abs(actualSpanDays - expectedDurationDays) > 2;

    if (!planEndDate || isSubscriptionExpired(planEndDate) || spanLooksWrong) {
      planStartDate = referenceStart;
      planEndDate = new Date(referenceStart.getTime() + expectedDurationDays * 24 * 60 * 60 * 1000);
    }
  }

  const statusFromDb = VALID_STATUSES.has(user.subscription_status) ? user.subscription_status : 'active';
  const computedStatus = (user.is_subscribed || !isSubscriptionExpired(planEndDate)) ? statusFromDb : 'expired';
  const shouldBeSubscribed = user.is_subscribed || (isPremiumPlan(planType) && computedStatus === 'active' && !isSubscriptionExpired(planEndDate));
  const normalizedPlanStartDate = planStartDate || parseDateSafe(user.created_at) || new Date();
  const normalizedPlanEndDate = planEndDate || new Date(normalizedPlanStartDate.getTime() + 3 * 24 * 60 * 60 * 1000);
  const needsUpdate =
    user.plan_type !== planType ||
    user.subscription_status !== computedStatus ||
    user.is_subscribed !== shouldBeSubscribed ||
    toIsoDateString(user.plan_end_date) !== toIsoDateString(normalizedPlanEndDate) ||
    toIsoDateString(user.plan_start_date) !== toIsoDateString(normalizedPlanStartDate);

  if (needsUpdate) {
    await db.query(
      `UPDATE users SET
        plan_type = $1,
        subscription_status = $2,
        is_subscribed = $3,
        plan_start_date = $4,
        plan_end_date = $5,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $6`,
      [
        planType,
        computedStatus,
        shouldBeSubscribed,
        normalizedPlanStartDate,
        normalizedPlanEndDate,
        user.id
      ]
    );
  }

  user.plan_type = planType;
  user.subscription_status = computedStatus;
  user.is_subscribed = shouldBeSubscribed;
  user.plan_start_date = normalizedPlanStartDate;
  user.plan_end_date = normalizedPlanEndDate;
  return user;
};

const resetDailyCounters = async (user) => {
  // IMPORTANT: Do the "is it a new day yet?" comparison entirely inside Postgres
  // using its own CURRENT_DATE, instead of comparing a Node-process-local date
  // string against a Postgres DATE column. Comparing Node's local timezone date
  // to Postgres's CURRENT_DATE (session/DB timezone) can disagree near midnight
  // in either timezone, causing counters to reset on every single request and
  // making trial usage appear to never accumulate / never lock.
  //
  // This single atomic UPDATE only resets (and only touches updated_at) when
  // last_usage_reset_date is NOT today according to Postgres itself.
  const result = await db.query(
    `UPDATE users SET
      latin_used_today = CASE WHEN last_usage_reset_date IS DISTINCT FROM CURRENT_DATE THEN 0 ELSE latin_used_today END,
      figure_used_today = CASE WHEN last_usage_reset_date IS DISTINCT FROM CURRENT_DATE THEN 0 ELSE figure_used_today END,
      math_used_today = CASE WHEN last_usage_reset_date IS DISTINCT FROM CURRENT_DATE THEN 0 ELSE math_used_today END,
      last_usage_reset_date = CURRENT_DATE,
      updated_at = CASE WHEN last_usage_reset_date IS DISTINCT FROM CURRENT_DATE THEN CURRENT_TIMESTAMP ELSE updated_at END
     WHERE id = $1
     RETURNING latin_used_today, figure_used_today, math_used_today, last_usage_reset_date`,
    [user.id]
  );

  if (result.rows[0]) {
    user.latin_used_today = result.rows[0].latin_used_today;
    user.figure_used_today = result.rows[0].figure_used_today;
    user.math_used_today = result.rows[0].math_used_today;
    user.last_usage_reset_date = result.rows[0].last_usage_reset_date;
  }
  return user;
};

const checkTrialLimit = (user, usageType) => {
  const columnName = USAGE_COLUMN_BY_TYPE[usageType];
  if (!columnName) return null;
  const currentValue = Number(user[columnName] ?? 0);
  if (currentValue >= TRIAL_DAILY_LIMIT) {
    return TRIAL_LIMIT_MESSAGE_BY_TYPE[usageType];
  }
  return null;
};

const incrementUsage = async (user, usageType) => {
  const columnName = USAGE_COLUMN_BY_TYPE[usageType];
  if (!columnName) {
    throw new Error(`Unsupported usage type: ${usageType}`);
  }

  const result = await db.query(
    `UPDATE users
     SET ${columnName} = COALESCE(${columnName}, 0) + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING latin_used_today, figure_used_today, math_used_today`,
    [user.id]
  );

  if (result.rows[0]) {
    user.latin_used_today = result.rows[0].latin_used_today;
    user.figure_used_today = result.rows[0].figure_used_today;
    user.math_used_today = result.rows[0].math_used_today;
  }
  return user;
};

const createSubscriptionPayload = (user) => {
  const { planType, planStartDate, planEndDate } = resolveSubscriptionDates(user);
  const status = VALID_STATUSES.has(user.subscription_status) ? user.subscription_status : 'active';
  const remainingDays = status === 'active' ? calculateRemainingDays(planEndDate) : 0;
  const remainingTrialDays = planType === 'trial' && status === 'active' ? calculateRemainingDays(planEndDate) : 0;
  const isUnlimited = isPremiumPlan(planType) && status === 'active';
  const usage = {
    latin: Number(user.latin_used_today ?? 0),
    figure: Number(user.figure_used_today ?? 0),
    math: Number(user.math_used_today ?? 0)
  };
  const dailyLimit = isUnlimited ? { latin: -1, figure: -1, math: -1 } : { latin: 5, figure: 5, math: 5 };

  return {
    success: true,
    planType,
    status,
    startDate: toIsoDateString(planStartDate),
    endDate: toIsoDateString(planEndDate),
    remainingDays,
    remainingTrialDays,
    isUnlimited,
    dailyUsage: usage,
    dailyLimit
  };
};

// ── BREVO EMAIL SENDER (HTTP API) ────────────────────────────────────────────
const sendEmailViaAPI = async ({ toEmail, toName, subject, htmlContent }) => {
  const apiKey = process.env.SMTP_API_KEY;
  const senderEmail = process.env.SMTP_SENDER || (process.env.SMTP_LOGIN && !process.env.SMTP_LOGIN.endsWith('@smtp-brevo.com') ? process.env.SMTP_LOGIN : undefined);

  if (!apiKey) {
    console.error('[Email] SMTP_API_KEY is not defined in environment variables.');
    throw new Error('Email configuration error: SMTP_API_KEY missing');
  }

  if (!senderEmail) {
    console.error('[Email] SMTP_SENDER is not defined in environment variables.');
    throw new Error('Email configuration error: SMTP_SENDER missing');
  }

  if (apiKey.startsWith('xsmtpsib-')) {
    console.error('[Email] Error: You are trying to use an SMTP key (starts with "xsmtpsib-") with Brevo\'s HTTP API. You must use an API key (starts with "xkeysib-"). Please generate one in your Brevo Dashboard under SMTP & API > API Keys.');
    throw new Error('Email configuration error: SMTP key used for HTTP API. Generate a Brevo API key.');
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: {
          name: 'TestAS Mastery',
          email: senderEmail
        },
        to: [
          {
            email: toEmail,
            name: toName || toEmail
          }
        ],
        subject: subject,
        htmlContent: htmlContent
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('[Email] Failed to send email via API:', errorData);
      throw new Error(`Email API error: ${errorData.message || response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[Email] Error in sendEmailViaAPI:', error);
    throw error;
  }
};

// Log email setup readiness on startup
const startupApiKey = process.env.SMTP_API_KEY;
const startupSenderEmail = process.env.SMTP_SENDER || (process.env.SMTP_LOGIN && !process.env.SMTP_LOGIN.endsWith('@smtp-brevo.com') ? process.env.SMTP_LOGIN : undefined);

if (startupApiKey) {
  if (startupApiKey.startsWith('xsmtpsib-')) {
    console.warn('[Email] Warning: You configured SMTP_API_KEY with an SMTP key (starts with "xsmtpsib-"). The HTTP API requires a Brevo API Key (starts with "xkeysib-"). Please generate one in your Brevo Dashboard under SMTP & API > API Keys.');
  } else {
    console.log('[Email] Brevo API configured. Ready to send emails via HTTP API.');
  }
  if (!startupSenderEmail) {
    console.warn('[Email] Warning: SMTP_SENDER is missing in environment variables. You must specify a verified sender email address.');
  }
} else {
  console.warn('[Email] Warning: SMTP_API_KEY is missing. Emails will fail to send.');
}

// ── IN-MEMORY OTP STORE ───────────────────────────────────────────────────────
// Structure: Map<email, { otp, expiresAt, username, passwordHash }>
const otpStore = new Map();
const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// Periodically clean up expired OTPs from the in-memory store to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  let deletedCount = 0;
  for (const [email, stored] of otpStore.entries()) {
    if (now > stored.expiresAt) {
      otpStore.delete(email);
      deletedCount++;
    }
  }
  if (deletedCount > 0) {
    console.log(`[OTP Store Cleanup] Removed ${deletedCount} expired registration OTP(s) from memory.`);
  }
}, 5 * 60 * 1000); // Scan every 5 minutes

const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

const sendOtpEmail = async (toEmail, username, otp) => {
  // IMPORTANT: 'from' must match a VERIFIED SENDER in your Brevo account
  const verifiedSender = process.env.SMTP_SENDER || (process.env.SMTP_LOGIN && !process.env.SMTP_LOGIN.endsWith('@smtp-brevo.com') ? process.env.SMTP_LOGIN : undefined);
  if (!verifiedSender) {
    console.error('[Email] SMTP_SENDER is not defined in environment variables.');
    throw new Error('Email configuration error: SMTP_SENDER missing');
  }
  const mailOptions = {
    from: `"TestAS Mastery" <${verifiedSender}>`,
    to: toEmail,
    subject: 'Your TestAS Mastery Verification Code',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin:0;padding:0;background:#050810;font-family:'Segoe UI',Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#050810;padding:40px 20px;">
          <tr><td align="center">
            <table width="520" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#0f1629,#1a1040);border-radius:20px;border:1px solid rgba(99,102,241,0.2);overflow:hidden;">
              <tr>
                <td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px;text-align:center;">
                  <div style="width:56px;height:56px;background:rgba(255,255,255,0.15);border-radius:14px;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;">
                    <span style="font-size:28px;">&#129504;</span>
                  </div>
                  <h1 style="color:#fff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.5px;">TestAS Mastery</h1>
                  <p style="color:rgba(255,255,255,0.75);margin:6px 0 0;font-size:13px;">Email Verification</p>
                </td>
              </tr>
              <tr>
                <td style="padding:36px 40px;">
                  <p style="color:#e2e8f0;font-size:16px;margin:0 0 8px;">Hi <strong>${username}</strong>,</p>
                  <p style="color:#94a3b8;font-size:14px;margin:0 0 28px;line-height:1.6;">Enter this verification code to complete your registration. This code expires in <strong style="color:#a5b4fc;">10 minutes</strong>.</p>
                  
                  <div style="background:rgba(99,102,241,0.1);border:2px solid rgba(99,102,241,0.3);border-radius:14px;padding:24px;text-align:center;margin-bottom:28px;">
                    <span style="font-size:42px;font-weight:900;letter-spacing:10px;color:#a5b4fc;font-family:monospace;">${otp}</span>
                  </div>
                  
                  <p style="color:#64748b;font-size:12px;margin:0;line-height:1.6;">If you didn't create an account with TestAS Mastery, please ignore this email.</p>
                </td>
              </tr>
              <tr>
                <td style="background:rgba(0,0,0,0.2);padding:20px 40px;border-top:1px solid rgba(255,255,255,0.05);">
                  <p style="color:#475569;font-size:11px;margin:0;text-align:center;">&copy; 2024 TestAS Mastery &middot; All rights reserved</p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `
  };

  console.log(`[Email] Sending OTP email to: ${toEmail} | from: ${verifiedSender}`);
  const info = await sendEmailViaAPI({
    toEmail,
    toName: username,
    subject: 'Your TestAS Mastery Verification Code',
    htmlContent: mailOptions.html
  });
  console.log(`[Email] OTP Email sent successfully. MessageId: ${info?.messageId || 'N/A'}`);
  return info;
};

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_testas_mastery_key_987654321';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000,
  path: '/'
};

// Setup CORS. In dev, Vite's proxy makes requests same-origin so this rarely
// triggers; in production, restrict to the deployed frontend via FRONTEND_URL.
app.use(cors({
  origin: process.env.FRONTEND_URL || true,
  credentials: true
}));

// Screenshots sent to /api/ai/vision arrive as base64 data URLs, which can
// easily exceed Express's default 100kb JSON limit. Raise it accordingly.
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(cookieParser());

// ── RATE LIMITING (auth endpoints) ───────────────────────────────────────────
// Applied only to sensitive auth routes (OTP send/verify, login, password
// reset) to blunt brute-force and spam/abuse attempts, without touching any
// other route in the app.
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 OTP requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many verification requests. Please wait a few minutes and try again." }
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // allow a few more attempts for genuine typos
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many verification attempts. Please wait a few minutes and try again." }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please wait a few minutes and try again." }
});

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many password reset requests. Please wait a few minutes and try again." }
});

// Mapping of book IDs to their encrypted filenames
const BOOK_MAP = {
  'digital-testas-de-1': 'Vorbereitungsbuch für_1_Digitaler TestAS.pdf.enc',
  'digital-testas-de-2': 'Vorbereitungsbuch für_2_Digitaler TestAS.pdf.enc',
  'digital-testas-de-3': 'Vorbereitungsbuch für_3_Digitaler TestAS.pdf.enc',
  'digital-testas-en-1': '1_Preparation_Book_for_the_Digital_TestAS_–_Core_Module_Figure sequences.pdf.enc',
  'digital-testas-en-2': '2_Preparation_Book_for_the_Digital_TestAS_–_Core_Module_Mathematical.pdf.enc',
  'digital-testas-en-3': '3_Preparation_Book_for_the_Digital_TestAS_–_Core_Module_Latin_Squares.pdf.enc',
  'medizin-1': 'Fach Medizin 1.pdf.enc',
  'medizin-2': 'Fach Medizin 2.pdf.enc',
  'medizin-3': 'Fach Medizin 3 .pdf.enc',
  'engineering-de-1': 'Ingenieurwissenschaften 1.pdf.enc',
  'engineering-de-2': 'Ingenieurwissenschaften 2.pdf.enc',
  'engineering-de-3': 'Ingenieurwissenschaften 3.pdf.enc',
  'engineering-de-4': 'Ingenieurwissenschaften 4.pdf.enc',
  'engineering-de-5': 'Ingenieurwissenschaften 5.pdf.enc',
  'testas-prep-de-1': 'Vorbereitungsbuch für den TestAs1.pdf.enc',
  'testas-prep-de-2': 'Vorbereitungsbuch für den TestAs 2.pdf.enc',
  'testas-prep-de-3': 'Vorbereitungsbuch für den TestAs 3.pdf.enc',
  'testas-practice-1': 'TestAs_1_Practice Test for the TestAS Mathematics, Computer Science and Natural Sciences.pdf.enc',
  'testas-practice-2': 'TestAs_2_Practice Test for the TestAS Mathematics, Computer Science and Natural Sciences.pdf.enc',
  'testas-practice-3': 'TestAs_3_Practice Test for the TestAS Mathematics, Computer Science and Natural Sciences.pdf.enc',
  'digital-testas-economics': 'Testas digital Economics module.pdf.enc',
  'digital-testas-engineering-en': 'Testas digital engineering module.pdf.enc',
  'testas-prep-2022': 'Testas_Prep (2022).pdf.enc',
  'digital-testas-cs-en': 'digital testas computer science.pdf.enc',
  'testas-core-en': 'TestAS_Core_English.pdf.enc',
  'testas-math-science-en': 'TestAS_Mathematics_Computer_Science_and_Natural_Sciences_English.pdf.enc',
  'testdaf-b2-c1-erfolg': 'Mit_Erfolg_zum_TestDaF_B2-C1.pdf.enc',
  'goethe-b2-erfolg-ubung': 'mit-erfolg-zum-goethe-zertifikat-b2-bungsbuch.pdf.enc',
  'testdaf-b2-c1-ubung-test': 'mit-erfolg-zum-testdaf-b2-c1-bungs-und-testbuch.pdf.enc',
  'digital-testdaf-ubung-test': 'Mit_Erfolg_zum_digitalen_TestDaF_U_776_bungs-und_Testbuch.pdf.enc',
  'goethe-c1-erfolg-ubung': 'uebungsbuch-mit-erfolg-zum-goethe-zertifikat-c1.pdf.enc',
  'testdaf-training-2015': 'testdaf-training-20-15.pdf.enc'
};

// Initialize DB schema on startup
initSchema().catch(err => {
  console.error("Failed to initialize database schema, exiting", err);
  process.exit(1);
});

// Middleware: Authenticate User
const authenticateUser = async (req, res, next) => {
  let token = req.cookies.token;
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }

  if (!token) {
    return res.status(401).json({ error: "Access denied. No session token provided." });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await db.query(
      `SELECT
        id, username, email, created_at, updated_at,
        is_subscribed, subscription_id,
        xp, level, streak, last_played_date, accuracy, games_played, games_won,
        subscribed_at,
        plan_type, plan_start_date, plan_end_date, subscription_status,
        latin_used_today, figure_used_today, math_used_today, last_usage_reset_date,
        max_pages_read
      FROM users
      WHERE id = $1`,
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "User not found or deleted." });
    }

    req.user = await syncUserSubscriptionState(result.rows[0]);
    next();
  } catch (err) {
    res.clearCookie('token', { path: '/' });
    return res.status(401).json({ error: "Invalid session token." });
  }
};

// ── AUTH ENDPOINTS ───────────────────────────────────────────────────────────

// ── STEP 1: Initiate Registration — Validate & Send OTP ──────────────────────
app.post('/api/auth/send-otp', otpRequestLimiter, async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: "Please enter username, email, and password." });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters long." });
  }

  try {
    // Check if email already exists in DB
    const checkEmail = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (checkEmail.rows.length > 0) {
      return res.status(400).json({ error: "Email is already registered. Please log in instead." });
    }

    // Hash password now so we don't store plaintext in OTP store
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Generate OTP and store with expiry
    const otp = generateOtp();
    const expiresAt = Date.now() + OTP_EXPIRY_MS;
    otpStore.set(email.toLowerCase(), { otp, expiresAt, username, passwordHash });

    // Send OTP email via Brevo SMTP
    await sendOtpEmail(email, username, otp);

    console.log(`OTP sent to ${email} for registration.`);
    res.status(200).json({ message: "OTP sent successfully. Please check your email." });

  } catch (err) {
    console.error("Send OTP error:", err);
    res.status(500).json({ error: "Failed to send verification email. Please try again." });
  }
});

// ── STEP 2: Verify OTP & Complete Registration ────────────────────────────────
app.post('/api/auth/verify-otp', otpVerifyLimiter, async (req, res) => {
  const { email, otp, username, password } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: "Email and OTP are required." });
  }

  const normalizedEmail = email.toLowerCase();
  const stored = otpStore.get(normalizedEmail);

  if (!stored) {
    return res.status(400).json({ error: "No verification request found. Please register again." });
  }

  if (Date.now() > stored.expiresAt) {
    otpStore.delete(normalizedEmail);
    return res.status(400).json({ error: "OTP has expired. Please request a new one." });
  }

  if (stored.otp !== otp.toString().trim()) {
    return res.status(400).json({ error: "Invalid OTP. Please check the code and try again." });
  }

  // OTP is valid — complete registration
  try {
    // Double-check email not registered in the meantime
    const checkEmail = await db.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (checkEmail.rows.length > 0) {
      otpStore.delete(normalizedEmail);
      return res.status(400).json({ error: "Email is already registered. Please log in." });
    }

    // Use stored password hash (from send-otp step)
    let passwordHash = stored.passwordHash;
    // If no stored hash (e.g., store was cleared), re-hash from provided password
    if (!passwordHash && password) {
      const salt = await bcrypt.genSalt(10);
      passwordHash = await bcrypt.hash(password, salt);
    }

    const finalUsername = stored.username || username;
    const createdAt = new Date();
    const planStartDate = new Date(createdAt);
    const planEndDate = new Date(createdAt.getTime() + 3 * 24 * 60 * 60 * 1000);

    const result = await db.query(
      `INSERT INTO users
      (username, email, password_hash, created_at, updated_at, plan_type, plan_start_date, plan_end_date, subscription_status, latin_used_today, figure_used_today, math_used_today, last_usage_reset_date)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, 'trial', $5, $6, 'active', 0, 0, 0, CURRENT_DATE)
      RETURNING id, username, email, created_at, is_subscribed, plan_type, subscription_status, plan_start_date, plan_end_date`,
      [finalUsername, normalizedEmail, passwordHash, createdAt, planStartDate, planEndDate]
    );

    const newUser = result.rows[0];

    // Clear OTP from store
    otpStore.delete(normalizedEmail);

    // Issue JWT cookie
    const token = jwt.sign({ userId: newUser.id }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('token', token, COOKIE_OPTIONS);

    console.log(`User ${finalUsername} (${normalizedEmail}) registered successfully via OTP.`);

    res.status(201).json({
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        trialEndsAt: newUser.plan_end_date,
        isSubscribed: newUser.is_subscribed,
        trialExpired: false,
        daysLeft: 3,
        planType: newUser.plan_type,
        subscriptionStatus: newUser.subscription_status,
        subscribedAt: null,
        subscriptionEndsAt: newUser.plan_end_date,
        maxPagesRead: 0
      }
    });

  } catch (err) {
    console.error("Verify OTP / Registration error:", err);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

// Legacy /api/auth/register — now redirects to send-otp flow for backward compatibility
app.post('/api/auth/register', async (req, res) => {
  // Forward to send-otp endpoint logic
  req.url = '/api/auth/send-otp';
  res.status(400).json({ error: "Please use the OTP verification flow. Refresh and try again." });
});

// Login User
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Please enter email and password." });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Invalid credentials." });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid credentials." });
    }

    // Issue JWT cookie
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('token', token, COOKIE_OPTIONS);

    const normalizedUser = await syncUserSubscriptionState(user);
    if (normalizedUser.plan_type === 'trial') {
      await resetDailyCounters(normalizedUser);
    }
    const isSubscribedActive = checkSubscriptionStatus(normalizedUser);
    const trialExpired = normalizedUser.plan_type === 'trial' && normalizedUser.subscription_status !== 'active';
    const daysLeft = normalizedUser.plan_type === 'trial' ? calculateRemainingDays(normalizedUser.plan_end_date) : 0;

    res.json({
      token,
      user: {
        id: normalizedUser.id,
        username: normalizedUser.username,
        email: normalizedUser.email,
        trialEndsAt: normalizedUser.plan_end_date,
        isSubscribed: isSubscribedActive,
        trialExpired,
        daysLeft,
        xp: normalizedUser.xp,
        level: normalizedUser.level,
        streak: normalizedUser.streak,
        lastPlayedDate: normalizedUser.last_played_date,
        accuracy: normalizedUser.accuracy,
        gamesPlayed: normalizedUser.games_played,
        gamesWon: normalizedUser.games_won,
        subscribedAt: normalizedUser.subscribed_at,
        subscriptionEndsAt: normalizedUser.plan_end_date,
        maxPagesRead: normalizedUser.max_pages_read
      }
    });

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error during login." });
  }
});

// Logout User
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  res.json({ success: true, message: "Logged out successfully." });
});

// ── FORGOT PASSWORD FLOW ─────────────────────────────────────────────────────
const PASSWORD_RESET_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

const sendPasswordResetEmail = async (toEmail, username, resetLink) => {
  const verifiedSender = process.env.SMTP_SENDER || (process.env.SMTP_LOGIN && !process.env.SMTP_LOGIN.endsWith('@smtp-brevo.com') ? process.env.SMTP_LOGIN : undefined);
  if (!verifiedSender) {
    console.error('[Email] SMTP_SENDER is not defined in environment variables.');
    throw new Error('Email configuration error: SMTP_SENDER missing');
  }
  const mailOptions = {
    from: `"TestAS Mastery" <${verifiedSender}>`,
    to: toEmail,
    subject: 'Reset Your TestAS Mastery Password',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin:0;padding:0;background:#050810;font-family:'Segoe UI',Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#050810;padding:40px 20px;">
          <tr><td align="center">
            <table width="520" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#0f1629,#1a1040);border-radius:20px;border:1px solid rgba(99,102,241,0.2);overflow:hidden;">
              <tr>
                <td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px;text-align:center;">
                  <div style="width:56px;height:56px;background:rgba(255,255,255,0.15);border-radius:14px;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;">
                    <span style="font-size:28px;">&#128274;</span>
                  </div>
                  <h1 style="color:#fff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.5px;">TestAS Mastery</h1>
                  <p style="color:rgba(255,255,255,0.75);margin:6px 0 0;font-size:13px;">Password Reset Request</p>
                </td>
              </tr>
              <tr>
                <td style="padding:36px 40px;">
                  <p style="color:#e2e8f0;font-size:16px;margin:0 0 8px;">Hi <strong>${username}</strong>,</p>
                  <p style="color:#94a3b8;font-size:14px;margin:0 0 28px;line-height:1.6;">We received a request to reset your password. Click the button below to choose a new one. This link expires in <strong style="color:#a5b4fc;">30 minutes</strong>.</p>

                  <div style="text-align:center;margin-bottom:28px;">
                    <a href="${resetLink}" style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;text-decoration:none;font-weight:800;font-size:14px;padding:14px 32px;border-radius:12px;">Reset Password</a>
                  </div>

                  <p style="color:#64748b;font-size:12px;margin:0;line-height:1.6;">If you didn't request this, you can safely ignore this email — your password will remain unchanged.</p>
                </td>
              </tr>
              <tr>
                <td style="background:rgba(0,0,0,0.2);padding:20px 40px;border-top:1px solid rgba(255,255,255,0.05);">
                  <p style="color:#475569;font-size:11px;margin:0;text-align:center;">&copy; 2024 TestAS Mastery &middot; All rights reserved</p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `
  };

  console.log(`[Email] Sending password reset email to: ${toEmail}`);
  const info = await sendEmailViaAPI({
    toEmail,
    toName: username,
    subject: 'Reset Your TestAS Mastery Password',
    htmlContent: mailOptions.html
  });
  console.log(`[Email] Reset email sent successfully. MessageId: ${info?.messageId || 'N/A'}`);
  return info;
};

// STEP 1: Request a password reset — always responds with a generic success
// message whether or not the email exists, so this endpoint can't be used to
// enumerate registered accounts.
app.post('/api/auth/forgot-password', passwordResetLimiter, async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Please enter your email address." });
  }

  const genericResponse = {
    message: "If an account exists for that email, a password reset link has been sent."
  };

  try {
    const normalizedEmail = email.toLowerCase();
    const result = await db.query('SELECT id, username FROM users WHERE email = $1', [normalizedEmail]);

    if (result.rows.length === 0) {
      // Do not reveal whether the email exists.
      return res.status(200).json(genericResponse);
    }

    const user = result.rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_MS);

    await db.query(
      `INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)`,
      [token, user.id, expiresAt]
    );

    const frontendBase = process.env.FRONTEND_URL;
    const resetLink = `${frontendBase.replace(/\/$/, '')}/reset-password?token=${token}`;

    await sendPasswordResetEmail(email, user.username, resetLink);

    return res.status(200).json(genericResponse);
  } catch (err) {
    console.error("Forgot password error:", err);
    // Still return the generic message so failures don't leak account info,
    // but log the real error server-side for debugging.
    return res.status(200).json(genericResponse);
  }
});

// STEP 2: Complete the reset using the emailed token
app.post('/api/auth/reset-password', passwordResetLimiter, async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: "Reset token and new password are required." });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters long." });
  }

  try {
    const result = await db.query(
      `SELECT token, user_id, expires_at, used_at FROM password_reset_tokens WHERE token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Invalid or expired reset link. Please request a new one." });
    }

    const record = result.rows[0];

    if (record.used_at) {
      return res.status(400).json({ error: "This reset link has already been used. Please request a new one." });
    }

    if (new Date() > new Date(record.expires_at)) {
      return res.status(400).json({ error: "This reset link has expired. Please request a new one." });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await db.query(
      `UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [passwordHash, record.user_id]
    );

    // Mark token as used so it can never be replayed
    await db.query(
      `UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE token = $1`,
      [token]
    );

    console.log(`Password reset completed for user_id ${record.user_id}.`);
    return res.status(200).json({ message: "Password reset successfully. Please log in with your new password." });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ error: "Failed to reset password. Please try again." });
  }
});

// Get Current User Profile (Checks active session)
app.get('/api/auth/me', authenticateUser, (req, res) => {
  const user = req.user;
  const isSubscribedActive = checkSubscriptionStatus(user);
  const trialExpired = user.plan_type === 'trial' && user.subscription_status !== 'active';
  const daysLeft = user.plan_type === 'trial' ? calculateRemainingDays(user.plan_end_date) : 0;

  res.json({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      trialEndsAt: user.plan_end_date,
      isSubscribed: isSubscribedActive,
      trialExpired,
      daysLeft,
      xp: user.xp,
      level: user.level,
      streak: user.streak,
      lastPlayedDate: user.last_played_date,
      accuracy: user.accuracy,
      gamesPlayed: user.games_played,
      gamesWon: user.games_won,
      subscribedAt: user.subscribed_at,
      subscriptionEndsAt: user.plan_end_date,
      planType: user.plan_type,
      subscriptionStatus: user.subscription_status,
      maxPagesRead: user.max_pages_read
    }
  });
});

// Get Full Subscription Details
app.get('/api/subscription', authenticateUser, async (req, res) => {
  const user = req.user;

  try {
    await syncUserSubscriptionState(user);
    if (user.plan_type === 'trial') {
      await resetDailyCounters(user);
      await syncUserSubscriptionState(user);
    }

    return res.json(createSubscriptionPayload(user));
  } catch (err) {
    console.error("Error fetching subscription:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch subscription details." });
  }
});

// Track question usage for trial plans (call on question start)
app.post('/api/subscription/usage', authenticateUser, async (req, res) => {
  const user = req.user;
  const usageType = normalizeUsageType(req.body?.type || req.body?.module || req.body?.category);

  if (!usageType) {
    return res.status(400).json({ success: false, message: "Invalid usage type. Allowed values: latin, figure, math." });
  }

  try {
    await syncUserSubscriptionState(user);

    if (user.subscription_status !== 'active') {
      return res.status(403).json({
        success: false,
        message: user.plan_type === 'trial'
          ? "Your free trial has expired. Upgrade to continue."
          : "Your subscription has expired. Upgrade to continue."
      });
    }

    if (isPremiumPlan(user.plan_type)) {
      return res.json({
        success: true,
        message: "Premium user has unlimited access.",
        planType: user.plan_type,
        status: user.subscription_status,
        isUnlimited: true,
        dailyUsage: {
          latin: Number(user.latin_used_today ?? 0),
          figure: Number(user.figure_used_today ?? 0),
          math: Number(user.math_used_today ?? 0)
        },
        dailyLimit: {
          latin: -1,
          figure: -1,
          math: -1
        }
      });
    }

    await resetDailyCounters(user);
    const trialLimitError = checkTrialLimit(user, usageType);
    if (trialLimitError) {
      return res.status(403).json({
        success: false,
        message: trialLimitError
      });
    }

    await incrementUsage(user, usageType);

    return res.json({
      success: true,
      message: "Usage tracked successfully.",
      planType: user.plan_type,
      status: user.subscription_status,
      isUnlimited: false,
      usedType: usageType,
      dailyUsage: {
        latin: Number(user.latin_used_today ?? 0),
        figure: Number(user.figure_used_today ?? 0),
        math: Number(user.math_used_today ?? 0)
      },
      dailyLimit: {
        latin: TRIAL_DAILY_LIMIT,
        figure: TRIAL_DAILY_LIMIT,
        math: TRIAL_DAILY_LIMIT
      }
    });
  } catch (err) {
    console.error("Error tracking subscription usage:", err);
    return res.status(500).json({ success: false, message: "Failed to track usage." });
  }
});

// Update User Gamification Stats
app.post('/api/user/stats', authenticateUser, async (req, res) => {
  const { xp, level, streak, lastPlayedDate, accuracy, gamesPlayed, gamesWon } = req.body;
  const user = req.user;

  try {
    await db.query(
      `UPDATE users SET 
        xp = COALESCE($1, xp),
        level = COALESCE($2, level),
        streak = COALESCE($3, streak),
        last_played_date = COALESCE($4, last_played_date),
        accuracy = COALESCE($5, accuracy),
        games_played = COALESCE($6, games_played),
        games_won = COALESCE($7, games_won)
       WHERE id = $8`,
      [
        xp !== undefined ? xp : null,
        level !== undefined ? level : null,
        streak !== undefined ? streak : null,
        lastPlayedDate !== undefined ? lastPlayedDate : null,
        accuracy !== undefined ? accuracy : null,
        gamesPlayed !== undefined ? gamesPlayed : null,
        gamesWon !== undefined ? gamesWon : null,
        user.id
      ]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error updating user stats:", err);
    res.status(500).json({ error: "Failed to update stats in database." });
  }
});

// ── SECURE PDF BOOK STREAM ENDPOINT ──────────────────────────────────────────

app.get('/api/books/:id/read', authenticateUser, async (req, res) => {
  const user = req.user;
  const bookId = req.params.id;

  await syncUserSubscriptionState(user);

  // Allow premium subscribers AND active trial users (page limit enforced client-side)
  const isSubscribedActive = checkSubscriptionStatus(user);
  const isActiveTrial = user.plan_type === 'trial' && user.subscription_status === 'active';

  if (!isSubscribedActive && !isActiveTrial) {
    return res.status(403).json({ error: "Book access requires an active subscription or trial. Please log in or upgrade." });
  }

  const filename = BOOK_MAP[bookId];
  if (!filename) {
    return res.status(404).json({ error: "Ebook not found in database catalog." });
  }

  const filePath = path.join(__dirname, 'secure-pdf-library', filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Encrypted ebook file not found on disk." });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  const asciiFilename = filename.replace(/[^\x00-\x7F]/g, "_");
  const encodedFilename = encodeURIComponent(filename);
  res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`);

  const fileStream = fs.createReadStream(filePath);
  fileStream.pipe(res);
});

// ── DEV-ONLY TESTING ENDPOINT ─────────────────────────────────────────────────
// Lets a developer flip their own account between trial / expired-trial /
// subscribed states instantly, without waiting 3 real days or making a
// payment. Disabled unless NODE_ENV !== 'production', so it can never be
// reachable in a real deployment.
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/dev/set-plan-state', authenticateUser, async (req, res) => {
    const user = req.user;
    const { state } = req.body; // 'trial_active' | 'trial_expired' | 'subscribed'

    try {
      if (state === 'trial_active') {
        const start = new Date();
        const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);
        await db.query(
          `UPDATE users SET
            is_subscribed = false,
            plan_type = 'trial',
            plan_start_date = $1,
            plan_end_date = $2,
            subscription_status = 'active',
            latin_used_today = 0,
            figure_used_today = 0,
            math_used_today = 0,
            last_usage_reset_date = CURRENT_DATE,
            updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [start, end, user.id]
        );
      } else if (state === 'trial_expired') {
        const start = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
        const end = new Date(Date.now() - 24 * 60 * 60 * 1000); // ended yesterday
        await db.query(
          `UPDATE users SET
            is_subscribed = false,
            plan_type = 'trial',
            plan_start_date = $1,
            plan_end_date = $2,
            subscription_status = 'expired',
            updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [start, end, user.id]
        );
      } else if (state === 'subscribed') {
        const start = new Date();
        const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
        await db.query(
          `UPDATE users SET
            is_subscribed = true,
            plan_type = 'monthly',
            plan_start_date = $1,
            plan_end_date = $2,
            subscribed_at = $1,
            subscription_status = 'active',
            updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [start, end, user.id]
        );
      } else {
        return res.status(400).json({ success: false, message: "state must be one of: trial_active, trial_expired, subscribed" });
      }

      return res.json({ success: true, message: `Plan state set to ${state}.` });
    } catch (err) {
      console.error("Dev set-plan-state error:", err);
      return res.status(500).json({ success: false, message: "Failed to set plan state." });
    }
  });
}

// ── RAZORPAY PAYMENT VERIFICATION ENDPOINT ───────────────────────────────────

app.post('/api/payment/verify', authenticateUser, async (req, res) => {
  const user = req.user;
  const { razorpay_payment_id } = req.body;

  if (!razorpay_payment_id) {
    return res.redirect('/subscription?error=payment_id_missing');
  }

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  // Razorpay credentials are mandatory. There is no "simulation mode" here —
  // without real credentials we have no way to verify a payment actually
  // happened, so refusing outright (instead of auto-approving) is the only
  // safe behavior. Configure RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET to test
  // this flow locally against Razorpay's own test-mode keys.
  if (!keyId || !keySecret) {
    console.error("Razorpay credentials are not configured. Refusing to verify payment.");
    return res.redirect('/subscription?error=payment_verification_unavailable');
  }

  try {
    console.log(`Verifying payment ${razorpay_payment_id} via Razorpay API...`);
    const authHeader = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const response = await fetch(`https://api.razorpay.com/v1/payments/${razorpay_payment_id}`, {
      headers: {
        'Authorization': authHeader
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Razorpay API validation failed:", errorText);
      return res.redirect('/subscription?error=verification_failed');
    }

    const paymentData = await response.json();
    console.log(`Razorpay API payment state: ${paymentData.status}`);

    const paymentVerified = paymentData.status === 'captured' || paymentData.status === 'authorized';
    if (!paymentVerified) {
      console.warn(`Razorpay payment status is ${paymentData.status}. Expected captured or authorized.`);
      return res.redirect('/subscription?error=verification_failed');
    }

    // Amount and timestamp always come from Razorpay's response, never from
    // the request body — the client cannot influence what plan it's granted.
    const paymentAmount = typeof paymentData.amount === 'number' ? paymentData.amount / 100 : 0;
    const verifiedAt = paymentData.created_at ? new Date(paymentData.created_at * 1000) : new Date();
    const normalizedAmount = Number.isFinite(paymentAmount) ? Math.round(paymentAmount) : 0;
    const planType = normalizedAmount === 999 ? 'quarterly' : 'monthly';
    const planDuration = planType === 'quarterly' ? '90 days' : '30 days';

    // Atomically claim this payment_id so it can only ever be redeemed once,
    // by any account. INSERT ... ON CONFLICT DO NOTHING is race-safe under
    // concurrent requests (e.g. the user double-clicking "confirm payment").
    const claim = await db.query(
      `INSERT INTO used_payment_ids (payment_id, user_id) VALUES ($1, $2)
       ON CONFLICT (payment_id) DO NOTHING
       RETURNING payment_id`,
      [razorpay_payment_id, user.id]
    );

    if (claim.rows.length === 0) {
      console.warn(`Payment ${razorpay_payment_id} was already redeemed. Rejecting replay for user ${user.id}.`);
      return res.redirect('/subscription?error=payment_already_used');
    }

    await db.query(
      `UPDATE users SET
        is_subscribed = true,
        subscription_id = $1,
        subscribed_at = $2,
        plan_type = $4,
        plan_start_date = $2,
        plan_end_date = $2 + ($3::interval),
        subscription_status = 'active',
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [razorpay_payment_id, verifiedAt, planDuration, planType, user.id]
    );
    console.log(`User ${user.username} (ID: ${user.id}) successfully upgraded to ${planType.toUpperCase()} PREMIUM.`);
    return res.redirect('/dashboard?payment=success');
  } catch (err) {
    console.error("Payment verification exception:", err);
    return res.redirect('/subscription?error=internal_server_error');
  }
});

// ── SECURED PREMIUM AI ENDPOINTS ─────────────────────────────────────────────

app.post('/api/ai/chat', authenticateUser, async (req, res) => {
  if (!checkSubscriptionStatus(req.user)) {
    return res.status(403).json({
      error: "premium_required",
      message: "Only premium subscribed users can access AI features. Please subscribe to unlock."
    });
  }

  const { messages, options } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Missing or invalid messages array." });
  }

  try {
    const result = await askAI(messages, options);
    return res.json(result);
  } catch (err) {
    console.error("[Backend AI Chat Error]:", err);
    return res.status(500).json({ error: err.message || "Failed to process chat with AI." });
  }
});

app.post('/api/ai/vision', authenticateUser, async (req, res) => {
  if (!checkSubscriptionStatus(req.user)) {
    return res.status(403).json({
      error: "premium_required",
      message: "Only premium subscribed users can access AI features. Please subscribe to unlock."
    });
  }

  const { prompt, base64Image, model } = req.body;
  if (!prompt || !base64Image) {
    return res.status(400).json({ error: "Missing prompt or base64Image." });
  }

  try {
    const result = await askAIVision(prompt, base64Image, model);
    return res.json({ content: result });
  } catch (err) {
    console.error("[Backend AI Vision Error]:", err);
    return res.status(500).json({ error: err.message || "Failed to analyze image with AI." });
  }
});

app.post('/api/ai/generate-image', authenticateUser, async (req, res) => {
  if (!checkSubscriptionStatus(req.user)) {
    return res.status(403).json({
      error: "premium_required",
      message: "Only premium subscribed users can access AI features. Please subscribe to unlock."
    });
  }

  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: "Missing prompt." });
  }

  try {
    const result = await generateNIMImage(prompt);
    return res.json(result);
  } catch (err) {
    console.error("[Backend AI Image Gen Error]:", err);
    return res.status(500).json({ error: err.message || "Failed to generate image with AI." });
  }
});

app.get('/api/ai/status', authenticateUser, (req, res) => {
  return res.json({
    openrouter: !!(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.length > 15),
    nvidianim: !!(process.env.NVIDIA_NIM_API_KEY && process.env.NVIDIA_NIM_API_KEY.length > 15)
  });
});

// Track page progress in real-time
app.post('/api/user/track-page', authenticateUser, async (req, res) => {
  const { page } = req.body;
  const user = req.user;

  if (typeof page !== 'number' || page < 1) {
    return res.status(400).json({ error: "Invalid page number." });
  }

  try {
    const result = await db.query(
      `UPDATE users
       SET max_pages_read = GREATEST(COALESCE(max_pages_read, 0), $1),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING max_pages_read`,
      [page, user.id]
    );

    const updatedMax = result.rows[0]?.max_pages_read ?? 0;
    return res.json({ success: true, maxPagesRead: updatedMax });
  } catch (err) {
    console.error("Error tracking page progress:", err);
    return res.status(500).json({ error: "Failed to track page progress." });
  }
});

// Serve static assets or frontend in production
// (Vite dev server is used locally, but this provides hosting capability)
const distPath = path.join(__dirname, '../dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.status(200).send('TestAS Mastery API is running successfully. (Frontend build is building or not present)');
  });
}

// Start Server
app.listen(PORT, () => {
  console.log(`Express server running on port ${PORT}`);
});