
const testInput = {
"document_type": null,

"document": {

"value": {

"response": {

"value": "{\"ic_numbers\":\"S1234567C, S2142424A, T20202020\",\"employee_names\":\"LIM TAN, RYAN TIM,BRYAN LOW \",\"company_names\":\"CHARSLTON TECHNOLOGIES PTE LTD\"}",

"confidence": null

}

},

"confidence": null

},

"metadata": {

"processing_time_seconds": 8.713,

"file_size_mb": 0.192,

"page_count": 5,

"model": "vlm_rsn_v1"

}

};



function ETLfunc(ocrResponse) {
  const out = { employeeNames: [], companyNames: [], icNumbers: [] };
  if (!ocrResponse) return out;

  // Debug: log incoming structure
  console.log('ETL received:', JSON.stringify(ocrResponse, null, 2));

  // 1) Extract payload object from possible wrappers
  let payload = null;

  // Handle deeply nested response.value structure
  if (ocrResponse?.document?.value?.response?.value) {
    try {
      payload = JSON.parse(ocrResponse.document.value.response.value);
    } catch (e) {
      console.error('Failed to parse response.value:', e);
      return out;
    }
  } else if (ocrResponse?.value?.response?.value) {
    try {
      payload = JSON.parse(ocrResponse.value.response.value);
    } catch (e) {
      console.error('Failed to parse response.value:', e);
      return out;
    }
  } else if (ocrResponse?.value) {
    try {
      payload = JSON.parse(ocrResponse.value);
    } catch (e) {
      payload = { employee_names: ocrResponse.value, company_names: '' };
    }
  } else {
    payload = ocrResponse;
  }

  // Debug: log extracted payload
  console.log('Extracted payload:', JSON.stringify(payload, null, 2));

  if (!payload || typeof payload !== 'object') return out;

  // 2) Normalize keys (lowercase, spaces -> underscores)
  const norm = {};
  for (const [k, val] of Object.entries(payload)) {
    norm[k.toLowerCase().replace(/\s+/g, '_')] = val;
  }

  // 3) Helper: normalize a field (accept string or array; split on , ; or newline)
  const toArray = (val) => {
    if (Array.isArray(val)) return val.map(x => String(x).trim()).filter(Boolean);
    if (val == null) return [];
    const s = String(val);
    return s
      .split(/[,;\n]/g)
      .map(x => x.trim())
      .filter(Boolean);
  };

  // 4) Read values with a few tolerant aliases
  const empRaw = norm.employee_names ?? norm.employee ?? norm['employee-name'] ?? '';
  const compRaw = norm.company_names  ?? norm.company  ?? norm['company-name']  ?? '';
  const icRaw = norm.identification ?? norm.identification_number ?? norm.ic ?? norm.ic_number ?? norm.ic_numbers ?? norm['identification-number'] ?? '';

  out.employeeNames = toArray(empRaw);
  out.companyNames  = toArray(compRaw);
  out.icNumbers     = toArray(icRaw);

  // Debug: log final output
  console.log('ETL output:', JSON.stringify(out, null, 2));
  return out;
}

function countDuplicates(arr) {
  const freq = new Map();
  for (const x of arr) freq.set(x, (freq.get(x) || 0) + 1);

  const names = [];
  for (const [val, c] of freq) if (c > 1) names.push(val);

  return { count: names.length, names };
}
    
//countDuplicates(names);

// Test section that runs when file is executed directly
if (require.main === module) {


  console.log('=== Testing ETL and Duplicate Detection ===');
  
  // Test ETL
  console.log('\nProcessing sample OCR response:');
  const etlResult = ETLfunc(testInput);
  console.log('Extracted names:', etlResult);

  // Test duplicate counting
  console.log('\nAnalyzing duplicates:');
  const employeeDups = countDuplicates(etlResult.employeeNames);
  const companyDups = countDuplicates(etlResult.companyNames);
  const icDups = countDuplicates(etlResult.icNumbers);

  // Show expected webhook payload format
  const samplePayload = {
    email: "test@example.com",
    employeeDuplicatesCount: employeeDups.count,
    employeeDuplicateNames: employeeDups.names,
    companyDuplicatesCount: companyDups.count,
    companyDuplicateNames: companyDups.names
  };

  console.log('\nExpected webhook payload format:', JSON.stringify(samplePayload, null, 2));
}

module.exports = { ETLfunc,
    countDuplicates
};