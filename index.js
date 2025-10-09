// This script contains all the routes and logic for the Node.js backend server
const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const multer = require('multer');
const fs = require('fs');
dotenv.config({ path: path.resolve(__dirname, '.env') });
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

const formsg = require('@opengovsg/formsg-sdk')({
  mode: 'production',
})

const POST_URI = 'https://tender-specs.app.tc1.airbase.sg/submissions'

const formSecretKey = process.env.FORM_SECRET_KEY
const HAS_ATTACHMENTS = false

app.post(
  '/submissions',
  // Endpoint authentication by verifying signatures
  function (req, res, next) {
    try {
      formsg.webhooks.authenticate(req.get('X-FormSG-Signature'), POST_URI)
      // Continue processing the POST body
      return next()
    } catch (e) {
      return res.status(401).send({ message: 'Unauthorized' })
    }
  },
  // Parse JSON from raw request body
  express.json(),
  // Decrypt the submission
  async function (req, res, next) {
    try {
      const submission = HAS_ATTACHMENTS
        ? await formsg.crypto.decryptWithAttachments(formSecretKey, req.body.data)
        : formsg.crypto.decrypt(formSecretKey, req.body.data)

      if (submission) {
        // Print out the decrypted JSON to the console
        console.log('Decrypted submission:', JSON.stringify(submission, null, 2))
        // Respond with the decrypted submission as JSON
        return res.status(200).json(submission)
      } else {
        // Could not decrypt the submission
        console.error('Failed to decrypt submission')
        return res.status(400).send({ message: 'Failed to decrypt submission' })
      }
    } catch (err) {
      console.error('Error processing submission:', err)
      return res.status(500).send({ message: 'Internal server error' })
    }
  }
)

app.get('/', (req, res) => {
  res.send('Server is running!');
})

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});