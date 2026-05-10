const express = require('express');
const https = require('https');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = 'imbrige2024';
const WHATSAPP_TOKEN = 'EAANoV7FaoaIBRU9hikEGhTaDO5eSlH42nM83P6EMOeKuoBFZCkEZCuvaX0lxRSHrMl3AtXruFY9KvIreo6wPIBuradJnHdqd6g2yTVVmtKNp1HRut2OvlIfk7gnnK6yiqZAlnCu43vJpmg9WZCvd3drZAzcIcusLQvppBkKnDqbBHmczZARuvUFc8ZAjyfvAyZBM';
const PHONE_NUMBER_ID = '1097591180108358';
const GEMINI_API_KEY = 'AIzaSyBY4VJ-rjmtZHH3nUybvK1HQhmadSJiVws';
const DATABASE_URL = 'postgresql://imbrigeagency_db_user:WRllwMDXjolWAtmDtzvO1v3o2J9PBkFc@dpg-d805dvrtqb8s73fs1dvg-a.virginia-postgres.render.com/imbrigeagency_db';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE,
      current_step TEXT DEFAULT 'ask_budget',
      budget TEXT,
      location TEXT,
      property_type TEXT,
      timeline TEXT,
      intent TEXT,
      lead_score TEXT,
      sales_summary TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function sendMessage(to, message) {
  const body = JSON.stringify({
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { body: message }
  });

  const options = {
    hostname: 'graph.facebook.com',
    path: `/v19.0/${PHONE_NUMBER_ID}/messages`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function scoreLead(lead) {
  const prompt = `You are scoring Indian real estate buyer leads. Based on the data below, return ONLY a JSON object with lead_score as Hot, Warm, or Cold and a one-sentence sales_summary. Data: budget=${lead.budget}, location=${lead.location}, property_type=${lead.property_type}, timeline=${lead.timeline}, intent=${lead.intent}. Return only JSON like: {"lead_score":"Hot","sales_summary":"Buyer wants a 3 BHK in South Bopal within 30 days."}`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }]
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates[0].content.parts[0].text;
          const clean = text.replace(/```json|```/g, '').trim();
          resolve(JSON.parse(clean));
        } catch (e) {
          resolve({ lead_score: 'Warm', sales_summary: 'Unable to score lead.' });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function handleMessage(from, messageText) {
  const text = messageText.trim().toLowerCase();

  let result = await pool.query('SELECT * FROM leads WHERE phone = $1', [from]);
  let lead = result.rows[0];

  if (!lead) {
    await pool.query('INSERT INTO leads (phone) VALUES ($1)', [from]);
    await sendMessage(from, `Hi! Thanks for contacting us. I'll help you find the perfect property. 🏠\n\nWhat is your *budget range*?\n\n1️⃣ Under ₹50 lakh\n2️⃣ ₹50 lakh to ₹1 crore\n3️⃣ ₹1 crore to ₹1.5 crore\n4️⃣ Above ₹1.5 crore`);
    return;
  }

  const step = lead.current_step;

  if (step === 'ask_budget') {
    await pool.query('UPDATE leads SET budget = $1, current_step = $2, updated_at = NOW() WHERE phone = $3', [text, 'ask_location', from]);
    await sendMessage(from, `Got it! 👍\n\nWhich *area* are you looking in?\n\n1️⃣ SG Highway\n2️⃣ South Bopal\n3️⃣ Gota\n4️⃣ Shela\n5️⃣ Gandhinagar\n6️⃣ Other`);

  } else if (step === 'ask_location') {
    await pool.query('UPDATE leads SET location = $1, current_step = $2, updated_at = NOW() WHERE phone = $3', [text, 'ask_property', from]);
    await sendMessage(from, `Great choice! 🏘️\n\nWhat *type of property* are you looking for?\n\n1️⃣ 1 BHK\n2️⃣ 2 BHK\n3️⃣ 3 BHK\n4️⃣ 4 BHK+\n5️⃣ Commercial\n6️⃣ Plot`);

  } else if (step === 'ask_property') {
    await pool.query('UPDATE leads SET property_type = $1, current_step = $2, updated_at = NOW() WHERE phone = $3', [text, 'ask_timeline', from]);
    await sendMessage(from, `Perfect! ⏰\n\nWhen are you *planning to buy*?\n\n1️⃣ Within 30 days\n2️⃣ In 1–3 months\n3️⃣ In 3–6 months\n4️⃣ Just exploring`);

  } else if (step === 'ask_timeline') {
    await pool.query('UPDATE leads SET timeline = $1, current_step = $2, updated_at = NOW() WHERE phone = $3', [text, 'ask_intent', from]);
    await sendMessage(from, `Almost done! 🎯\n\nWhat would you prefer next?\n\n1️⃣ Schedule a site visit\n2️⃣ Receive property options first\n3️⃣ Get a call from our sales team`);

  } else if (step === 'ask_intent') {
    await pool.query('UPDATE leads SET intent = $1, current_step = $2, updated_at = NOW() WHERE phone = $3', [text, 'completed', from]);

    const updatedResult = await pool.query('SELECT * FROM leads WHERE phone = $1', [from]);
    const completedLead = updatedResult.rows[0];
    const score = await scoreLead(completedLead);

    await pool.query('UPDATE leads SET lead_score = $1, sales_summary = $2 WHERE phone = $3',
      [score.lead_score, score.sales_summary, from]);

    await sendMessage(from, `Thank you! ✅\n\nYour preferences have been shared with our team. A property advisor will contact you shortly with matching options.\n\n_Lead Score: ${score.lead_score}_`);

  } else if (step === 'completed') {
    await sendMessage(from, `Our team already has your details and will contact you soon. Thank you! 🙏`);
  }
}

app.get('/', (req, res) => {
  res.send('Imbrige WhatsApp Bot is running');
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    if (messages && messages.length > 0) {
      const message = messages[0];
      const from = message.from;
      const text = message.text?.body;
      if (from && text) {
        await handleMessage(from, text);
      }
    }
  } catch (e) {
    console.error('Error:', e);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  initDB().catch(err => console.error('DB init error:', err));
});
