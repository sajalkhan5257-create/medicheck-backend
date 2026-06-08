import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*', // Set to your frontend URL in production
  methods: ['GET', 'POST'],
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public')); // Serve frontend from /public folder

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', service: 'MediCheck Backend' });
});

// ── Main: Prescription Analysis ───────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { symptoms, patientInfo, gender, medications, language } = req.body;

  // Validation
  if (!symptoms || typeof symptoms !== 'string' || symptoms.trim().length < 5) {
    return res.status(400).json({ error: 'symptoms field is required (min 5 chars).' });
  }
  if (!Array.isArray(medications) || medications.length === 0) {
    return res.status(400).json({ error: 'medications must be a non-empty array.' });
  }
  if (medications.length > 15) {
    return res.status(400).json({ error: 'Too many medications (max 15).' });
  }

  // Validate each medication entry
  for (const m of medications) {
    if (!m.name || typeof m.name !== 'string' || m.name.trim().length === 0) {
      return res.status(400).json({ error: 'Each medication must have a name.' });
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set in environment variables.');
    return res.status(500).json({ error: 'Server configuration error. API key missing.' });
  }

  // Build language instruction
  const langNote =
    language === 'ur'
      ? 'IMPORTANT: Write all text fields (summary, generalAdvice, timing, mealInstruction, sideEffects, foodsToAvoid, notes, diet fields, issue descriptions) in Urdu (Nastaliq script). Keep medicine names in English/Latin only.'
      : 'Respond in English.';

  // Build medication list string
  const medList = medications
    .map((m, i) => `${i + 1}. ${m.name.trim()} ${m.dose || ''} - ${m.freq || ''}${m.note ? ' - ' + m.note : ''}`.trim())
    .join('\n');

  const prompt = `You are a clinical pharmacist AI assistant. Analyze this prescription carefully and respond ONLY with a valid JSON object — no markdown fences, no explanation outside JSON.

${langNote}

PATIENT CONDITION: ${symptoms.trim()}
PATIENT DETAILS: ${patientInfo?.trim() || 'Not provided'}
PATIENT GENDER: ${gender || 'general'}

PRESCRIBED MEDICATIONS:
${medList}

Return EXACTLY this JSON structure:
{
  "status": "safe" | "warning" | "danger",
  "summary": "2-3 sentence overall assessment",
  "issues": [
    {
      "type": "interaction | wrong_drug | dosage | contraindication | allergy",
      "severity": "high | medium | low",
      "description": "Clear explanation of the issue",
      "recommendation": "What the patient should do"
    }
  ],
  "medications": [
    {
      "name": "medicine name",
      "dose": "dose info",
      "timing": "Morning | Evening | Morning and Evening | Three times daily | etc",
      "mealInstruction": "Before meals | After meals | With meals | On empty stomach | With or without food",
      "frequency": "e.g. Once daily",
      "maxDoseWarning": "warning string or null",
      "sideEffects": ["effect1", "effect2", "effect3", "effect4"],
      "foodsToAvoid": ["food1", "food2"],
      "notes": "Any special instructions"
    }
  ],
  "dietPlan": {
    "recommended": ["food1", "food2", "food3", "food4", "food5"],
    "avoid": ["food1", "food2", "food3"],
    "hydration": "Hydration advice string",
    "lifestyle": "Key lifestyle tip for recovery"
  },
  "generalAdvice": "2 sentences of overall recovery advice"
}

Rules:
- issues array must be [] if status is "safe"
- Always fill medications and dietPlan regardless of status
- Do NOT wrap JSON in markdown code blocks
- Return ONLY the raw JSON object`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error('Anthropic API error:', anthropicRes.status, errBody);
      return res.status(502).json({
        error: `Anthropic API returned ${anthropicRes.status}. Please try again.`,
      });
    }

    const data = await anthropicRes.json();
    const rawText = data.content?.map(b => b.text || '').join('') || '';

    // Strip any accidental markdown fences
    const cleaned = rawText.replace(/```json|```/g, '').trim();

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      // Try extracting JSON object with regex as fallback
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        result = JSON.parse(match[0]);
      } else {
        console.error('Failed to parse AI response:', cleaned.slice(0, 300));
        return res.status(502).json({ error: 'Failed to parse AI response. Please try again.' });
      }
    }

    // Sanitize / ensure required fields exist
    result.status = ['safe', 'warning', 'danger'].includes(result.status) ? result.status : 'warning';
    result.issues = Array.isArray(result.issues) ? result.issues : [];
    result.medications = Array.isArray(result.medications) ? result.medications : [];
    result.dietPlan = result.dietPlan || {};

    return res.json(result);

  } catch (err) {
    console.error('Unexpected server error:', err);
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
});

// ── 404 fallback ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ MediCheck backend running on http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   API endpoint: POST http://localhost:${PORT}/api/analyze\n`);
});
