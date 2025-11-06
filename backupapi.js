async function processAttachmentWithOCR(filename, apiKey) {
  const url = 'https://api.read-dev.pic.net.sg/v1/extract';                 
  const modelType = 'extract_general';                 // -F "model_type=extract_general"
  const processorId = 'VLM';                           // -F "processor_id=VLM"
  const dataClassification = 'rsn';                    // -F "data_classification=rsn"
  const vlmPrompt = [                                  // will be JSON.stringified
    { key: 'employee_names', description: 'Extract all employee names starting with A', type: 'string' },
    { key: 'company_names',  description: 'Extract all company names starting with Z', type: 'string' },
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