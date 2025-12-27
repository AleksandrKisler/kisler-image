const axios = require("axios");
const { YooCheckout } = require("@a2seven/yoo-checkout");
const { v4: uuidv4 } = require("uuid");

function requireEnv(name) {
    const v = process.env[name];
    if (!v || !String(v).trim()) throw new Error(`${name} is not set`);
    return String(v).trim();
}

// very light heuristic to detect that someone pasted OAuth instead of secret key
function looksLikeOAuthToken(s) {
    const v = String(s || "").trim();
    // OAuth tokens are often long; secret keys usually look like test_/live_... from LK.
    // We only warn/throw if it is obviously "Bearer ..." or jwt-like.
    if (/^Bearer\s+/i.test(v)) return true;
    if (v.split(".").length === 3 && v.length > 60) return true; // JWT-like
    return false;
}

const DEFAULT_API_BASE = "https://api.yookassa.ru";

let _client = null;

function getClient() {
    if (_client) return _client;

    const shopId = requireEnv("YOOKASSA_SHOP_ID");
    const secretKey = String(process.env.YOOKASSA_SECRET_KEY || "").trim();
    const oauthToken = String(process.env.YOOKASSA_OAUTH_TOKEN || "").trim();
    const apiBase = String(process.env.YOOKASSA_API_BASE || DEFAULT_API_BASE).replace(/\/$/, "");

    // OAuth is required for marketplace/partner integrations. When a bearer token is supplied we switch to OAuth mode.
    if (oauthToken || looksLikeOAuthToken(secretKey)) {
        const token = oauthToken || secretKey;
        _client = {
            mode: "oauth",
            shopId,
            oauth: token,
            http: axios.create({
                baseURL: `${apiBase}/v3`,
                headers: {
                    "Content-Type": "application/json",
                },
            }),
        };
        return _client;
    }

    if (!secretKey) {
        throw new Error("YOOKASSA_SECRET_KEY is not set");
    }

    // SDK uses HTTP Basic Auth for shopId+secretKey (payments).
    _client = { mode: "basic", checkout: new YooCheckout({ shopId, secretKey, apiUrl: apiBase }) };
    return _client;
}

function formatYooCheckoutError(e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    if (!status) return e?.message || "YooKassa request failed";
    try {
        return `YooKassa API error: HTTP ${status} — ${JSON.stringify(data)}`;
    } catch {
        return `YooKassa API error: HTTP ${status}`;
    }
}

async function createPayment({ amountRub, description, returnUrl, metadata, paymentMethodType }) {
    const client = getClient();
    const idempotenceKey = uuidv4();

    const body = {
        amount: { value: Number(amountRub).toFixed(2), currency: "RUB" },
        capture: true,
        confirmation: { type: "redirect", return_url: returnUrl },
        description,
        metadata: metadata || {},
    };

    if (paymentMethodType) {
        body.payment_method_data = { type: paymentMethodType };
    }

    try {
        if (client.mode === "basic") {
            const payment = await client.checkout.createPayment(body, idempotenceKey);
            return { idempotenceKey, payment };
        }

        const { data: payment } = await client.http.post("/payments", body, {
            headers: {
                Authorization: `Bearer ${client.oauth}`,
                "Idempotence-Key": idempotenceKey,
                "Account-Id": client.shopId,
            },
        });

        return { idempotenceKey, payment };
    } catch (e) {
        const err = new Error(formatYooCheckoutError(e));
        err.cause = e;
        throw err;
    }
}

async function getPayment(paymentId) {
    try {
        const client = getClient();

        if (client.mode === "basic") {
            return await client.checkout.getPayment(paymentId);
        }

        const { data } = await client.http.get(`/payments/${paymentId}`, {
            headers: {
                Authorization: `Bearer ${client.oauth}`,
                "Account-Id": client.shopId,
            },
        });

        return data;
    } catch (e) {
        const err = new Error(formatYooCheckoutError(e));
        err.cause = e;
        throw err;
    }
}

module.exports = { createPayment, getPayment };
