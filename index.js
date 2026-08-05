const express   = require('express');
const { Pool }  = require('pg');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { error: 'TOO_MANY_REQUESTS' },
  standardHeaders: true, legacyHeaders: false,
});
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { error: 'TOO_MANY_REQUESTS' },
});

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Make pool available to routes
app.set('db', pool);

const contactRoutes = require('./routes/contacts');
app.use('/api/register', registerLimiter);
app.use('/api/download', downloadLimiter);
app.use('/api', contactRoutes);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize database
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        name VARCHAR(60) NOT NULL,
        phone VARCHAR(25) NOT NULL,
        phone_norm VARCHAR(20) UNIQUE NOT NULL,
        is_admin BOOLEAN DEFAULT FALSE,
        registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_phone_norm ON contacts(phone_norm);
      CREATE INDEX IF NOT EXISTS idx_name ON contacts(name);
    `);
    console.log('✅ PostgreSQL tables ready');
  } catch (err) {
    console.error('❌ Database init failed:', err.message);
    throw err;
  }
}

// Connect and start server
async function startServer() {
  try {
    await pool.connect();
    console.log('✅ PostgreSQL connected');
    await initDatabase();
    app.listen(PORT, () => console.log(`🚀 T3RRI server on port ${PORT}`));
  } catch (err) {
    console.error('❌ PostgreSQL failed:', err.message);
    process.exit(1);
  }
}

startServer();
