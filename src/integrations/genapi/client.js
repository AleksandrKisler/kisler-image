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
        Accept: "application/json",
    },
});

function extractVideoUrl(payload) {
    if (!payload || typeof payload !== "object") return null;

    const direct =
        payload.result_url ||
        payload.video_url ||
        payload.url ||
        payload.result?.url ||
        payload.result?.video_url ||
        payload.result?.result_url;

    if (typeof direct === "string" && direct.startsWith("http")) return direct;

    const candidates = [];
    if (Array.isArray(payload.output)) candidates.push(...payload.output);
    if (Array.isArray(payload.outputs)) candidates.push(...payload.outputs);
    if (payload.output && typeof payload.output === "object") candidates.push(payload.output);
    if (payload.outputs && typeof payload.outputs === "object") candidates.push(payload.outputs);
    if (payload.result && typeof payload.result === "object") candidates.push(payload.result);
    if (Array.isArray(payload.result)) candidates.push(...payload.result);

    for (const c of candidates) {
        if (!c) continue;
        if (typeof c === "string" && c.startsWith("http")) return c;

        if (typeof c === "object") {
            const u =
                c.url || c.video_url || c.result_url || c.file_url || c.download_url || c.signed_url;
            if (typeof u === "string" && u.startsWith("http")) return u;
        }
    }

    return null;
}

async function createKlingJob({ imageUrl, prompt, negativePrompt, callbackUrl }) {
    const modelId = process.env.GENAPI_MODEL_ID || "kling-video-2-6";
    const url = `/api/v1/networks/${modelId}`;

    const payload = {
        image_url: imageUrl,
        prompt: String(prompt || "").trim(),
        negative_prompt: String(negativePrompt || "").trim(),
        duration: 5,
        aspect_ratio: process.env.GENAPI_ASPECT_RATIO || "16:9",
        generate_audio: false,
        callback_url: callbackUrl || undefined,
    };

    const res = await api.post(url, payload);
    if (!res.data || !res.data.request_id) {
        throw new Error("GenAPI: invalid response (missing request_id)");
    }
    return res.data;
}

async function getRequestStatus(requestId) {
    // ✅ Правильный путь по твоей проверке:
    const path = `/api/v1/request/get/${encodeURIComponent(requestId)}`;

    const res = await api.get(path);
    if (!res.data || !res.data.status) throw new Error("GenAPI: invalid status response");

    return {
        ...res.data,
        _videoUrl: extractVideoUrl(res.data),
    };
}

module.exports = { createKlingJob, getRequestStatus, extractVideoUrl };
