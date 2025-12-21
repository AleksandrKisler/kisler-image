#!/usr/bin/env node
/**
 * E2E smoke via deployed backend:
 * - OTP login (optional) OR use existing JWT
 * - upload local photo -> gets imageUrl
 * - create job (emotionCode fixed)
 * - poll job until completed/failed
 * - download result video to project root
 *
 * Usage (with existing token):
 *   API_BASE_URL=https://photo.skislemt.beget.tech JWT=... node e2e-genapi-via-backend.js ./photo.jpg blink
 *
 * Usage (OTP flow):
 *   API_BASE_URL=https://photo.skislemt.beget.tech node e2e-genapi-via-backend.js ./photo.jpg blink user@example.com
 *   (script will request OTP and ask you to paste the code)
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
    const base = process.env.API_BASE_URL || "https://photo.skislemt.beget.tech";

    const photoArg = process.argv[2] || "./photo.jpg";
    const emotionCode = process.argv[3] || "blink";
    const email = process.argv[4]; // optional for OTP

    const photoPath = path.resolve(process.cwd(), photoArg);
    if (!fs.existsSync(photoPath)) {
        console.error("Photo not found:", photoPath);
        process.exit(1);
    }

    let jwt = process.env.JWT || "";

    // If no JWT provided, run OTP flow (requires email + manual code paste)
    if (!jwt) {
        if (!email) {
            console.error("No JWT provided. Either set JWT env or pass email as 3rd arg for OTP flow.");
            console.error("Example: API_BASE_URL=... node e2e-genapi-via-backend.js ./photo.jpg blink user@example.com");
            process.exit(1);
        }

        console.log("[auth] requesting OTP…");
        await axios.post(joinUrl(base, "/api/v1/auth/request-code"), { email }, { timeout: 30_000 });

        const code = (await rlQuestion("[auth] paste OTP code from email: ")).trim();
        if (!code) throw new Error("OTP code is empty");

        const v = await axios.post(joinUrl(base, "/api/v1/auth/verify-code"), { email, code }, { timeout: 30_000 });
        jwt = v.data?.accessToken;
        if (!jwt) {
            console.error("verify-code response:", v.data);
            throw new Error("No accessToken received");
        }
    }

    const authHeaders = { Authorization: `Bearer ${jwt}` };

    console.log("[1/5] Upload photo…");
    const form = new FormData();
    form.append("photo", fs.createReadStream(photoPath));

    const up = await axios.post(joinUrl(base, "/api/v1/uploads/photo"), form, {
        headers: { ...authHeaders, ...form.getHeaders() },
        maxBodyLength: Infinity,
        timeout: 120_000
    });

    const imageUrl = up.data?.imageUrl;
    if (!imageUrl) {
        console.error("upload response:", up.data);
        throw new Error("Upload did not return imageUrl");
    }
    console.log("  imageUrl =", imageUrl);

    console.log("[2/5] Create job…");
    const created = await axios.post(
        joinUrl(base, "/api/v1/jobs"),
        { imageUrl, emotionCode },
        { headers: authHeaders, timeout: 30_000 }
    );

    if (created.status === 402) {
        console.error("INSUFFICIENT_TOKENS:", created.data);
        process.exit(2);
    }

    const jobId = created.data?.jobId;
    if (!jobId) {
        console.error("create job response:", created.data);
        throw new Error("No jobId received");
    }
    console.log("  jobId =", jobId);

    console.log("[3/5] Poll job status…");
    let job;
    for (let i = 0; i < 180; i++) { // ~15 минут при интервале 5 сек
        const r = await axios.get(joinUrl(base, `/api/v1/jobs/${encodeURIComponent(jobId)}`), {
            headers: authHeaders,
            timeout: 30_000
        });

        job = r.data;
        const status = job?.status;
        process.stdout.write(`  status=${status}\r`);

        if (status === "failed") {
            console.log("\n❌ Job failed:", job?.errorMessage || "unknown error");
            process.exit(3);
        }
        if (status === "completed") {
            console.log("\n✅ Job completed");
            break;
        }
        await sleep(5000);
    }

    if (!job || job.status !== "completed") {
        console.log("\n⏳ Timeout waiting for completed/failed");
        process.exit(4);
    }

    const resultVideoUrl = job.resultVideoUrl;
    if (!resultVideoUrl) {
        console.error("completed job but missing resultVideoUrl:", job);
        process.exit(5);
    }

    const fullVideoUrl = resultVideoUrl.startsWith("http")
        ? resultVideoUrl
        : joinUrl(base, resultVideoUrl);

    console.log("[4/5] Download video:", fullVideoUrl);
    const outPath = path.resolve(process.cwd(), "result.mp4");
    await downloadToFile(fullVideoUrl, outPath);

    console.log("[5/5] Saved:", outPath);
})().catch((e) => {
    console.error("Fatal:", e.response?.status, e.response?.data || e.message);
    process.exit(1);
});
