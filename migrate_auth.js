require('dotenv').config();
const { Pool } = require('pg');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL_NON_POOLING,
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS password TEXT');
    console.log('Columna password agregada correctamente');
  } catch (e) {
    console.error('Error migrando:', e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
