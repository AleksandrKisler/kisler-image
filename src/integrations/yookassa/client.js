const { YooCheckout } = require("@a2seven/yoo-checkout");
const { v4: uuidv4 } = require("uuid");

function requireEnv(name) {
    const v = process.env[name];
    if (!v || !String(v).trim()) throw new Error(`${name} is not set`);
    return String(v).trim();
}

const shopId = process.env.YOOKASSA_SHOP_ID;
const secretKey = process.env.YOOKASSA_SECRET_KEY;
/**
 * A single YooCheckout client for the whole process.
 *
 * SDK uses HTTP Basic Auth:
 *   username: shopId
 *   password: secretKey
 */
if (!shopId || !secretKey) {
    throw new Error('YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY not set');
}

// ВАЖНО: никаких token (OAuth) тут не должно быть
const _checkout = new YooCheckout({ shopId, secretKey })

function formatYooCheckoutError(e) {
    const msg = e?.message || "YooKassa request failed";
    const status = e?.response?.status;
    const data = e?.response?.data;
    if (!status) return msg;
    try {
        return `YooKassa API error: HTTP ${status} — ${JSON.stringify(data)}`;
    } catch {
        return `YooKassa API error: HTTP ${status}`;
    }
}

/**
 * Creates payment and returns { idempotenceKey, payment } to keep
 * backward compatibility with the rest of the code.
 *
 * SDK signature:
 *   checkout.createPayment(payload, idempotenceKey)
 */
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

    // Optional: allow forcing a specific method (e.g. bank_card)
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
    try {
        return await _checkout.getPayment(paymentId);
    } catch (e) {
        const err = new Error(formatYooCheckoutError(e));
        err.cause = e;
        throw err;
    }
}

module.exports = { createPayment, getPayment: checkout };
