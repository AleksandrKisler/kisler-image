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

/**
 * Пытаемся достать URL видео из разных возможных форматов ответа.
 * Возвращает string | null
 */
function extractVideoUrl(payload) {
    if (!payload || typeof payload !== "object") return null;

    // самые частые варианты
    const direct =
        payload.result_url ||
        payload.video_url ||
        payload.url ||
        payload.result?.url ||
        payload.result?.video_url ||
        payload.result?.result_url;

    if (typeof direct === "string" && direct.startsWith("http")) return direct;

    // иногда результат лежит в output / outputs
    const candidates = [];

    if (Array.isArray(payload.output)) candidates.push(...payload.output);
    if (Array.isArray(payload.outputs)) candidates.push(...payload.outputs);

    if (payload.output && typeof payload.output === "object") candidates.push(payload.output);
    if (payload.outputs && typeof payload.outputs === "object") candidates.push(payload.outputs);

    // иногда result может быть массивом/объектом
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

/**
 * Создание job в GenAPI.
 */
async function createKlingJob({ imageUrl, prompt, negativePrompt, callbackUrl }) {
    try {
        const modelId = process.env.GENAPI_MODEL_ID || "kling-video-2-6";
        const url = `/api/v1/networks/${modelId}`;
        const duration = 5;
        const aspectRatio = process.env.GENAPI_ASPECT_RATIO || "16:9";

        const payload = {
            image_url: imageUrl,
            prompt: String(prompt || "").trim(),
            negative_prompt: String(negativePrompt || "").trim(),
            duration,
            aspect_ratio: aspectRatio,
            generate_audio: false,
            callback_url: callbackUrl || undefined,
        };

        console.log("[GENAPI PAYLOAD]", JSON.stringify(payload, null, 2));

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

/**
 * Статус запроса в GenAPI.
 * Важно: может вернуть не только status, но и итоговый URL.
 */
async function getRequestStatus(requestId) {
    const tpl = process.env.GENAPI_STATUS_PATH || "/api/v1/requests/{id}";
    const path = tpl.replace("{id}", encodeURIComponent(requestId));

    const res = await api.get(path);

    // Нормальный лог — только data
    if ((process.env.GENAPI_DEBUG || "0") === "1") {
        console.log("[GENAPI STATUS DATA]", JSON.stringify(res.data, null, 2));
    }

    if (!res.data || !res.data.status) throw new Error("GenAPI: invalid status response");

    return {
        ...res.data,
        // добавляем нормализованное поле, чтобы worker не гадал
        _videoUrl: extractVideoUrl(res.data),
    };
}

module.exports = { createKlingJob, getRequestStatus, extractVideoUrl };
