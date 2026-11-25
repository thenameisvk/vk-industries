'use strict';
/* Regression test for the admin dashboard numbers.
   Drives the REAL Express route + loan maths + cache; only the database calls are
   replaced by a tiny in-memory stand-in, so no MongoDB is needed.            */
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = 'mongodb://127.0.0.1:1/never-connects';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.ADMIN_SECRET_KEY = 'TESTADMIN1';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('./server');
const cache = require('./utils/cache');
const Cash = require('./models/Cash');
const User = require('./models/User');
const M = require('./loanMath');

const ADMIN = `Bearer ${jwt.sign({ sub: 'admin', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
const R = M.toPaise;
const now = new Date();
const today = M.istDay(now);
const todayISO = M.istParts(now).date;
const monthKey = todayISO.slice(0, 7);

const mkLoan = ({ principal, interest, inst = 2000, startAgo, pays = [] }) => ({
  principal: R(principal), interest: R(interest), schedule: 'Weekly', installment: R(inst),
  startDate: M.dayToDate(today - startAgo), endDate: M.dayToDate(today - startAgo + 110),
  payments: pays.map(([ago, amt]) => ({ amount: R(amt), at: M.istInstant(M.dayToISO(today - ago), '00:00') })),
});

let docs;
let reads;
const resetDb = () => {
  docs = [
    mkLoan({ principal: 24000, interest: 2400, startAgo: 20, pays: [[13, 2000], [6, 2000], [0, 2000]] }),
    mkLoan({ principal: 10000, interest: 1000, startAgo: 3, pays: [[0, 1000]] }),
    mkLoan({ principal: 5000, interest: 500, startAgo: -5 }),                    // starts in 5 days → not given yet
  ];
  reads = 0;
  cache.clear();
};
Cash.find = () => ({ select: () => ({ lean: async () => { reads += 1; return docs; } }) });
User.countDocuments = async (f) => (!f ? 4 : f.joined && f.joined.$lt ? 1 : 2);

const get = (url) => request(app).get(url).set('Authorization', ADMIN);

test('overview returns every card figure (given, revenue, outstanding, today)', async () => {
  resetDb();
  const r = await get('/api/dashboard/overview');
  assert.equal(r.status, 200);
  assert.ok(r.body && typeof r.body === 'object', 'body must not be empty');
  assert.equal(r.body.given.value, 34000);                  // 24 000 + 10 000 (future entry excluded)
  assert.equal(r.body.revenue.value, 7000);                 // 2000 × 3 + 1000
  assert.equal(r.body.today.collected, 3000);               // 2000 + 1000 paid today
  assert.equal(r.body.balance.value, 28700);                // (25 200 − 6 000) + (10 500 − 1 000)
  assert.equal(r.body.users.value, 4);
  assert.equal(r.body.date, todayISO);
  assert.deepEqual(r.body.statusMix, { completed: 0, active: 3, dueSoon: 0, overdue: 0 });
});

test('daily chart: one bar per day up to today, amounts on the right days', async () => {
  resetDb();
  const r = await get('/api/dashboard/chart?range=month');
  assert.equal(r.status, 200);
  const dayOfMonth = Number(todayISO.slice(8, 10));
  assert.equal(r.body.labels.length, dayOfMonth);
  assert.equal(r.body.unit, 'day');
  assert.equal(r.body.collected.length, dayOfMonth);
  assert.equal(r.body.collected[dayOfMonth - 1], 3000);     // today's bar

  // expected totals for THIS month, worked out independently of the route
  let expCollected = 0; let expGiven = 0;
  docs.forEach((d) => {
    d.payments.forEach((p) => { if (M.istParts(p.at).date.startsWith(monthKey)) expCollected += p.amount; });
    const sd = M.dayToISO(M.storedDay(d.startDate));
    if (sd.startsWith(monthKey) && sd <= todayISO) expGiven += d.principal;
  });
  const sum = (a) => a.reduce((s, v) => s + Math.round(v * 100), 0);
  assert.equal(sum(r.body.collected), expCollected);
  assert.equal(sum(r.body.given), expGiven);
});

test('quarter and year charts still work', async () => {
  resetDb();
  const q = await get('/api/dashboard/chart?range=quarter');
  assert.equal(q.body.labels.length, 3);
  const y = await get('/api/dashboard/chart?range=year');
  assert.equal(y.body.labels.length, 12);
  assert.equal(y.body.unit, 'month');
});

test('LIVE: cached for a few seconds, instantly fresh after cache.clear() (admin writes do this)', async () => {
  resetDb();
  const first = await get('/api/dashboard/overview');
  assert.equal(first.body.revenue.value, 7000);

  docs[1].payments.push({ amount: R(500), at: new Date() });          // a payment is recorded…
  const cached = await get('/api/dashboard/overview');
  assert.equal(cached.body.revenue.value, 7000, 'served from cache inside the 10 s window');
  assert.equal(reads, 1, 'database read only once');

  cache.clear();                                                      // …settings.js does this after every write
  const fresh = await get('/api/dashboard/overview');
  assert.equal(fresh.body.revenue.value, 7500);
  assert.equal(fresh.body.today.collected, 3500);
  assert.equal(fresh.body.balance.value, 28200);
});

test('concurrent requests share one database read', async () => {
  resetDb();
  const [a, b, c] = await Promise.all([get('/api/dashboard/overview'), get('/api/dashboard/overview'), get('/api/dashboard/overview')]);
  assert.deepEqual(a.body, b.body);
  assert.deepEqual(b.body, c.body);
  assert.equal(reads, 1);
});

test('cache.remember accepts both call styles and never returns undefined', async () => {
  cache.clear();
  assert.deepEqual(await cache.remember('a', async () => ({ ok: 1 })), { ok: 1 });          // old: (key, producer)
  assert.deepEqual(await cache.remember('b', 5000, async () => ({ ok: 2 })), { ok: 2 });    // new: (key, ttl, producer)
  let calls = 0;
  const empty = async () => { calls += 1; return undefined; };
  await cache.remember('c', 5000, empty); await cache.remember('c', 5000, empty);
  assert.equal(calls, 2, 'an empty result is never cached');
});

test('dashboard endpoints stay admin-only', async () => {
  assert.equal((await request(app).get('/api/dashboard/overview')).status, 401);
});
