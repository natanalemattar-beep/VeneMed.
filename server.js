// VeneMed - Sistema de Salud Soberano v2.1
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL_NON_POOLING,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pacientes (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        apellido TEXT NOT NULL,
        cedula TEXT UNIQUE NOT NULL,
        fecha_nacimiento TEXT,
        direccion TEXT,
        telefono TEXT,
        email TEXT,
        historial_medico TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS recetas (
        id SERIAL PRIMARY KEY,
        paciente_id INTEGER NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
        medicamento TEXT NOT NULL,
        dosis TEXT NOT NULL,
        frecuencia TEXT NOT NULL,
        duracion TEXT,
        fecha_emision TIMESTAMPTZ DEFAULT NOW(),
        doctor TEXT,
        notas TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('Base de datos inicializada correctamente');
  } finally {
    client.release();
  }
}

let tokenValido = null;

function authMiddleware(req, res, next) {
  if (!tokenValido) return res.status(401).json({ error: 'No hay sesión activa. Use POST /auth/login' });
  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${tokenValido}`) {
    return res.status(401).json({ error: 'Token inválido o ausente' });
  }
  next();
}

app.post('/auth/login', (req, res) => {
  const { usuario, clave } = req.body;
  if (usuario === 'admin' && clave === 'admin123') {
    tokenValido = crypto.randomBytes(20).toString('hex');
    return res.json({ token: tokenValido, mensaje: 'Autenticación exitosa' });
  }
  res.status(401).json({ error: 'Credenciales inválidas' });
});

app.post('/auth/logout', (req, res) => {
  tokenValido = null;
  res.json({ mensaje: 'Sesión cerrada' });
});

app.get('/pacientes', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM pacientes ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/pacientes/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM pacientes WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Paciente no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/pacientes', authMiddleware, async (req, res) => {
  const { nombre, apellido, cedula, fecha_nacimiento, direccion, telefono, email, historial_medico } = req.body;
  if (!nombre || !apellido || !cedula) {
    return res.status(400).json({ error: 'nombre, apellido y cedula son obligatorios' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO pacientes (nombre, apellido, cedula, fecha_nacimiento, direccion, telefono, email, historial_medico)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [nombre, apellido, cedula, fecha_nacimiento || null, direccion || null, telefono || null, email || null, historial_medico || null]
    );
    res.status(201).json({ id: result.rows[0].id, mensaje: 'Paciente creado' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'La cédula ya existe' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/pacientes/:id', authMiddleware, async (req, res) => {
  const { nombre, apellido, cedula, fecha_nacimiento, direccion, telefono, email, historial_medico } = req.body;
  try {
    const result = await pool.query(
      `UPDATE pacientes SET nombre=$1, apellido=$2, cedula=$3, fecha_nacimiento=$4, direccion=$5, telefono=$6, email=$7, historial_medico=$8, updated_at=NOW() WHERE id=$9 RETURNING id`,
      [nombre, apellido, cedula, fecha_nacimiento, direccion, telefono, email, historial_medico, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Paciente no encontrado' });
    res.json({ mensaje: 'Paciente actualizado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/pacientes/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM pacientes WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Paciente no encontrado' });
    res.json({ mensaje: 'Paciente eliminado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/pacientes/:id/recetas', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM recetas WHERE paciente_id = $1 ORDER BY fecha_emision DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/recetas', authMiddleware, async (req, res) => {
  const { paciente_id, medicamento, dosis, frequencia, duracion, doctor, notas } = req.body;
  const frecuencia = req.body.frecuencia || frequencia;
  if (!paciente_id || !medicamento || !dosis || !frecuencia) {
    return res.status(400).json({ error: 'paciente_id, medicamento, dosis y frecuencia son obligatorios' });
  }
  try {
    const p = await pool.query('SELECT id FROM pacientes WHERE id = $1', [paciente_id]);
    if (p.rows.length === 0) return res.status(404).json({ error: 'Paciente no encontrado' });
    const result = await pool.query(
      `INSERT INTO recetas (paciente_id, medicamento, dosis, frecuencia, duracion, doctor, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [paciente_id, medicamento, dosis, frecuencia, duracion || null, doctor || null, notas || null]
    );
    res.status(201).json({ id: result.rows[0].id, mensaje: 'Receta creada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/recetas/:id', authMiddleware, async (req, res) => {
  const { medicamento, dosis, frequencia, duracion, doctor, notas } = req.body;
  const frecuencia = req.body.frecuencia || frequencia;
  try {
    const result = await pool.query(
      `UPDATE recetas SET medicamento=$1, dosis=$2, frecuencia=$3, duracion=$4, doctor=$5, notas=$6, updated_at=NOW() WHERE id=$7 RETURNING id`,
      [medicamento, dosis, frecuencia, duracion, doctor, notas, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Receta no encontrada' });
    res.json({ mensaje: 'Receta actualizada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/recetas/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM recetas WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Receta no encontrada' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/recetas/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM recetas WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Receta no encontrada' });
    res.json({ mensaje: 'Receta eliminada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

initDB().then(() => {
  if (process.env.VERCEL !== '1') {
    app.listen(PORT, () => {
      console.log(`VeneMed corriendo en http://localhost:${PORT} (Supabase)`);
    });
  }
}).catch(err => {
  console.error('Error inicializando DB:', err.message);
  if (process.env.VERCEL !== '1') process.exit(1);
});

module.exports = app;
