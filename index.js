import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-client';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Enable cross-origin requests and JSON parser body extensions
app.use(cors());
app.use(express.json());

// Initialize the official Supabase Client using your environment keys
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("⚠️ System Alert: Missing Supabase Environment Variables!");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// 🌐 ROUTE 1: Simple Gateway Verification Check
app.get('/', (req, res) => {
  res.send("✅ GetHome Backend is officially LIVE and talking to the Frontend!");
});

// 🌐 ROUTE 2: Fetch listings from your database table (GET)
app.get('/api/properties', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('properties')
      .select('*')
      .order('id', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Error fetching properties:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 🌐 ROUTE 3: Add a brand new listing permanent row (POST)
app.post('/api/properties', async (req, res) => {
  try {
    const { title, location, price, image_url } = req.body;

    if (!title || !location || !price) {
      return res.status(400).json({ error: "Required elements (title, location, price) are missing." });
    }

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
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    console.error("Error saving property row:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Spin up the listener instance
app.listen(PORT, () => {
  console.log(`🚀 Server processing operations smoothly on port ${PORT}`);
});