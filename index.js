const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

// Allow your frontend to talk to this backend
app.use(cors());

// Database Connection
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

// A simple route so your frontend can test the connection
app.get('/', (req, res) => {
  res.send('✅ Backend is live and connected to the database!');
});

// Start the server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Diagnostic check
console.log("Checking connection to:", process.env.DATABASE_URL ? "URL Found" : "URL NOT FOUND");