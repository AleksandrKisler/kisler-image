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

let _checkout = null;

function getCheckout() {
    if (_checkout) return _checkout;

    const shopId = requireEnv("YOOKASSA_SHOP_ID");
    const secretKey = requireEnv("YOOKASSA_SECRET_KEY");

    if (looksLikeOAuthToken(secretKey)) {
        throw new Error(
            "YOOKASSA_SECRET_KEY looks like an OAuth/Bearer token. For /v3/payments you must use SECRET KEY from LK (Integration → API Keys)."
        );
    }

    // SDK uses HTTP Basic Auth for shopId+secretKey (payments).
    _checkout = new YooCheckout({ shopId, secretKey });
    return _checkout;
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
    const checkout = getCheckout();
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
        const payment = await checkout.createPayment(body, idempotenceKey);
        return { idempotenceKey, payment };
    } catch (e) {
        const err = new Error(formatYooCheckoutError(e));
        err.cause = e;
        throw err;
    }
}

async function getPayment(paymentId) {
    const checkout = getCheckout();
    try {
        return await checkout.getPayment(paymentId);
    } catch (e) {
        const err = new Error(formatYooCheckoutError(e));
        err.cause = e;
        throw err;
    }
}

module.exports = { createPayment, getPayment };
