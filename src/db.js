'use strict';
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const config = require('./config');

// BIGINT (id) -> Number; aman untuk id < 2^53.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// DATE -> string 'YYYY-MM-DD' (hindari geser zona waktu)
types.setTypeParser(1082, (v) => v);

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: parseInt(process.env.DATABASE_POOL_MAX || '10', 10),
});

async function q(text, params) {
  return pool.query(text, params);
}
async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}
async function many(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    nama TEXT PRIMARY KEY, dijalankan_pada TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const done = await one('SELECT 1 FROM schema_migrations WHERE nama=$1', [f]);
    if (done) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(724519)');
      const again = await c.query('SELECT 1 FROM schema_migrations WHERE nama=$1', [f]);
      if (again.rowCount) return;
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(nama) VALUES ($1)', [f]);
    });
    console.log(`[migrate] ${f}`);
  }
}

module.exports = { pool, q, one, many, tx, migrate };
