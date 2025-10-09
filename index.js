// server.js
const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const helmet = require('helmet');
const pdf = require('pdf-parse')
const ETL = require('./data_rules')

dotenv.config({ path: path.resolve(__dirname, '.env') });

const app = express();
const port = process.env.PORT || 3000;

// Security & JSON
app.set('trust proxy', true);
app.use(helmet());

// IMPORTANT: This must be the exact public HTTPS URL that FormSG calls.
// It must match what you configured in the FormSG dashboard (scheme, host, path).
const POST_URI = 'https://tender-specs.app.tc1.airbase.sg/submissions';

const formsg = require('@opengovsg/formsg-sdk')({ mode: 'production' });
const formSecretKey = process.env.FORM_SECRET_KEY;

// Keep body limit modest; webhook JSON is small (attachments are fetched by SDK)
app.use(express.json({ limit: '1mb' }));

// Simple health
app.get('/', (_req, res) => res.send('Server is running!'));

// Helper: sanitize filenames for disk use
const sanitize = (name) =>
  (name || 'file.bin').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);

// Middleware: verify signature
function verifySignature(req, res, next) {
  try {
    const sig = req.get('X-FormSG-Signature');
    if (!sig) return res.status(401).json({ message: 'Unauthorized: missing signature' });
    formsg.webhooks.authenticate(sig, POST_URI);
    return next();
  } catch (e) {
    console.error('Signature verification failed:', e?.message || e);
    return res.status(401).json({ message: 'Unauthorized' });
  }
}

// Global variable to store transformedData
let transformedData = null;

// Helper function to send transformedData to webhook
async function sendTransformedDataWebhook(data) {
  const WEBHOOK_URL = "https://plumber.gov.sg/webhooks/4acce619-2b72-4b05-9d97-46a70fd664a3";
  if (!WEBHOOK_URL || !data) return;
  try {
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error('Webhook failed:', text);
    }
  } catch (err) {
    console.error('Error sending webhook:', err);
  }
}

app.post('/submissions', verifySignature, async (req, res) => {
  try {
    // 1) Decrypt + fetch attachments immediately (S3 URLs expire ~1h)
    const HAS_ATTACHMENTS = true;
    const submission = HAS_ATTACHMENTS
      ? await formsg.crypto.decryptWithAttachments(formSecretKey, req.body.data)
      : formsg.crypto.decrypt(formSecretKey, req.body.data);

    if (!submission) {
      console.error('decryptWithAttachments returned null (mismatch, expired URL, or decrypt failure)');
      return res.status(422).json({ message: 'Unprocessable: decryption failed' });
    }

    const { content, attachments } = submission;
    const responses = content?.responses ?? [];
    // Extract email from responses
    let email = null;
    for (const r of responses) {
      if (r && r.question && typeof r.question === 'string' && r.question.toLowerCase().includes('email')) {
        email = r.answer;
        break;
      }
    }

    const idToQuestion = new Map(
      responses
        .filter((r) => r && typeof r === 'object')
        .map((r) => [r._id, r.question])
    );

    console.log(`decrypt_ok responses=${responses.length} attachments=${attachments ? Object.keys(attachments).length : 0}`);

    // 2) Persist attachments (optional)
    const MAX_BYTES = 50 * 1024 * 1024; // 50MB
    const savedFiles = [];
    if (attachments && typeof attachments === 'object') {
      for (const [fieldId, meta] of Object.entries(attachments)) {
        const raw = meta?.content
        const filename = sanitize(meta?.filename) || 'file.bin'
        if (!raw) continue

        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        const isPdf = buf.slice(0, 4).equals(Buffer.from('%PDF'))
        console.log(`attachment ${filename}: ${buf.length} bytes, isPdf=${isPdf}`)

        if (!isPdf) continue

        try {
          // Direct OCR/text extraction in memory
          const data = await pdf(buf)
          extractedText = data.text
          console.log(`extracted text from ${filename}:\n`, data.text.slice(0, 100)) // limit preview // limit preview
          transformedData = ETL.testETL(extractedText)
          // Prepare outbound payload with email and extracted fields
          let outbound = {
            email,
            nameOfCompany: transformedData[0]?.nameOfCompany || '',
            uen: transformedData[0]?.uen || '',
            incorporationDate: transformedData[0]?.incorporationDate || ''
          };
          // Automatically send webhook after transformation
          await sendTransformedDataWebhook(outbound)

          // TODO: send to your downstream pipeline here (LLM, DB, etc.)
        } catch (err) {
          console.error(`Failed to parse ${filename}:`, err)
        }
      }
    }

    // 3) Return something useful to your caller (200, not 202, since work is done)
    return res.status(200).json({
      ok: true,
      responsesCount: responses.length,
      savedCount: savedFiles.length,
      savedFiles,
    });
  } catch (err) {
    console.error('Error processing submission:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});


