const axios = require("axios");

/**
 * Что исправлено:
 * ✅ убран console.log(res)
 * ✅ добавлен extractVideoUrl() — GenAPI часто возвращает результат в разных полях
 * ✅ getRequestStatus() теперь пробует несколько endpoint'ов статуса и кэширует рабочий
 */

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

    if (Array.isArray(payload.result)) candidates.push(...payload.result);
    if (payload.result && typeof payload.result === "object") candidates.push(payload.result);

    for (const c of candidates) {
        if (!c) continue;

        if (typeof c === "string" && c.startsWith("http")) return c;

        if (typeof c === "object") {
            const u =
                c.url ||
                c.video_url ||
                c.result_url ||
                c.file_url ||
                c.download_url ||
                c.signed_url;

            if (typeof u === "string" && u.startsWith("http")) return u;
        }
    }

    return null;
}

async function createKlingJob({ imageUrl, prompt, negativePrompt, callbackUrl }) {
    try {
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

        if ((process.env.GENAPI_DEBUG || "0") === "1") {
            console.log("[GENAPI PAYLOAD]", JSON.stringify(payload, null, 2));
        }

        const res = await api.post(url, payload);

        if (!res.data || !res.data.request_id) {
            throw new Error("GenAPI: invalid response (missing request_id)");
        }

        return res.data; // { request_id, status? }
    } catch (e) {
        console.error("[GENAPI ERROR STATUS]", e.response?.status);
        console.error("[GENAPI ERROR BODY]", JSON.stringify(e.response?.data, null, 2));
        throw e;
    }
}

let cachedStatusTemplate = null;

function buildStatusCandidates(requestId) {
    const id = encodeURIComponent(requestId);
    const list = [];

    if (process.env.GENAPI_STATUS_PATH) list.push(process.env.GENAPI_STATUS_PATH);

    // fallback варианты
    list.push("/api/v1/requests/{id}");
    list.push("/api/v1/requests/{id}/status");
    list.push("/api/v1/requests/status/{id}");
    list.push("/api/v1/tasks/{id}");
    list.push("/api/v1/tasks/{id}/status");
    list.push("/api/v1/requests?request_id={id}");
    list.push("/api/v1/requests?id={id}");

    return Array.from(new Set(list)).map((tpl) => tpl.replace("{id}", id));
}

async function getRequestStatus(requestId) {
    const DEBUG = (process.env.GENAPI_DEBUG || "0") === "1";

    const tryOne = async (path) => {
        const res = await api.get(path);
        if (!res.data || !res.data.status) throw new Error("GenAPI: invalid status response");
        return { ...res.data, _videoUrl: extractVideoUrl(res.data) };
    };

    if (cachedStatusTemplate) {
        const p = cachedStatusTemplate.replace("{id}", encodeURIComponent(requestId));
        try {
            return await tryOne(p);
        } catch (e) {
            if (e.response?.status === 404) cachedStatusTemplate = null;
            else throw e;
        }
    }

    const candidates = buildStatusCandidates(requestId);

    for (const p of candidates) {
        try {
            if (DEBUG) console.log("[GENAPI STATUS TRY]", p);
            const data = await tryOne(p);
            cachedStatusTemplate = p.replace(encodeURIComponent(requestId), "{id}");
            if (DEBUG) console.log("[GENAPI STATUS OK]", cachedStatusTemplate);
            return data;
        } catch (e) {
            if (e.response?.status === 404) continue;
            throw e;
        }
    }

    const err = new Error("GenAPI status endpoint not found (404 on all candidates)");
    err.code = "GENAPI_STATUS_404";
    throw err;
}

module.exports = { createKlingJob, getRequestStatus, extractVideoUrl };
