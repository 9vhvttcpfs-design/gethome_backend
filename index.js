const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

// Allow your frontend to talk to this backend
app.use(cors());

// Database Connection
// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.connect((err) => {
  if (err) {
    console.error('❌ Database connection failed:', err.stack);
  } else {
    console.log('✅ Connected to GetHome Database');
  }
});

// Start the server
const PORT = process.env.PORT || 10000;
// This tells the server what to show when you visit the URL
app.get('/', (req, res) => {
  res.send('✅ GetHome Backend is officially LIVE and talking to the Frontend!');
});

// This route sends the houses to your frontend
app.get('/api/properties', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM properties');
    res.json(result.rows);
  } catch (err) {
    console.error("Database error:", err.message);
    res.status(500).send('Server Error');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Diagnostic check
console.log("Checking connection to:", process.env.DATABASE_URL ? "URL Found" : "URL NOT FOUND");


