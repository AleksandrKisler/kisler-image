const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { getDb } = require("../../db");
const { v4: uuidv4 } = require("uuid");
const { sendOtpEmail } = require("../../shared/mailer");

function hash(p) {
  return crypto.createHash("sha256").update(p).digest("hex");
}

const OTP_TTL_MINUTES = 5;
const OTP_MIN_INTERVAL_MS = 60_000;
const OTP_MAX_ATTEMPTS = 5;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function createAuthRouter() {
  const r = express.Router();

  r.post("/request-code", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Valid email required" } });
    }

    const db = getDb();

    const last = await db("auth_email_codes").where({ email }).orderBy("created_at", "desc").first();
    if (last) {
      const ms = Date.now() - new Date(last.created_at).getTime();
      if (ms < OTP_MIN_INTERVAL_MS) {
        return res.status(429).json({ error: { code: "OTP_TOO_FREQUENT", message: "Please wait before requesting another code" } });
      }
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString();

    await db("auth_email_codes").where({ email }).del();
    await db("auth_email_codes").insert({
      id: uuidv4(),
      email,
      code_hash: hash(code),
      expires_at: expiresAt,
      attempts: 0,
      created_at: new Date().toISOString()
    });

    await sendOtpEmail({ to: email, code });

    res.json({ ok: true });
  });

  r.post("/verify-code", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || "").trim();
    if (!email || !code) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "email and code required" } });
    }

    const db = getDb();
    const row = await db("auth_email_codes").where({ email }).orderBy("created_at", "desc").first();

    if (!row) return res.status(401).json({ error: { code: "INVALID_CODE", message: "Invalid or expired code" } });
    if (row.expires_at < new Date().toISOString()) {
      await db("auth_email_codes").where({ id: row.id }).del();
      return res.status(401).json({ error: { code: "EXPIRED_CODE", message: "Code expired" } });
    }
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      await db("auth_email_codes").where({ id: row.id }).del();
      return res.status(429).json({ error: { code: "TOO_MANY_ATTEMPTS", message: "Too many attempts" } });
    }

    if (row.code_hash !== hash(code)) {
      await db("auth_email_codes").where({ id: row.id }).update({ attempts: row.attempts + 1 });
      return res.status(401).json({ error: { code: "INVALID_CODE", message: "Invalid or expired code" } });
    }

    let user = await db("users").where({ email }).first();
    if (!user) {
      const id = uuidv4();
      const now = new Date().toISOString();
      user = { id, email, password_hash: null, token_balance: 0, created_at: now };
      await db("users").insert(user);
    }

    await db("auth_email_codes").where({ id: row.id }).del();

    const accessToken = jwt.sign(
      { sub: user.id, email: user.email },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: process.env.JWT_ACCESS_TTL || "15m" }
    );

    res.json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        tokenBalance: user.token_balance,
        createdAt: user.created_at
      }
    });
  });

  return r;
}

module.exports = { createAuthRouter };
