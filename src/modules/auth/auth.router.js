const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { getDb } = require("../../db");
const { v4: uuidv4 } = require("uuid");
const { sendOtpEmail } = require("../../shared/mailer");

function sha256(s) {
    return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function parseTtlMs(raw, fallbackMs) {
    // Accept values like: "30d", "12h", "900s", "15m"
    if (!raw) return fallbackMs;
    const m = String(raw).trim().match(/^(\d+)\s*([smhd])$/i);
    if (!m) return fallbackMs;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return n * mult;
}

function getCookie(req, name) {
    const raw = String(req.headers.cookie || "");
    if (!raw) return null;
    const parts = raw.split(";").map((p) => p.trim());
    for (const p of parts) {
        const idx = p.indexOf("=");
        if (idx === -1) continue;
        const k = p.slice(0, idx).trim();
        if (k !== name) continue;
        return decodeURIComponent(p.slice(idx + 1));
    }
    return null;
}

function getClientIp(req) {
    const xf = String(req.headers["x-forwarded-for"] || "");
    if (xf) return xf.split(",")[0].trim();
    return req.ip;
}

function issueAccessToken(user) {
    if (!process.env.JWT_ACCESS_SECRET) throw new Error("JWT_ACCESS_SECRET is not set");
    return jwt.sign(
        { sub: user.id, email: user.email },
        process.env.JWT_ACCESS_SECRET,
        { expiresIn: process.env.JWT_ACCESS_TTL || "15m" }
    );
}

async function issueRefreshToken(db, { userId, req }) {
    const ttlMs = parseTtlMs(process.env.JWT_REFRESH_TTL || "30d", 30 * 86_400_000);
    const token = crypto.randomBytes(48).toString("base64url");
    const id = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    await db("auth_refresh_tokens").insert({
        id,
        user_id: userId,
        token_hash: sha256(token),
        created_at: now.toISOString(),
        expires_at: expiresAt,
        revoked_at: null,
        replaced_by: null,
        created_ip: getClientIp(req),
        user_agent: String(req.headers["user-agent"] || "")
    });
    return { id, token, expiresAt };
}

function hash(p) {
    return sha256(p);
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

        const accessToken = issueAccessToken(user);

        // ✅ Refresh token (opaque, stored server-side). Safer than long-lived JWT in localStorage.
        const refresh = await issueRefreshToken(db, { userId: user.id, req });

        // Optional cookie mode (recommended for production)
        const useCookie = String(process.env.REFRESH_TOKEN_IN_COOKIE || "true").toLowerCase() === "true";
        if (useCookie) {
            const secure = String(process.env.COOKIE_SECURE || "").toLowerCase() === "true" || process.env.NODE_ENV === "production";
            res.cookie("refreshToken", refresh.token, {
                httpOnly: true,
                secure,
                sameSite: secure ? "none" : "lax",
                path: "/api/v1/auth",
                maxAge: parseTtlMs(process.env.JWT_REFRESH_TTL || "30d", 30 * 86_400_000)
            });
        }

        res.json({
            accessToken,
            refreshToken: useCookie ? undefined : refresh.token,
            user: {
                id: user.id,
                email: user.email,
                tokenBalance: user.token_balance,
                createdAt: user.created_at
            }
        });
    });

    /**
     * Refresh access token.
     * Accepts:
     *  - HttpOnly cookie refreshToken (recommended)
     *  - body { refreshToken }
     */
    r.post("/refresh", async (req, res) => {
        const token = String(req.body?.refreshToken || getCookie(req, "refreshToken") || "").trim();
        if (!token) {
            return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing refresh token" } });
        }

        const db = getDb();
        const nowIso = new Date().toISOString();
        const tokenHash = sha256(token);
        const row = await db("auth_refresh_tokens").where({ token_hash: tokenHash }).first();

        // Not found or expired
        if (!row || row.expires_at < nowIso) {
            return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Refresh token invalid or expired" } });
        }

        // Token reuse detection: if token was already revoked, someone is trying to reuse it.
        if (row.revoked_at) {
            // Revoke all tokens for that user to force re-login everywhere
            await db("auth_refresh_tokens")
                .where({ user_id: row.user_id })
                .andWhere((q) => q.whereNull("revoked_at"))
                .update({ revoked_at: nowIso });

            return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Refresh token revoked" } });
        }

        const user = await db("users").where({ id: row.user_id }).first();
        if (!user) {
            return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "User not found" } });
        }

        // Rotate refresh token
        const next = await issueRefreshToken(db, { userId: user.id, req });
        await db("auth_refresh_tokens").where({ id: row.id }).update({ revoked_at: nowIso, replaced_by: next.id });

        const accessToken = issueAccessToken(user);

        const useCookie = String(process.env.REFRESH_TOKEN_IN_COOKIE || "true").toLowerCase() === "true";
        if (useCookie) {
            const secure = String(process.env.COOKIE_SECURE || "").toLowerCase() === "true" || process.env.NODE_ENV === "production";
            res.cookie("refreshToken", next.token, {
                httpOnly: true,
                secure,
                sameSite: secure ? "none" : "lax",
                path: "/api/v1/auth",
                maxAge: parseTtlMs(process.env.JWT_REFRESH_TTL || "30d", 30 * 86_400_000)
            });
        }

        return res.json({ accessToken, refreshToken: useCookie ? undefined : next.token });
    });

    /** Logout: revoke current refresh token */
    r.post("/logout", async (req, res) => {
        const token = String(req.body?.refreshToken || getCookie(req, "refreshToken") || "").trim();
        const db = getDb();
        if (token) {
            await db("auth_refresh_tokens")
                .where({ token_hash: sha256(token) })
                .update({ revoked_at: new Date().toISOString() });
        }
        // Clear cookie (if used)
        res.cookie("refreshToken", "", {
            httpOnly: true,
            expires: new Date(0),
            path: "/api/v1/auth"
        });
        return res.json({ ok: true });
    });

    return r;
}

module.exports = { createAuthRouter };
