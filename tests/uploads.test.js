const request = require("supertest");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const path = require("path");
const sharp = require("sharp");

process.env.JWT_ACCESS_SECRET = "test_secret";
process.env.JWT_ACCESS_TTL = "15m";
process.env.SQLITE_FILE = "./.testdata/test.sqlite";
process.env.MAILER_MODE = "dev";
process.env.GENAPI_API_KEY = "dummy";
process.env.UPLOAD_MAX_BYTES = "8000000";
process.env.UPLOAD_ALLOWED_MIME = "image/jpeg,image/png,image/webp,image/heic,image/heif,image/tiff,image/x-tiff";

const {app} = require("../src/app");
const {migrate} = require("../src/db/migrate");
const {getDb} = require("../src/db");

function token(sub = "u1") {
    return jwt.sign({sub, email: "user@example.com"}, process.env.JWT_ACCESS_SECRET, {expiresIn: "15m"});
}

beforeAll(async () => {
    fs.mkdirSync("./.testdata", {recursive: true});
    if (fs.existsSync(process.env.SQLITE_FILE)) fs.unlinkSync(process.env.SQLITE_FILE);
    await migrate();
    const db = getDb();
    await db("users").insert({
        id: "u1",
        email: "user@example.com",
        password_hash: null,
        token_balance: 1,
        created_at: new Date().toISOString()
    });
});

describe("uploads + token debit", () => {
    test("upload photo requires auth", async () => {
        const res = await request(app).post("/api/v1/uploads/photo");
        expect(res.statusCode).toBe(401);
    });

    test("upload photo returns imageUrl", async () => {
        // create tiny jpeg header file
        const tmp = path.join(__dirname, "tiny.jpg");
        fs.writeFileSync(tmp, Buffer.from([0xFF, 0xD8, 0xFF, 0xD9])); // minimal jpeg
        const res = await request(app)
            .post("/api/v1/uploads/photo")
            .set("Authorization", "Bearer " + token())
            .attach("photo", tmp, {contentType: "image/jpeg"});

        expect(res.statusCode).toBe(200);
        expect(res.body.imageUrl).toMatch(/^\/uploads\/photos\//);

        const saved = path.join(__dirname, "..", "public", res.body.imageUrl);
        if (fs.existsSync(saved)) fs.unlinkSync(saved);
    });

    test("tiff uploads are converted to jpeg", async () => {
        const buffer = await sharp({
            create: {width: 1, height: 1, channels: 3, background: {r: 255, g: 0, b: 0}}
        })
            .tiff()
            .toBuffer();

        const res = await request(app)
            .post("/api/v1/uploads/photo")
            .set("Authorization", "Bearer " + token())
            .attach("photo", buffer, {filename: "tiny.tiff", contentType: "image/tiff"});

        expect(res.statusCode).toBe(200);
        expect(res.body.imageUrl).toMatch(/\.jpg$/);

        const saved = path.join(__dirname, "..", "public", res.body.imageUrl);
        expect(fs.existsSync(saved)).toBe(true);
        const metadata = await sharp(saved).metadata();
        expect(metadata.format).toBe("jpeg");

        fs.unlinkSync(saved);
    });

    test("returns 415 when HEIC decoding is unavailable", async () => {
        const uploadsDir = path.join(__dirname, "..", "public", "uploads", "photos");
        const before = new Set(fs.readdirSync(uploadsDir));
        const originalHeif = sharp.format.heif;
        sharp.format.heif = undefined;

        const res = await request(app)
            .post("/api/v1/uploads/photo")
            .set("Authorization", "Bearer " + token())
            .attach("photo", Buffer.from([0x00]), {filename: "tiny.heic", contentType: "image/heic"});

        sharp.format.heif = originalHeif;

        expect(res.statusCode).toBe(415);
        expect(res.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");

        const after = fs.readdirSync(uploadsDir);
        const newFiles = after.filter((f) => !before.has(f));
        expect(newFiles).toHaveLength(0);
    });

    test("tiff uploads are converted to jpeg", async () => {
        const buffer = await sharp({
            create: {width: 1, height: 1, channels: 3, background: {r: 255, g: 0, b: 0}}
        })
            .tiff()
            .toBuffer();

        const res = await request(app)
            .post("/api/v1/uploads/photo")
            .set("Authorization", "Bearer " + token())
            .attach("photo", buffer, {filename: "tiny.tiff", contentType: "image/tiff"});

        expect(res.statusCode).toBe(200);
        expect(res.body.imageUrl).toMatch(/\.jpg$/);

        const saved = path.join(__dirname, "..", "public", res.body.imageUrl);
        expect(fs.existsSync(saved)).toBe(true);
        const metadata = await sharp(saved).metadata();
        expect(metadata.format).toBe("jpeg");

        fs.unlinkSync(saved);
    });

    test("failed job refunds token exactly once via webhook", async () => {
        const created = await request(app)
            .post("/api/v1/jobs")
            .set("Authorization", "Bearer " + token())
            .send({imageUrl: "/uploads/photos/x.jpg", emotionCode: "blink"});

        expect(created.statusCode).toBe(200);
        const jobId = created.body.jobId;

        const hook = await request(app)
            .post(`/api/v1/genapi/webhook?secret=change_me&jobId=${jobId}`)
            .send({status: "failed", error: "test fail"});

        expect(hook.statusCode).toBe(200);

        const db = getDb();
        const u = await db("users").where({id: "u1"}).first();
        expect(u.token_balance).toBe(1);

        // webhook retry should NOT double refund
        await request(app)
            .post(`/api/v1/genapi/webhook?secret=change_me&jobId=${jobId}`)
            .send({status: "failed", error: "test fail again"});

        const u2 = await db("users").where({id: "u1"}).first();
        expect(u2.token_balance).toBe(1);
    });

    test("creating job decrements token and then blocks when 0", async () => {
        const ok = await request(app)
            .post("/api/v1/jobs")
            .set("Authorization", "Bearer " + token())
            .send({imageUrl: "/uploads/photos/x.jpg", emotionCode: "blink"});
        expect(ok.statusCode).toBe(200);

        const no = await request(app)
            .post("/api/v1/jobs")
            .set("Authorization", "Bearer " + token())
            .send({imageUrl: "/uploads/photos/x.jpg", emotionCode: "blink"});
        expect(no.statusCode).toBe(402);
        expect(no.body.error.code).toBe("INSUFFICIENT_TOKENS");
    });
});
