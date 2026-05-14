require('dotenv').config(); // This line reads your .env file
const express = require('express');
const { Pool } = require('pg');

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // This uses the key you just saved
});

pool.connect((err) => {
  if (err) {
    console.error('❌ Database connection failed:', err.stack);
  } else {
    console.log('✅ Connected to GetHome Database');
  }
});

app.listen(5000, () => console.log('🚀 Server running on port 5000'));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

console.log("Checking connection to:", process.env.DATABASE_URL ? "URL Found" : "URL NOT FOUND");