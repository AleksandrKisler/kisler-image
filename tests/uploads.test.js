const request = require("supertest");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const path = require("path");

process.env.JWT_ACCESS_SECRET = "test_secret";
process.env.JWT_ACCESS_TTL = "15m";
process.env.SQLITE_FILE = "./.testdata/test.sqlite";
process.env.MAILER_MODE = "dev";
process.env.GENAPI_API_KEY = "dummy";
process.env.UPLOAD_MAX_BYTES = "8000000";
process.env.UPLOAD_ALLOWED_MIME = "image/jpeg,image/png,image/webp";

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
