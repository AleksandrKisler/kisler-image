const axios = require("axios");

function requireEnv(name) {
    if (!process.env[name]) throw new Error(`${name} is not set`);
    return process.env[name];
}

const baseURL = process.env.GENAPI_BASE_URL || "https://api.gen-api.ru";
const api = axios.create({
    baseURL,
    timeout: 90_000,
    headers: {
        Authorization: `Bearer ${requireEnv("GENAPI_API_KEY")}`,
        "Content-Type": "application/json",
        Accept: "application/json"
    }
});

/**
 * Kling v2.6 Pro (kling-video-2-6) API page shows the network endpoint:
 *   https://api.gen-api.ru/api/v1/networks/kling-video-2-6
 * We use POST for generation with JSON body.
 */
async function createKlingJob({imageUrl, prompt, negativePrompt, callbackUrl}) {
    const modelId = process.env.GENAPI_MODEL_ID || "kling-video-2-6";
    const url = `/api/v1/networks/${modelId}`;

    const payload = {
        input: {
            image_url: imageUrl,
            prompt,
            negative_prompt: negativePrompt,
            duration: 5,
        },
        callback_url: callbackUrl
    };

    const res = await api.post(url, payload);
    if (!res.data || !res.data.request_id) {
        throw new Error("GenAPI: invalid response (missing request_id)");
    }
    return res.data; // { request_id, status? }
}

async function getRequestStatus(requestId) {
    // Many GenAPI network APIs expose status by GET /api/v1/requests/{id}
    // If your API returns a different path, override with GENAPI_STATUS_PATH template.
    const tpl = process.env.GENAPI_STATUS_PATH || "/api/v1/requests/{id}";
    const path = tpl.replace("{id}", encodeURIComponent(requestId));
    const res = await api.get(path);
    if (!res.data || !res.data.status) throw new Error("GenAPI: invalid status response");
    return res.data; // { status: processing|success|failed, result_url?, error? }
}

module.exports = {createKlingJob, getRequestStatus};
