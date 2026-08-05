const express = require('express');
const router  = express.Router();

const MAX        = parseInt(process.env.MAX_CONTACTS) || 500;
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '554488138425').replace(/\D/g, '');

function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token || '';
  const clean = normalizePhone(token);
  if (clean === ADMIN_PHONE) return next();
  return res.status(401).json({ error: 'UNAUTHORIZED' });
}

// Get DB pool from app
function getDb(req) {
  return req.app.get('db');
}

// ──────────────────────────────────────────────
// STATUS
// ──────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const db = getDb(req);
    const result = await db.query('SELECT COUNT(*) as count FROM contacts');
    const count = parseInt(result.rows[0].count);
    res.json({ count, max: MAX, full: count >= MAX, slotsLeft: Math.max(0, MAX - count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────
// REGISTER
// ──────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const db = getDb(req);
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'MISSING_FIELDS' });

    const normalized = normalizePhone(phone);
    const isAdmin = normalized === ADMIN_PHONE;

    // Check if phone already exists
    const existCheck = await db.query(
      'SELECT id FROM contacts WHERE phone_norm = $1',
      [normalized]
    );
    if (existCheck.rows.length > 0) {
      return res.status(409).json({ error: 'DUPLICATE_PHONE' });
    }

    // Insert
    await db.query(
      `INSERT INTO contacts (name, phone, phone_norm, is_admin)
       VALUES ($1, $2, $3, $4)`,
      [name.trim(), phone.trim(), normalized, isAdmin]
    );

    // Get new count
    const countResult = await db.query('SELECT COUNT(*) as count FROM contacts');
    const newCount = parseInt(countResult.rows[0].count);
    const listFull = newCount >= MAX;

    res.status(201).json({
      success: true,
      count: newCount,
      full: listFull,
      isAdmin,
    });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(409).json({ error: 'DUPLICATE_PHONE' });
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────
// DOWNLOAD (public)
// ──────────────────────────────────────────────
router.get('/download', async (req, res) => {
  try {
    const db = getDb(req);

    // Check if full
    const countResult = await db.query('SELECT COUNT(*) as count FROM contacts');
    const count = parseInt(countResult.rows[0].count);
    if (count < MAX) {
      return res.status(403).json({ error: 'NOT_READY', count, max: MAX });
    }

    const rawPhone = String(req.query.phone || '').replace(/\D/g, '');
    const rawName  = String(req.query.name  || '').trim().toLowerCase();

    if (!rawPhone && !rawName) {
      return res.status(401).json({ error: 'VERIFY_REQUIRED' });
    }

    // Find contact
    let contact = null;
    if (rawPhone) {
      const result = await db.query(
        'SELECT id FROM contacts WHERE phone_norm = $1',
        [rawPhone]
      );
      if (result.rows.length > 0) contact = result.rows[0];
    }
    if (!contact && rawName) {
      const result = await db.query(
        'SELECT id FROM contacts WHERE LOWER(name) = $1',
        [rawName]
      );
      if (result.rows.length > 0) contact = result.rows[0];
    }

    if (!contact) {
      return res.status(403).json({ error: 'NOT_REGISTERED' });
    }

    // Get all contacts
    const allResult = await db.query(
      'SELECT name, phone FROM contacts ORDER BY id'
    );
    const contacts = allResult.rows;

    const vcf = contacts.map(c =>
      `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${c.name}\r\nTEL;TYPE=CELL:${c.phone}\r\nEND:VCARD`
    ).join('\r\n\r\n');

    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="T3RRI_contacts.vcf"');
    res.send(vcf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────
// CHECK ADMIN
// ──────────────────────────────────────────────
router.post('/check-admin', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'MISSING_FIELDS' });
  const clean = normalizePhone(phone);
  if (clean !== ADMIN_PHONE) return res.status(403).json({ error: 'NOT_ADMIN' });

  try {
    const db = getDb(req);
    const result = await db.query(
      'SELECT id FROM contacts WHERE phone_norm = $1',
      [clean]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'NOT_REGISTERED' });
    }
    res.json({ success: true, token: ADMIN_PHONE });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────
// ADMIN: GET ALL CONTACTS
// ──────────────────────────────────────────────
router.get('/admin/contacts', requireAdmin, async (req, res) => {
  try {
    const db = getDb(req);
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const search = req.query.search || '';

    let query = 'SELECT id, name, phone, is_admin, registered_at FROM contacts';
    let params = [];
    let where = '';

    if (search) {
      where = ' WHERE name ILIKE $1 OR phone ILIKE $1';
      params.push(`%${search}%`);
    }

    const countQuery = `SELECT COUNT(*) as total FROM contacts${where}`;
    const countResult = await db.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    const offset = (page - 1) * limit;
    params.push(limit, offset);

    const dataQuery = `${query}${where} ORDER BY registered_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const dataResult = await db.query(dataQuery, params);

    const contacts = dataResult.rows.map(row => ({
      ...row,
      isAdmin: row.is_admin,
      registeredAt: row.registered_at,
    }));

    res.json({
      contacts,
      total,
      page,
      pages: Math.ceil(total / limit),
      max: MAX,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────
// ADMIN: DELETE SINGLE CONTACT
// ──────────────────────────────────────────────
router.delete('/admin/contacts/:id', requireAdmin, async (req, res) => {
  try {
    const db = getDb(req);
    await db.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
    const result = await db.query('SELECT COUNT(*) as count FROM contacts');
    res.json({ success: true, count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────
// ADMIN: DOWNLOAD ALL
// ──────────────────────────────────────────────
router.get('/admin/download', requireAdmin, async (req, res) => {
  try {
    const db = getDb(req);
    const result = await db.query('SELECT name, phone FROM contacts ORDER BY id');
    const contacts = result.rows;

    const vcf = contacts.map(c =>
      `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${c.name}\r\nTEL;TYPE=CELL:${c.phone}\r\nEND:VCARD`
    ).join('\r\n\r\n');

    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="T3RRI_admin_contacts.vcf"');
    res.send(vcf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────
// ADMIN: DELETE ALL
// ──────────────────────────────────────────────
router.delete('/admin/contacts-all', requireAdmin, async (req, res) => {
  try {
    const db = getDb(req);
    await db.query('DELETE FROM contacts');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
