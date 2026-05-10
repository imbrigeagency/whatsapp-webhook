const express = require('express');
const https = require('https');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = 'imbrige2024';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = '1097591180108358';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  // Create leads table with conversation_history as JSONB
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE,
      conversation_history JSONB DEFAULT '[]'::jsonb,
      budget TEXT,
      location TEXT,
      property_type TEXT,
      timeline TEXT,
      intent TEXT,
      lead_score TEXT,
      sales_summary TEXT,
      completed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Migrate existing table if it has old schema (current_step column)
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='leads' AND column_name='current_step'
      ) THEN
        ALTER TABLE leads DROP COLUMN IF EXISTS current_step;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='leads' AND column_name='conversation_history'
      ) THEN
        ALTER TABLE leads ADD COLUMN conversation_history JSONB DEFAULT '[]'::jsonb;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='leads' AND column_name='completed'
      ) THEN
        ALTER TABLE leads ADD COLUMN completed BOOLEAN DEFAULT FALSE;
      END IF;
    END
    $$;
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

async function callGemini(conversationHistory) {
  const SYSTEM_PROMPT = `You are a friendly WhatsApp assistant for Imbrige Agency, an Indian real estate agency in Ahmedabad.

Your job is to help buyers find properties while naturally collecting these 5 data points through conversation:
1. budget (e.g. under 50 lakh, 50L-1Cr, 1Cr-1.5Cr, above 1.5Cr)
2. location (preferred areas: SG Highway, South Bopal, Gota, Shela, Gandhinagar, or other)
3. property_type (1 BHK, 2 BHK, 3 BHK, 4 BHK+, Commercial, Plot)
4. timeline (within 30 days, 1-3 months, 3-6 months, just exploring)
5. intent (site visit, receive options first, sales call)

Rules:
- Respond in warm, conversational WhatsApp style. Short messages only.
- Collect missing data points naturally — don't make it feel like a form.
- If the user gives multiple data points in one message, capture all of them.
- Accept free text answers. Don't force numbered options unless helpful.
- Never repeat a question you already have the answer to.
- Keep responses under 100 words.

Once you have collected ALL 5 data points, score the lead and respond with ONLY this JSON (no extra text before or after):
{"collected":true,"budget":"...","location":"...","property_type":"...","timeline":"...","intent":"...","lead_score":"Hot/Warm/Cold","sales_summary":"one sentence about this buyer"}

Lead scoring rules:
- Hot: budget 50L+ AND timeline within 30 days or 1-3 months AND intent is site visit or sales call
- Warm: any budget AND timeline 3-6 months, OR budget 50L+ with site visit intent
- Cold: just exploring OR very unclear intent

Until you have all 5 data points, just respond naturally. Do not output JSON until all 5 are collected.`;

  // Build Gemini contents array from conversation history
  // Gemini expects alternating user/model turns
  const contents = [
    // Inject system prompt as first user message + model acknowledgement
    {
      role: 'user',
      parts: [{ text: SYSTEM_PROMPT }]
    },
    {
      role: 'model',
      parts: [{ text: 'Understood. I will act as the Imbrige Agency WhatsApp assistant and naturally collect all 5 data points before scoring.' }]
    },
    // Then the actual conversation
    ...conversationHistory.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.text }]
    }))
  ];

  const body = JSON.stringify({ contents });

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
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve(text.trim());
        } catch (e) {
          console.error('Gemini parse error:', e, data);
          resolve(null);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function extractJSON(text) {
  // Try to find a JSON block in Gemini's response
  try {
    // Direct parse — Gemini returned clean JSON
    const parsed = JSON.parse(text);
    if (parsed.collected === true) return parsed;
  } catch (_) {}

  // Try extracting JSON from markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed.collected === true) return parsed;
    } catch (_) {}
  }

  // Try finding raw JSON object anywhere in the text
  const jsonMatch = text.match(/\{[\s\S]*"collected"\s*:\s*true[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.collected === true) return parsed;
    } catch (_) {}
  }

  return null;
}

async function handleMessage(from, messageText) {
  const text = messageText.trim();
  console.log(`Message from ${from}: "${text}"`);

  // Get or create lead record
  let result = await pool.query('SELECT * FROM leads WHERE phone = $1', [from]);
  let lead = result.rows[0];

  if (!lead) {
    await pool.query('INSERT INTO leads (phone, conversation_history) VALUES ($1, $2)', [from, JSON.stringify([])]);
    result = await pool.query('SELECT * FROM leads WHERE phone = $1', [from]);
    lead = result.rows[0];
    console.log('New lead created for:', from);
  }

  // If already completed, send a polite message and stop
  if (lead.completed) {
    await sendMessage(from, `Our team already has your details and will be in touch shortly. Thank you! 🙏`);
    return;
  }

  // Load existing history and append new user message
  const history = Array.isArray(lead.conversation_history) ? lead.conversation_history : [];
  history.push({ role: 'user', text });

  // Call Gemini with full history
  const geminiResponse = await callGemini(history);

  if (!geminiResponse) {
    await sendMessage(from, `Sorry, I'm having a technical issue. Please try again in a moment.`);
    return;
  }

  console.log('Gemini response:', geminiResponse);

  // Check if Gemini has collected all data points
  const extracted = extractJSON(geminiResponse);

  if (extracted) {
    // All 5 data points collected — save lead and complete
    history.push({ role: 'model', text: geminiResponse });

    await pool.query(`
      UPDATE leads SET
        conversation_history = $1,
        budget = $2,
        location = $3,
        property_type = $4,
        timeline = $5,
        intent = $6,
        lead_score = $7,
        sales_summary = $8,
        completed = TRUE,
        updated_at = NOW()
      WHERE phone = $9
    `, [
      JSON.stringify(history),
      extracted.budget,
      extracted.location,
      extracted.property_type,
      extracted.timeline,
      extracted.intent,
      extracted.lead_score,
      extracted.sales_summary,
      from
    ]);

    const completionMessage = `Thank you! ✅\n\nYour preferences have been shared with our team at Imbrige Agency. A property advisor will contact you shortly with matching options.\n\n_Score: ${extracted.lead_score}_`;
    await sendMessage(from, completionMessage);
    console.log(`Lead completed for ${from} — Score: ${extracted.lead_score}`);

  } else {
    // Conversation still ongoing — save history and send Gemini's natural reply
    history.push({ role: 'model', text: geminiResponse });

    await pool.query(`
      UPDATE leads SET
        conversation_history = $1,
        updated_at = NOW()
      WHERE phone = $2
    `, [JSON.stringify(history), from]);

    await sendMessage(from, geminiResponse);
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
    console.error('Webhook error:', e);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  initDB().catch(err => console.error('DB init error:', err));
});
