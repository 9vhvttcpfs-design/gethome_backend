const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ⚡ CRITICAL MIDDLEWARE: Add these two lines right here!
app.use(cors());          // Allows frontend to talk to backend
app.use(express.json());  // Allows backend to read incoming form data (req.body)

// ... your supabase initialization and routes continue below ...

// Allow your frontend to talk to this backend
app.use(cors());

// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
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

// Add this route right below your existing GET /api/properties route

app.post('/api/properties', async (req, res) => {
  try {
    const { title, location, price, image_url } = req.body;

    // Basic validation to make sure required fields aren't empty
    if (!title || !location || !price) {
      return res.status(400).json({ error: "Title, location, and price are required." });
    }

    // Insert the data into your Supabase 'properties' table
    const { data, error } = await supabase
      .from('properties')
      .insert([
        { 
          title, 
          location, 
          price: parseFloat(price), 
          image_url: image_url || null 
        }
      ])
      .select(); // Returns the newly created row

    if (error) {
      console.error("Supabase insert error:", error);
      return res.status(500).json({ error: error.message });
    }

    // Send back the newly created property
    res.status(201).json(data[0]);
  } catch (err) {
    console.error("Server error during post:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Diagnostic check
console.log("Checking connection to:", process.env.DATABASE_URL ? "URL Found" : "URL NOT FOUND");

