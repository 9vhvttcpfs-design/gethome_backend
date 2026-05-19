const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("⚠️ System Alert: Missing Supabase Environment Variables!");
}

const supabase = createClient(supabaseUrl, supabaseKey);

app.get('/', (req, res) => {
  res.send("✅ GetHome Backend is officially LIVE and talking to the Frontend!");
});

// FETCH ALL PROPERTIES WITH TRANSPARENT MOVE-IN BREAKDOWNS
app.get('/api/properties', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('properties')
      .select('*')
      .order('id', { ascending: false });

    if (error) throw error;

    // Map through properties and dynamically compute totals so agents can't hide fees
    const transparentProperties = data.map(property => {
      const rent = parseFloat(property.rent) || 0;
      const agency = parseFloat(property.agency_fee) || 0;
      const agreement = parseFloat(property.agreement_fee) || 0;
      const caution = parseFloat(property.caution_fee) || 0;
      const serviceCharge = parseFloat(property.service_charge) || 0;
      
      const totalMoveInCost = rent + agency + agreement + caution + serviceCharge;

      return {
        ...property,
        rent,
        agency_fee: agency,
        agreement_fee: agreement,
        caution_fee: caution,
        service_charge: serviceCharge,
        total_payment: totalMoveInCost
      };
    });

    res.json(transparentProperties);
  } catch (err) {
    console.error("Error fetching transparent listings:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/properties', async (req, res) => {
  try {
    const { title, location, price, image_url } = req.body;

    if (!title || !location || !price) {
      return res.status(400).json({ error: "Required elements missing." });
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

app.listen(PORT, () => {
  console.log(`🚀 Server processing operations smoothly on port ${PORT}`);
});