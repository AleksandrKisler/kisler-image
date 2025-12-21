const request = require("supertest");
const fs = require("fs");
const jwt = require("jsonwebtoken");

process.env.JWT_ACCESS_SECRET = "test_secret";
process.env.JWT_ACCESS_TTL = "15m";
process.env.SQLITE_FILE = "./.testdata/test.sqlite";
process.env.MAILER_MODE = "dev";
process.env.GENAPI_API_KEY = "dummy";

const { app } = require("../src/app");
const { migrate } = require("../src/db/migrate");
const { getDb } = require("../src/db");

function token() {
  return jwt.sign({ sub: "u1", email: "user@example.com" }, process.env.JWT_ACCESS_SECRET, { expiresIn: "15m" });
}

beforeAll(async () => {
  fs.mkdirSync("./.testdata", { recursive: true });
  if (fs.existsSync(process.env.SQLITE_FILE)) fs.unlinkSync(process.env.SQLITE_FILE);
  await migrate();
  const db = getDb();
  await db("users").insert({
    id: "u1",
    email: "user@example.com",
    password_hash: null,
    token_balance: 2,
    created_at: new Date().toISOString()
  });
});

describe("jobs", () => {
  test("create job requires auth", async () => {
    const res = await request(app).post("/api/v1/jobs").send({ imageUrl: "x", emotionCode: "blink" });
    expect(res.statusCode).toBe(401);
  });

  test("create and list jobs", async () => {
    const res = await request(app)
      .post("/api/v1/jobs")
      .set("Authorization", "Bearer " + token())
      .send({ imageUrl: "https://example.com/a.jpg", emotionCode: "blink" });
    expect(res.statusCode).toBe(200);
    expect(res.body.jobId).toBeTruthy();
    expect(res.body.status).toBe("queued");

    const list = await request(app)
      .get("/api/v1/jobs")
      .set("Authorization", "Bearer " + token());
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);
    expect(list.body.items.length).toBeGreaterThanOrEqual(1);
  });
});
