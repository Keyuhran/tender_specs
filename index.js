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
const os = require('os');
const { promisify } = require('util');
const writeFileAsync = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);


dotenv.config({ path: path.resolve(__dirname, '.env') });

const app = express();
const port = process.env.PORT || 3000;


app.use(helmet());


const POST_URI = 'https://tender-specs.app.tc1.airbase.sg/submissions';


const formsg = require('@opengovsg/formsg-sdk')({ mode: 'production' });
const formSecretKey = process.env.FORM_SECRET_KEY;


app.use(express.json({ limit: '10mb' }));

async function processAttachmentWithOCR(filename, apiKey) {
  const url = 'https://api-dev.aisay.tech.gov.sg/v1/extract';                 
  const modelType = 'GENERAL';                 // -F "model_type=GENERAL"
  const processorId = 'VLM';                           // -F "processor_id=VLM"
  const dataClassification = 'RSN';                    // -F "data_classification=RSN"
  const vlmPrompt = [     
    { key: 'ic_numbers',  description: 'Return all identification numbers of employees from the document, each individual number should be seperated by a comma ', type: 'string' },
    { key: 'employee_names', description: 'Extract all employee names, each individual name should be seperated by a comma', type: 'string' },
    { key: 'company_names',  description: 'Extract all company names, each individual name should be seperated by a comma. Ignore the company: ACCOUNTING AND CORPORATE REGULATORY AUTHORITY (ACRA)', type: 'string' },

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

// ensure runtime-writable upload dir under system temp
const UPLOAD_DIR =  path.join(os.tmpdir(), 'tender_uploads');
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o777 });
} catch (e) {
  console.error('Failed to create upload dir', UPLOAD_DIR, e);
}

// BatchProcessor for handling multiple files
class BatchProcessor {
  constructor(timeoutMs = 20000) {
    this.timeoutMs = timeoutMs;
    this.timer = null;
    this.batch = {
      employeeNames: [], // keep duplicates
      companyNames: [], // keep duplicates
      icNumbers: [], // NEW: collect all identification numbers (duplicates kept)
      email: null
    };
  }

  addData(data) {
    // Add all names to arrays (keeping duplicates)
    if (data.employeeNames) {
      this.batch.employeeNames.push(...data.employeeNames);
    }
    if (data.companyNames) {
      this.batch.companyNames.push(...data.companyNames);
    }
    // Add icNumbers if provided
    if (data.icNumbers) {
      this.batch.icNumbers.push(...data.icNumbers);
    }
    // Keep the email (assume same email for batch)
    if (data.email) {
      this.batch.email = data.email;
    }

    // Reset/start timeout
    if (this.timer) {
      clearTimeout(this.timer);
    }
    
    this.timer = setTimeout(() => this.sendBatch(), this.timeoutMs);
    
    console.log('Added to batch, names so far:', {
      employeeCount: this.batch.employeeNames.length,
      companyCount: this.batch.companyNames.length,
      icCount: this.batch.icNumbers.length
    });
  }

  async sendBatch() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Use arrays directly for duplicate analysis
    const { count: empDupCount, names: empDupNames } = ETL.countDuplicates(this.batch.employeeNames);
    const { count: compDupCount, names: compDupNames } = ETL.countDuplicates(this.batch.companyNames);
    const { count: icDupCount, names: icDupNames } = ETL.countDuplicates(this.batch.icNumbers);

    // yes/no for ic duplicates
    const icDuplicatesYesNo = icDupCount > 0 ? 'yes' : 'no';

    // Match test case payload format - include icDuplicatesYesNo and optional list
    const payload = {
      email: this.batch.email,
      employeeDuplicatesCount: empDupCount,
      employeeDuplicateNames: empDupNames,
      companyDuplicatesCount: compDupCount,
      companyDuplicateNames: compDupNames,
      icDuplicates: icDuplicatesYesNo
      // optionally: icDuplicateNames: icDupNames
    };

    console.log('Sending webhook payload:', JSON.stringify(payload, null, 2));
    
    try {
      await sendTransformedDataWebhook(payload);
      
      // After successful send: remove all files written to UPLOAD_DIR
      try {
        const files = await fs.promises.readdir(UPLOAD_DIR);
        for (const f of files) {
          const fp = path.join(UPLOAD_DIR, f);
          try {
            await fs.promises.unlink(fp);
            console.log('Deleted temp file:', fp);
          } catch (e) {
            console.warn('Failed to delete temp file:', fp, e?.message || e);
          }
        }
      } catch (e) {
        console.warn('Failed to list/clean upload dir', UPLOAD_DIR, e?.message || e);
      }

      // Clear all lists after successful webhook send
      console.log('Clearing batch data...');
      this.batch.employeeNames = [];
      this.batch.companyNames = [];
      this.batch.icNumbers = [];
      this.batch.email = null;
      
      console.log('Batch cleared. Current counts:', {
        employeeNames: this.batch.employeeNames.length,
        companyNames: this.batch.companyNames.length,
        icNumbers: this.batch.icNumbers.length
      });
    } catch (err) {
      console.error('Failed to send batch:', err);
    }
  }
}

// Create single instance
const batchProcessor = new BatchProcessor(20000); // 20 seconds

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
          // Save file to disk in UPLOAD_DIR (use runtime-writable upload dir)
          const filepath = path.join(UPLOAD_DIR, filename);
           await writeFileAsync(filepath, buf);
          
          // Use OCR API instead of pdf-parse
          console.log('Starting OCR processing for:', filename);
          const ocrResult = await processAttachmentWithOCR(filepath, process.env.OCR_API_KEY);
          console.log('OCR processing complete:', JSON.stringify(ocrResult, null, 2));

          const { employeeNames, companyNames, icNumbers } = ETL.ETLfunc(ocrResult);
          
          // Add to batch instead of sending immediately
          batchProcessor.addData({
            email, // Include email
            employeeNames,
            companyNames,
            icNumbers // NEW
          });

          // Cleanup temp file
          try {
            // individual file removal optional here; final cleanup happens after webhook send
            await unlink(filepath).catch(()=>{});
          } catch (cleanupErr) {
            console.error('Failed to cleanup file:', filepath, cleanupErr);
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
  }
});



// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});


