#!/usr/bin/env node
/**
 * GenAPI Kling v2.6 smoke test:
 * - reads local photo from project root
 * - sends image+prompt to GenAPI
 * - polls status endpoint until success/failed
 * - downloads mp4 to project root
 *
 * Usage:
 *   GENAPI_API_KEY=... node genapi-smoke.js ./photo.jpg
 *
 * Optional:
 *   GENAPI_MODEL_ID=kling-video-2-6
 *   GENAPI_BASE_URL=https://api.gen-api.ru
 *   GENAPI_STATUS_PATH=/api/v1/requests/{id}
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");

function requireEnv(name) {
    const v = process.env[name];
    if (!v) {
        console.error(`Missing env ${name}`);
        process.exit(1);
    }
    return v;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function guessMime(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".png") return "image/png";
    if (ext === ".webp") return "image/webp";
    return "image/jpeg";
}

// Extract first URL that looks like a video from any nested JSON
function findFirstVideoUrl(obj) {
    const seen = new Set();
    const stack = [obj];

    while (stack.length) {
        const cur = stack.pop();
        if (!cur || typeof cur !== "object") continue;
        if (seen.has(cur)) continue;
        seen.add(cur);

        for (const [k, v] of Object.entries(cur)) {
            if (typeof v === "string") {
                const s = v.trim();
                // Heuristics: mp4 link or "storage" link that likely returns video
                if (/^https?:\/\//i.test(s) && (s.includes(".mp4") || k.includes("video") || k.includes("result") || s.includes("storage"))) {
                    return s;
                }
            } else if (Array.isArray(v)) {
                for (const it of v) stack.push(it);
            } else if (v && typeof v === "object") {
                stack.push(v);
            }
        }
    }
    return null;
}

async function downloadToFile(url, outPath) {
    const res = await axios.get(url, { responseType: "stream", timeout: 180_000 });
    await new Promise((resolve, reject) => {
        const w = fs.createWriteStream(outPath);
        res.data.pipe(w);
        w.on("finish", resolve);
        w.on("error", reject);
    });
}

(async () => {
    const apiKey = requireEnv("GENAPI_API_KEY");
    const baseURL = process.env.GENAPI_BASE_URL || "https://api.gen-api.ru";
    const modelId = process.env.GENAPI_MODEL_ID || "kling-video-2-6";
    const statusTpl = process.env.GENAPI_STATUS_PATH || "/api/v1/requests/{id}";

    const photoArg = process.argv[2] || "./photo.jpg";
    const photoPath = path.resolve(process.cwd(), photoArg);
    if (!fs.existsSync(photoPath)) {
        console.error(`Photo not found: ${photoPath}`);
        process.exit(1);
    }

    const mime = guessMime(photoPath);
    const buf = fs.readFileSync(photoPath);
    const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;

    // Emotion: blink (фикс)
    const prompt =
        "Make a natural blink once or twice. Subtle facial motion only. " +
        "Keep identity, skin texture and lighting consistent. No head movement. 5 seconds.";
    const negativePrompt =
        "low resolution, error, worst quality, low quality, defects, artifacts, flicker, deformed";

    const api = axios.create({
        baseURL,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json"
        }
    });

    console.log("[1/4] Creating GenAPI request…");
    const createPayload = {
        image_url: dataUrl,
        prompt,
        negative_prompt: negativePrompt,
        duration: 5,
        generate_audio: false,
        aspect_ratio: "16:9",
        callback_url: null,
        translate_input: true
    };

    // В их примерах иногда мелькает GET, но по смыслу генерация должна быть POST.
    // Делаем POST, а если вдруг API у них реально на GET — сделаем fallback.
    let created;
    try {
        const r = await api.post(`/api/v1/networks/${modelId}`, createPayload);
        created = r.data;
    } catch (e) {
        console.error("[create] POST failed, trying GET fallback…");
        const r = await api.get(`/api/v1/networks/${modelId}`, { data: createPayload });
        created = r.data;
    }

    const requestId = created?.request_id ?? created?.id ?? created?.requestId;
    if (!requestId) {
        console.error("Create response does not contain request_id:");
        console.error(JSON.stringify(created, null, 2));
        process.exit(1);
    }

    console.log(`[2/4] request_id=${requestId} — polling status…`);

    const statusUrl = statusTpl.replace("{id}", encodeURIComponent(String(requestId)));

    let final;
    for (let i = 0; i < 120; i++) { // ~10 минут при интервале 5 сек
        const st = await api.get(statusUrl).then((r) => r.data).catch((err) => {
            console.error("[status] error:", err.response?.status, err.response?.data || err.message);
            throw err;
        });

        const status = st?.status || st?.state;
        console.log(`  - status: ${status}`);

        if (status === "failed" || status === "error") {
            console.error("[3/4] Generation failed:");
            console.error(JSON.stringify(st, null, 2));
            process.exit(2);
        }

        if (status === "success" || status === "completed" || status === "done") {
            final = st;
            break;
        }

        await sleep(5000);
    }

    if (!final) {
        console.error("Timeout waiting for success/failed. Last status not final.");
        process.exit(3);
    }

    const videoUrl =
        final?.result_url ||
        final?.video_url ||
        final?.url ||
        findFirstVideoUrl(final);

    if (!videoUrl) {
        console.error("[3/4] success but could not find video URL in response:");
        console.error(JSON.stringify(final, null, 2));
        process.exit(4);
    }

    console.log("[4/4] Downloading video…");
    const outPath = path.resolve(process.cwd(), "genapi-output.mp4");
    await downloadToFile(videoUrl, outPath);

    console.log("✅ Done:", outPath);
})().catch((e) => {
    console.error("Fatal:", e.response?.status, e.response?.data || e.message);
    process.exit(1);
});
