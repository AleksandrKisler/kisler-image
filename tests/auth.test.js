const request = require("supertest");
const fs = require("fs");

process.env.JWT_ACCESS_SECRET = "test_secret";
process.env.JWT_ACCESS_TTL = "15m";
process.env.SQLITE_FILE = "./.testdata/test.sqlite";
process.env.MAILER_MODE = "dev";
process.env.GENAPI_API_KEY = "dummy";

const { app } = require("../src/app");
const { migrate } = require("../src/db/migrate");

beforeAll(async () => {
  fs.mkdirSync("./.testdata", { recursive: true });
  if (fs.existsSync(process.env.SQLITE_FILE)) fs.unlinkSync(process.env.SQLITE_FILE);
  await migrate();
});

describe("auth", () => {
  test("request-code validates email", async () => {
    const res = await request(app).post("/api/v1/auth/request-code").send({ email: "" });
    expect(res.statusCode).toBe(400);
  });
});
