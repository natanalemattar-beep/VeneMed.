process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL_NON_POOLING,
});

async function initDB() {
  try {
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
          password TEXT,
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
  } catch (err) {
    console.error('Error crítico en initDB:', err.message);
  }
}

// Gestión de sesiones: token -> { id, role }
const sesiones = new Map();

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Token ausente' });
  
  const token = authHeader.split(' ')[1];
  const session = sesiones.get(token);
  
  if (!session) return res.status(401).json({ error: 'Sesión inválida o expirada' });
  
  req.user = session;
  next();
}

app.post('/auth/login', async (req, res) => {
  const { usuario, clave } = req.body;
  
  // Login Admin/Doctor
  if (usuario === 'admin' && clave === 'admin123') {
    const token = crypto.randomBytes(20).toString('hex');
    sesiones.set(token, { id: 0, role: 'doctor' });
    return res.json({ token, role: 'doctor', mensaje: 'Bienvenido Doctor' });
  }
  
  // Login Paciente (usando cédula como usuario)
  try {
    const result = await pool.query(
      'SELECT id, nombre, apellido FROM pacientes WHERE cedula = $1 AND password = $2',
      [usuario, clave]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Cédula o contraseña incorrecta' });
    }
    
    const paciente = result.rows[0];
    const token = crypto.randomBytes(20).toString('hex');
    sesiones.set(token, { id: paciente.id, role: 'paciente', nombre: `${paciente.nombre} ${paciente.apellido}` });
    
    return res.json({ token, role: 'paciente', nombre: paciente.nombre, mensaje: `Bienvenido ${paciente.nombre}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/logout', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const token = authHeader.split(' ')[1];
    sesiones.delete(token);
  }
  res.json({ mensaje: 'Sesión cerrada' });
});

app.get('/pacientes', authMiddleware, async (req, res) => {
  try {
    if (req.user.role === 'doctor') {
      const result = await pool.query('SELECT id, nombre, apellido, cedula, telefono FROM pacientes ORDER BY created_at DESC');
      res.json(result.rows);
    } else {
      // Paciente solo puede verse a sí mismo
      const result = await pool.query('SELECT * FROM pacientes WHERE id = $1', [req.user.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Paciente no encontrado' });
      res.json(result.rows);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/pacientes/:id', authMiddleware, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (req.user.role === 'doctor' || (req.user.role === 'paciente' && req.user.id === targetId)) {
      const result = await pool.query('SELECT * FROM pacientes WHERE id = $1', [targetId]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Paciente no encontrado' });
      res.json(result.rows[0]);
    } else {
      res.status(403).json({ error: 'No tienes permiso para ver este paciente' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/pacientes', authMiddleware, async (req, res) => {
  if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Solo los doctores pueden registrar pacientes' });
  
  const { nombre, apellido, cedula, fecha_nacimiento, direccion, telefono, email, password, historial_medico } = req.body;
  if (!nombre || !apellido || !cedula) {
    return res.status(400).json({ error: 'nombre, apellido y cedula son obligatorios' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO pacientes (nombre, apellido, cedula, fecha_nacimiento, direccion, telefono, email, password, historial_medico)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [nombre, apellido, cedula, fecha_nacimiento || null, direccion || null, telefono || null, email || null, password || '123456', historial_medico || null]
    );
    res.status(201).json({ id: result.rows[0].id, mensaje: 'Paciente creado' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'La cédula ya existe' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/pacientes/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Solo los doctores pueden editar pacientes' });
  
  const { nombre, apellido, cedula, fecha_nacimiento, direccion, telefono, email, password, historial_medico } = req.body;
  try {
    const result = await pool.query(
      `UPDATE pacientes SET nombre=$1, apellido=$2, cedula=$3, fecha_nacimiento=$4, direccion=$5, telefono=$6, email=$7, password=$8, historial_medico=$9, updated_at=NOW() WHERE id=$10 RETURNING id`,
      [nombre, apellido, cedula, fecha_nacimiento, direccion, telefono, email, password, historial_medico, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Paciente no encontrado' });
    res.json({ mensaje: 'Paciente actualizado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/pacientes/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Solo los doctores pueden eliminar pacientes' });
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
    const targetId = parseInt(req.params.id);
    if (req.user.role === 'doctor' || (req.user.role === 'paciente' && req.user.id === targetId)) {
      const result = await pool.query(
        'SELECT * FROM recetas WHERE paciente_id = $1 ORDER BY fecha_emision DESC',
        [targetId]
      );
      res.json(result.rows);
    } else {
      res.status(403).json({ error: 'No tienes permiso para ver estas recetas' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/recetas', authMiddleware, async (req, res) => {
  if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Solo los doctores pueden crear recetas' });
  
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
  if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Solo los doctores pueden editar recetas' });
  
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

app.delete('/recetas/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Solo los doctores pueden eliminar recetas' });
  try {
    const result = await pool.query('DELETE FROM recetas WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Receta no encontrada' });
    res.json({ mensaje: 'Receta eliminada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/recetas/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM recetas WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Receta no encontrada' });
    const receta = result.rows[0];
    if (req.user.role === 'doctor' || (req.user.role === 'paciente' && receta.paciente_id === req.user.id)) {
      res.json(receta);
    } else {
      res.status(403).json({ error: 'No tienes permiso para ver esta receta' });
    }
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
