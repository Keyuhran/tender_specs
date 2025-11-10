// server.js
const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const helmet = require('helmet');
const pdf = require('pdf-parse')
const ETL = require('./data_rules')
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const util = require('util');
const os = require('os');

test = "hello"

dotenv.config({ path: path.resolve(__dirname, '.env') });

const app = express();
const port = process.env.PORT || 3000;


app.use(helmet());


const POST_URI = 'https://tender-specs.app.tc1.airbase.sg/submissions';


const formsg = require('@opengovsg/formsg-sdk')({ mode: 'production' });
const formSecretKey = process.env.FORM_SECRET_KEY;

const writeFile = util.promisify(fs.writeFile);
const unlink = util.promisify(fs.unlink);

// ensure runtime-writable upload dir (use UPLOAD_DIR env or system tmp)
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'tender_uploads');
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o777 });
} catch (e) {
  console.error('Failed to create upload dir', UPLOAD_DIR, e);
}

app.use(express.json({ limit: '10mb' }));

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
  const tempFiles = []; // Track files to cleanup
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
          // Save file to disk (use runtime-writable upload dir)
          const filepath = path.join(UPLOAD_DIR, filename);
          await writeFile(filepath, buf);
          tempFiles.push(filepath);

          // Process with OCR API and wait for result
          console.log('Starting OCR processing for:', filename);
          const ocrResult = await processAttachmentWithOCR(filepath, process.env.OCR_API_KEY);
          

          // Enhanced OCR result logging and validation
          console.log('OCR Result Type:', typeof ocrResult);
          console.log('OCR Result Keys:', ocrResult ? Object.keys(ocrResult) : 'null');
          console.log('Full OCR Result:', JSON.stringify(ocrResult, null, 2));
          
          // Check if result exists and has either a direct value or nested value
          if (!ocrResult) {
            console.error('OCR result is null or undefined');
            continue;
          }

          let valueToProcess;
          if (typeof ocrResult === 'string') {
            valueToProcess = ocrResult;
          } else if (ocrResult.value) {
            valueToProcess = ocrResult.value;
          } else if (ocrResult.data && ocrResult.data.value) {
            valueToProcess = ocrResult.data.value;
          } else {
            console.error('Could not find value field in OCR result. Structure:', JSON.stringify(ocrResult, null, 2));
            continue;
          }

          try {
            // If valueToProcess is already an object, use it directly
            const valueObj = typeof valueToProcess === 'object' 
              ? valueToProcess 
              : JSON.parse(valueToProcess);
            
            console.log('Parsed value object:', valueObj);
            
            // Manual extraction as fallback
            const emp = valueObj.employee_names?.split(',').map(n => n.trim()).filter(Boolean) || [];
            const comp = valueObj.company_names?.split(',').map(n => n.trim()).filter(Boolean) || [];
            
            console.log('Extracted names:', { emp, comp });

            // Clean outbound payload (no rawOcr)
            const outbound = {
              test
            };

            // Log the exact payload being sent
            console.log('Final webhook payload:', JSON.stringify(outbound));
            await sendTransformedDataWebhook(outbound);

          } catch (parseErr) {
            console.error('Failed to parse OCR value:', parseErr);
          }

        } catch (err) {
          console.error(`Failed to process ${filename}:`, err)
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
  } finally {
    // Cleanup temp files
    for (const file of tempFiles) {
      try {
        await unlink(file);
      } catch (err) {
        console.error(`Failed to delete temp file ${file}:`, err);
      }
    }
  }
});


async function processAttachmentWithOCR(filename, apiKey) {
  const url = 'https://api.read-dev.pic.net.sg/v1/extract';                 
  const modelType = 'extract_general';                 // -F "model_type=extract_general"
  const processorId = 'VLM';                           // -F "processor_id=VLM"
  const dataClassification = 'rsn';                    // -F "data_classification=rsn"
  const vlmPrompt = [                                  // will be JSON.stringified
    { key: 'employee_names', description: 'Extract all employee names', type: 'string' },
    { key: 'company_names',  description: 'Extract all company names', type: 'string' },
  ];

  if (!filename || !fs.existsSync(filename)) {
    throw new Error('Missing or invalid file path');
  }
  if (!apiKey) {
    throw new Error('Missing API key');
  }

  const form = new FormData();
  form.append('file', fs.createReadStream(filename));              // -F "file=@${filename}"
  form.append('model_type', modelType);                            // -F "model_type=extract_general"
  form.append('processor_id', processorId);                        // -F "processor_id=VLM"
  form.append('vlm_prompt', JSON.stringify(vlmPrompt));            // -F "vlm_prompt=${vlm_prompt}"
  form.append('data_classification', dataClassification);          // -F "data_classification=rsn"

  console.time('request');
  try {
    const response = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${apiKey}`,                         // -H "Authorization: Bearer ${API_KEY}"
      },
      maxBodyLength: Infinity,
    });

    console.timeEnd('request');
    console.log('Status:', response.status, response.statusText);
    console.log(
      'Response:',
      typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2)
    );
    return response.data;
  } catch (err) {
    console.timeEnd('request');
    if (err.response) {
      console.error('Error status:', err.response.status, err.response.statusText);
      console.error('Body:', err.response.data);
    } else {
      console.error('Request error:', err.message);
    }
    throw err;
  }
}

// Add this helper function near the top with other constants
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});


