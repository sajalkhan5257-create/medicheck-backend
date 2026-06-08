import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', service: 'MediCheck Backend' });
});

// ── Prescription Analysis ─────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { symptoms, patientInfo, gender, medications, language } = req.body;

  if (!symptoms || symptoms.trim().length < 5)
    return res.status(400).json({ error: 'Please describe your symptoms.' });
  if (!Array.isArray(medications) || medications.length === 0)
    return res.status(400).json({ error: 'Please add at least one medication.' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('GROQ_API_KEY is not set.');
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  const langNote = language === 'ur'
    ? 'IMPORTANT: Write all text fields in Urdu (Nastaliq script). Keep medicine names in English only.'
    : 'Respond in English.';

  const medList = medications
    .map((m, i) => `${i + 1}. ${m.name} ${m.dose || ''} - ${m.freq || ''}${m.note ? ' - ' + m.note : ''}`.trim())
    .join('\n');

  const prompt = `You are a clinical pharmacist AI. Analyze this prescription. Respond ONLY with valid JSON, no markdown, no extra text.

${langNote}

PATIENT: ${symptoms.trim()}
DETAILS: ${patientInfo || 'Not provided'}
GENDER: ${gender || 'general'}
MEDICATIONS:
${medList}

Return EXACTLY this JSON:
{
  "status": "safe",
  "summary": "2-3 sentence assessment",
  "issues": [],
  "medications": [
    {
      "name": "medicine name",
      "dose": "dose",
      "timing": "Morning or Evening or Morning and Evening",
      "mealInstruction": "Before meals or After meals or With meals",
      "frequency": "Once daily",
      "maxDoseWarning": null,
      "sideEffects": ["effect1", "effect2", "effect3"],
      "foodsToAvoid": ["food1", "food2"],
      "notes": "special notes"
    }
  ],
  "dietPlan": {
    "recommended": ["food1", "food2", "food3", "food4"],
    "avoid": ["food1", "food2"],
    "hydration": "hydration advice",
    "lifestyle": "lifestyle tip"
  },
  "generalAdvice": "2 sentence recovery advice"
}

If issues exist, set status to "warning" or "danger" and fill the issues array.
Return ONLY the raw JSON object.`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'You are a clinical pharmacist AI assistant. Always respond with valid JSON only, no markdown formatting.'
          },
          { role: 'user', content: prompt }
        ],
        max_tokens: 2500,
        temperature: 0.3,
      }),
    });

    if (!groqRes.ok) {
      const errBody = await groqRes.text();
      console.error('Groq API error:', groqRes.status, errBody);
      return res.status(502).json({ error: `API error ${groqRes.status}. Please try again.` });
    }

    const data = await groqRes.json();
    let rawText = data.choices?.[0]?.message?.content || '';
    const cleaned = rawText.replace(/```json|```/g, '').trim();

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) result = JSON.parse(match[0]);
      else {
        console.error('Parse failed:', cleaned.slice(0, 300));
        return res.status(502).json({ error: 'Failed to parse response. Please try again.' });
      }
    }

    result.status = ['safe', 'warning', 'danger'].includes(result.status) ? result.status : 'warning';
    result.issues = Array.isArray(result.issues) ? result.issues : [];
    result.medications = Array.isArray(result.medications) ? result.medications : [];
    result.dietPlan = result.dietPlan || {};

    return res.json(result);

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));

app.listen(PORT, () => {
  console.log(`\n✅ MediCheck running on http://localhost:${PORT}`);
  console.log(`   Powered by Groq (Free) 🆓`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
