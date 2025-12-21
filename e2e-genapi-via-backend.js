#!/usr/bin/env node
/**
 * WORKING CLI E2E smoke via deployed backend:
 * - OTP login (optional) OR use existing JWT
 * - upload local photo -> gets imageUrl (with fallbacks: endpoint + field name)
 * - create job
 * - poll job until completed/failed
 * - download result video to project root
 *
 * Usage (with existing token):
 *   API_BASE_URL=https://photo.skislemt.beget.tech JWT=... node e2e-genapi-via-backend.js ./photo.jpg blink
 *
 * Usage (OTP flow):
 *   API_BASE_URL=https://photo.skislemt.beget.tech node e2e-genapi-via-backend.js ./photo.jpg blink user@example.com
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const readline = require("readline");

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function rlQuestion(q) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) =>
        rl.question(q, (ans) => {
            rl.close();
            resolve(ans);
        })
    );
}

function joinUrl(base, p) {
    return base.replace(/\/+$/, "") + p;
}

/**
 * Комментарий:
 * Некоторые окружения отдают resultVideoUrl как относительный путь.
 * Эта функция нормализует.
 */
function toAbsoluteMaybe(base, maybeUrl) {
    if (!maybeUrl) return "";
    if (String(maybeUrl).startsWith("http")) return String(maybeUrl);
    return joinUrl(base, String(maybeUrl).startsWith("/") ? String(maybeUrl) : `/${maybeUrl}`);
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

/**
 * Комментарий:
 * Делает upload с fallback’ами:
 * - пробуем разные endpoints
 * - пробуем разные field names (photo/file/image)
 * - принимаем разные форматы ответа { imageUrl } / { url } / { data: { imageUrl } }
 */
async function uploadPhotoWithFallbacks({ base, authHeaders, photoPath }) {
    const endpoints = [
        "/api/v1/uploads/photo",
        "/api/v1/uploads/image",
        "/api/v1/uploads",
    ];

    const fieldNames = ["photo", "file", "image"];

    const errors = [];

    for (const ep of endpoints) {
        for (const field of fieldNames) {
            try {
                const form = new FormData();
                form.append(field, fs.createReadStream(photoPath));

                const res = await axios.post(joinUrl(base, ep), form, {
                    headers: { ...authHeaders, ...form.getHeaders() },
                    maxBodyLength: Infinity,
                    timeout: 120_000,
                    validateStatus: () => true,
                });

                if (res.status < 200 || res.status >= 300) {
                    errors.push(`[upload] ${ep} field=${field} -> ${res.status}`);
                    continue;
                }

                const data = res.data || {};
                const imageUrl =
                    data.imageUrl ||
                    data.url ||
                    data.image_url ||
                    data?.data?.imageUrl ||
                    data?.data?.url;

                if (!imageUrl) {
                    errors.push(`[upload] ${ep} field=${field} -> 2xx but no imageUrl`);
                    continue;
                }

                return imageUrl;
            } catch (e) {
                errors.push(
                    `[upload] ${ep} field=${field} -> ${e.response?.status || "ERR"} ${e.message}`
                );
            }
        }
    }

    const msg =
        "Upload failed on all fallbacks.\n" +
        errors.slice(0, 12).map((x) => `- ${x}`).join("\n");
    throw new Error(msg);
}

/**
 * Комментарий:
 * create job тоже бывает разным:
 * - 200 или 201
 * - {jobId} или {id}
 */
async function createJob({ base, authHeaders, imageUrl, emotionCode }) {
    const res = await axios.post(
        joinUrl(base, "/api/v1/jobs"),
        { imageUrl, emotionCode },
        {
            headers: authHeaders,
            timeout: 45_000,
            validateStatus: () => true,
        }
    );

    if (res.status === 402) {
        const err = new Error("INSUFFICIENT_TOKENS");
        err.code = "INSUFFICIENT_TOKENS";
        err.payload = res.data;
        throw err;
    }

    if (res.status !== 200 && res.status !== 201) {
        throw new Error(`Failed to create job: ${res.status} ${JSON.stringify(res.data)}`);
    }

    const jobId = res.data?.jobId || res.data?.id;
    if (!jobId) throw new Error("No jobId/id received from create job response");

    return jobId;
}

/**
 * Комментарий:
 * job DTO/DB поля могут отличаться:
 * - resultVideoUrl vs result_video_url
 * - errorMessage vs error_message
 */
function normalizeJob(job) {
    if (!job || typeof job !== "object") return job;

    return {
        ...job,
        status: job.status,
        providerStatus: job.providerStatus ?? job.provider_status,
        resultVideoUrl:
            job.resultVideoUrl ??
            job.result_video_url ??
            job.resultVideoURL ??
            job.resultVideo ??
            null,
        errorMessage: job.errorMessage ?? job.error_message ?? null,
    };
}

(async () => {
    const base = process.env.API_BASE_URL || process.env.API_BASE || "https://photo.skislemt.beget.tech";

    const photoArg = process.argv[2] || "./photo.jpg";
    const emotionCode = process.argv[3] || "blink";
    const email = process.argv[4];

    const photoPath = path.resolve(process.cwd(), photoArg);
    if (!fs.existsSync(photoPath)) {
        console.error("❌ Photo not found:", photoPath);
        process.exit(1);
    }

    let jwt = process.env.JWT || process.env.AUTH_TOKEN || "";

    // OTP flow if no JWT
    if (!jwt) {
        if (!email) {
            console.error("❌ No JWT provided. Either set JWT (or AUTH_TOKEN) or pass email for OTP flow.");
            process.exit(1);
        }

        console.log("[auth] requesting OTP…");
        const r1 = await axios.post(joinUrl(base, "/api/v1/auth/request-code"), { email }, { validateStatus: () => true });
        if (r1.status < 200 || r1.status >= 300) {
            throw new Error(`[auth] request-code failed: ${r1.status} ${JSON.stringify(r1.data)}`);
        }

        const code = (await rlQuestion("[auth] paste OTP code from email: ")).trim();
        if (!code) throw new Error("OTP code is empty");

        const v = await axios.post(joinUrl(base, "/api/v1/auth/verify-code"), { email, code }, { validateStatus: () => true });
        if (v.status < 200 || v.status >= 300) {
            throw new Error(`[auth] verify-code failed: ${v.status} ${JSON.stringify(v.data)}`);
        }

        jwt = v.data?.accessToken || v.data?.token;
        if (!jwt) throw new Error("No accessToken/token received");
    }

    const authHeaders = { Authorization: `Bearer ${jwt}` };

    /* ---------------- Upload ---------------- */

    console.log("[1/5] Upload photo…");
    const imageUrl = await uploadPhotoWithFallbacks({ base, authHeaders, photoPath });
    console.log("  imageUrl =", imageUrl);

    /* ---------------- Create job ---------------- */

    console.log("[2/5] Create job…");
    let jobId;
    try {
        jobId = await createJob({ base, authHeaders, imageUrl, emotionCode });
    } catch (e) {
        if (e.code === "INSUFFICIENT_TOKENS") {
            console.error("❌ INSUFFICIENT_TOKENS");
            console.error(e.payload);
            process.exit(2);
        }
        throw e;
    }

    console.log("  jobId =", jobId);

    /* ---------------- Poll ---------------- */

    console.log("[3/5] Poll job status…");
    let job = null;

    const maxTries = Number(process.env.E2E_MAX_TRIES || 180);
    const pollMs = Number(process.env.E2E_POLL_MS || 5000);

    for (let i = 0; i < maxTries; i++) {
        const r = await axios.get(joinUrl(base, `/api/v1/jobs/${jobId}`), {
            headers: authHeaders,
            timeout: 45_000,
            validateStatus: () => true,
        });

        if (r.status < 200 || r.status >= 300) {
            process.stdout.write(`  status=HTTP_${r.status}\r`);
            await sleep(pollMs);
            continue;
        }

        job = normalizeJob(r.data);
        process.stdout.write(`  status=${job.status} providerStatus=${job.providerStatus || ""}\r`);

        if (job.status === "failed") {
            console.log("\n❌ Job failed:", job.errorMessage || "unknown error");
            process.exit(3);
        }

        if (job.status === "completed") {
            console.log("\n✅ Job completed");
            break;
        }

        await sleep(pollMs);
    }

    if (!job || job.status !== "completed") {
        console.log("\n⏳ Timeout waiting for completed/failed");
        process.exit(4);
    }

    const resultVideoUrl = job.resultVideoUrl;
    if (!resultVideoUrl) throw new Error("Completed job without resultVideoUrl");

    const fullVideoUrl = toAbsoluteMaybe(base, resultVideoUrl);

    console.log("[4/5] Download video:", fullVideoUrl);

    const outName = process.env.E2E_OUT || "result.mp4";
    const outPath = path.resolve(process.cwd(), outName);

    await downloadToFile(fullVideoUrl, outPath);

    console.log("[5/5] Saved:", outPath);
    process.exit(0);
})().catch((e) => {
    console.error("\n🔥 Fatal:");
    if (e.code === "INSUFFICIENT_TOKENS") {
        console.error("INSUFFICIENT_TOKENS");
    } else {
        console.error(e.response?.status, e.response?.data || e.message);
    }
    process.exit(1);
});
