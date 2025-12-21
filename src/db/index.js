require("dotenv").config();
const fs = require("fs");
const path = require("path");
const knex = require("knex");

let db;
function getDb() {
  if (db) return db;
  const file = process.env.SQLITE_FILE || "./data/app.sqlite";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = knex({
    client: "better-sqlite3",
    connection: { filename: file },
    useNullAsDefault: true
  });
  return db;
}
module.exports = { getDb };
