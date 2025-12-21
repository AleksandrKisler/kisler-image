const request = require("supertest");
const fs = require("fs");
const jwt = require("jsonwebtoken");

process.env.JWT_ACCESS_SECRET = "test_secret";
process.env.JWT_ACCESS_TTL = "15m";
process.env.SQLITE_FILE = "./.testdata/test.sqlite";
process.env.MAILER_MODE = "dev";
process.env.GENAPI_API_KEY = "dummy";
process.env.YOOKASSA_SHOP_ID = "shop";
process.env.YOOKASSA_SECRET_KEY = "secret";
process.env.YOOKASSA_RETURN_URL = "http://localhost:5173/return";
process.env.YOOKASSA_TEST_MODE = "true";

jest.mock("axios", () => {
  const m = {
    create: () => ({
      post: jest.fn(async () => ({
        data: {
          id: "yk_1",
          status: "pending",
          confirmation: { confirmation_url: "https://pay.example/confirm" },
          paid: false
        }
      })),
      get: jest.fn(async () => ({
        data: { id: "yk_1", status: "succeeded", paid: true }
      }))
    })
  };
  return m;
});

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
    token_balance: 0,
    created_at: new Date().toISOString()
  });
});

describe("payments", () => {
  test("create payment returns confirmationUrl", async () => {
    const res = await request(app)
      .post("/api/v1/payments/create")
      .set("Authorization", "Bearer " + token())
      .send({ planId: "one" });

    expect(res.statusCode).toBe(200);
    expect(res.body.confirmationUrl).toBeTruthy();
    expect(res.body.ykPaymentId).toBe("yk_1");
  });
});
