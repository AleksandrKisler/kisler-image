const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`${name} is not set`);
  return process.env[name];
}

function ykApi() {
  const shopId = requireEnv("YOOKASSA_SHOP_ID");
  const secretKey = requireEnv("YOOKASSA_SECRET_KEY");
  const baseURL = process.env.YOOKASSA_API_BASE || "https://api.yookassa.ru";

  return axios.create({
    baseURL,
    timeout: 60_000,
    auth: { username: shopId, password: secretKey },
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    }
  });
}

/**
 * Create payment using YooKassa API v3.
 * Needs Idempotence-Key header for safe retries.
 */
async function createPayment({ amountRub, description, returnUrl, metadata }) {
  const api = ykApi();
  const idem = uuidv4();

  const body = {
    amount: { value: amountRub.toFixed(2), currency: "RUB" },
    capture: true,
    confirmation: { type: "redirect", return_url: returnUrl },
    payment_method_data: { type: "bank_card" },
    description,
    metadata: metadata || {},
    test: String(process.env.YOOKASSA_TEST_MODE || "").toLowerCase() === "true",
  };

  const res = await api.post("/v3/payments", body, { headers: { "Idempotence-Key": idem } });
  return { idempotenceKey: idem, payment: res.data };
}

async function getPayment(paymentId) {
  const api = ykApi();
  const res = await api.get(`/v3/payments/${encodeURIComponent(paymentId)}`);
  return res.data;
}

module.exports = { createPayment, getPayment };
