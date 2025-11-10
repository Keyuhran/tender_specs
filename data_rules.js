// const input = {
//   "document": {
//     "formatted": {
//       "response": {
//         "value": "{\"employee_names\":\"TEST, TEST TAN, TEST LIM\",\"company_names\":\"COMPANY XYZ ONLINE, XZY ENGINEERING ASIA PTE LTD\"}"
//       }
//     }
//   }
// };
const names = ['james', 'adam']

function ETLfunc(ocrResponse) {
  const out = { employeeNames: [], companyNames: [] };
  if (!ocrResponse) return out;

  // Debug: log incoming structure
  console.log('ETL received:', JSON.stringify(ocrResponse, null, 2));

  // 1) Extract payload object from possible wrappers
  let payload = null;

  // Handle deeply nested response.value structure
  if (ocrResponse?.document?.formatted?.response?.value) {
    try {
      payload = JSON.parse(ocrResponse.document.formatted.response.value);
    } catch (e) {
      console.error('Failed to parse response.value:', e);
      return out;
    }
  } else if (ocrResponse?.formatted?.response?.value) {
    try {
      payload = JSON.parse(ocrResponse.formatted.response.value);
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

  out.employeeNames = toArray(empRaw);
  out.companyNames  = toArray(compRaw);

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
    
countDuplicates(names);

// Test section that runs when file is executed directly
if (require.main === module) {
  // Test data matching real OCR response structure
//   const testInput = {
//     document: {
//       formatted: {
//         response: {
//           value: JSON.stringify({
//             employee_names: "James Smith, John Doe, James Smith, Mary Wong, John Doe, Peter Pan",
//             company_names: "Tech Corp, Acme Inc, Tech Corp, New Corp, Acme Inc, Tech Corp"
//           })
//         }
//       }
//     }
//   };

  console.log('=== Testing ETL and Duplicate Detection ===');
  
  // Test ETL
  console.log('\nProcessing sample OCR response:');
  const etlResult = ETLfunc(testInput);
  console.log('Extracted names:', etlResult);

  // Test duplicate counting
  console.log('\nAnalyzing duplicates:');
  const employeeDups = countDuplicates(etlResult.employeeNames);
  const companyDups = countDuplicates(etlResult.companyNames);

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