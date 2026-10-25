require("./helpers/env");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { init } = require("../src/db/init");
const app = require("../src/app");

let server, base, admin, created = {};

async function api(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, type: res.headers.get("content-type") || "" };
}

const uniq = Date.now().toString().slice(-7);
const phone = "0669" + uniq;

test.before(async () => {
  await init();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await api("POST", "/api/auth/login", {
    username: "admin",
    password: process.env.DEFAULT_ADMIN_PASSWORD,
  });
  assert.equal(res.status, 200);
  admin = res.data.token;
});

test.after(async () => {
  if (created.repair) await api("DELETE", `/api/repairs/${created.repair}`, undefined, admin);
  if (created.worker) await api("DELETE", `/api/users/${created.worker}`, undefined, admin);
  await new Promise((r) => server.close(r));
  const { pool } = require("../src/db/pool");
  await pool.end();
});

test("admin can log in and read the dashboard", async () => {
  const res = await api("GET", "/api/dashboard", undefined, admin);
  assert.equal(res.status, 200);
  assert.ok(res.data.stats);
});

test("repair create, partial edit, overpayment guard and parts", async () => {
  const create = await api("POST", "/api/repairs", {
    customerName: "Test Customer " + uniq,
    phone,
    brand: "Samsung",
    model: "A54",
    color: "أسود",
    power: "🟢 يعمل",
    price: 1000,
    paid: 100,
    partCost: 100,
    fault: "شاشة",
  }, admin);
  assert.equal(create.status, 201);
  assert.match(create.data.tracking_code, /^QF-\d+$/);
  created.repair = create.data.id;

  // Partial PATCH must not erase the other fields.
  const edit = await api("PATCH", `/api/repairs/${created.repair}`, { price: 1200 }, admin);
  assert.equal(edit.status, 200);
  const detail = await api("GET", `/api/repairs/${created.repair}`, undefined, admin);
  assert.equal(detail.data.brand, "Samsung");
  assert.equal(Number(detail.data.expected_price), 1200);

  // Paying more than the remaining amount is rejected.
  const over = await api("POST", `/api/repairs/${created.repair}/payments`, { amount: 5000 }, admin);
  assert.equal(over.status, 400);

  // Parts add and remove keep part_cost in sync.
  const part = await api("POST", `/api/repairs/${created.repair}/parts`, {
    name: "شاشة", quantity: 2, unitCost: 300, salePrice: 500,
  }, admin);
  assert.equal(part.status, 201);
  const list = await api("GET", `/api/repairs/${created.repair}/parts`, undefined, admin);
  assert.equal(list.data.length, 1);
  const del = await api("DELETE", `/api/repairs/${created.repair}/parts/${list.data[0].id}`, undefined, admin);
  assert.equal(del.status, 200);
  const after = await api("GET", `/api/repairs/${created.repair}`, undefined, admin);
  assert.equal(Number(after.data.part_cost), 100);
});

test("renaming a customer updates in place and never creates a duplicate", async () => {
  const res = await api("PATCH", `/api/repairs/${created.repair}`, {
    customerName: "Renamed Customer " + uniq,
  }, admin);
  assert.equal(res.status, 200);
  const customers = await api("GET", "/api/customers", undefined, admin);
  assert.equal(customers.status, 200);
  const matches = customers.data.filter((c) => c.phone === phone);
  assert.equal(matches.length, 1, "one customer per phone");
  assert.equal(matches[0].name, "Renamed Customer " + uniq);
});

test("supplier purchase rejects paid > total", async () => {
  const bad = await api("POST", "/api/suppliers/purchases", {
    supplier: "MONTEL",
    items: [{ type: "BAT", variant: "", model: "", qty: 2, unitPrice: 100 }],
    paid: 500,
  }, admin);
  assert.equal(bad.status, 400);
});

test("unknown API path returns JSON 404", async () => {
  const res = await api("GET", "/api/definitely-not-a-route", undefined, admin);
  assert.equal(res.status, 404);
  assert.match(res.type, /application\/json/);
});

test("worker cannot see finance and loses access when disabled", async () => {
  const create = await api("POST", "/api/users", {
    username: "worker_" + uniq,
    fullName: "Worker",
    password: "Worker@123",
    permissions: { view_repairs: true },
  }, admin);
  assert.equal(create.status, 201);
  created.worker = create.data.id;

  const login = await api("POST", "/api/auth/login", { username: "worker_" + uniq, password: "Worker@123" });
  assert.equal(login.status, 200);
  const token = login.data.token;

  const dash = await api("GET", "/api/dashboard", undefined, token);
  assert.equal(dash.status, 200);
  assert.equal("revenue" in dash.data.stats, false);
  assert.equal("remaining" in dash.data.stats, false);

  const users = await api("GET", "/api/users", undefined, token);
  assert.equal(users.status, 403);

  await api("PATCH", `/api/users/${created.worker}`, { active: false }, admin);
  const me = await api("GET", "/api/auth/me", undefined, token);
  assert.equal(me.status, 401);
});

test("print uses the iframe helper (no popup window)", () => {
  const html = fs.readFileSync("public/index.html", "utf8");
  assert.match(html, /function printHtml/);
  assert.doesNotMatch(html, /window\.open\('','_blank','width=520/);
});
