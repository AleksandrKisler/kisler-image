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
    const email = process.argv[4];

    const photoPath = path.resolve(process.cwd(), photoArg);
    if (!fs.existsSync(photoPath)) {
        console.error("Photo not found:", photoPath);
        process.exit(1);
    }

    let jwt = process.env.JWT || "";

    // OTP flow if no JWT
    if (!jwt) {
        if (!email) {
            console.error("No JWT provided. Either set JWT or pass email for OTP flow.");
            process.exit(1);
        }

        console.log("[auth] requesting OTP…");
        await axios.post(joinUrl(base, "/api/v1/auth/request-code"), { email });

        const code = (await rlQuestion("[auth] paste OTP code from email: ")).trim();
        if (!code) throw new Error("OTP code is empty");

        const v = await axios.post(joinUrl(base, "/api/v1/auth/verify-code"), { email, code });
        jwt = v.data?.accessToken;
        if (!jwt) throw new Error("No accessToken received");
    }

    const authHeaders = { Authorization: `Bearer ${jwt}` };

    /* ---------------- Upload ---------------- */

    console.log("[1/5] Upload photo…");
    const form = new FormData();
    form.append("photo", fs.createReadStream(photoPath));

    const up = await axios.post(joinUrl(base, "/api/v1/uploads/photo"), form, {
        headers: { ...authHeaders, ...form.getHeaders() },
        maxBodyLength: Infinity,
        timeout: 120_000
    });

    const imageUrl = up.data?.imageUrl;
    if (!imageUrl) throw new Error("Upload did not return imageUrl");

    console.log("  imageUrl =", imageUrl);

    /* ---------------- Create job ---------------- */

    console.log("[2/5] Create job…");
    const created = await axios.post(
        joinUrl(base, "/api/v1/jobs"),
        { imageUrl, emotionCode },
        {
            headers: authHeaders,
            timeout: 30_000,
            validateStatus: () => true
        }
    );

    if (created.status === 402) {
        console.error("❌ INSUFFICIENT_TOKENS");
        console.error(created.data);
        process.exit(2);
    }

    if (created.status !== 200) {
        console.error("❌ Failed to create job:", created.status);
        console.error(created.data);
        process.exit(2);
    }

    const jobId = created.data?.jobId;
    if (!jobId) throw new Error("No jobId received");

    console.log("  jobId =", jobId);

    /* ---------------- Poll ---------------- */

    console.log("[3/5] Poll job status…");
    let job;

    for (let i = 0; i < 180; i++) {
        const r = await axios.get(joinUrl(base, `/api/v1/jobs/${jobId}`), {
            headers: authHeaders,
            timeout: 30_000
        });

        job = r.data;
        process.stdout.write(`  status=${job.status}\r`);

        if (job.status === "failed") {
            console.log("\n❌ Job failed:", job.errorMessage || "unknown error");
            process.exit(3);
        }

        if (job.status === "completed") {
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
    if (!resultVideoUrl) throw new Error("Completed job without resultVideoUrl");

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
