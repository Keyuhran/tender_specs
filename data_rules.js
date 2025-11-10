// const input = {
//   "document": {
//     "formatted": {
//       "response": {
//         "value": "{\"employee_names\":\"TEST, TEST TAN, TEST LIM\",\"company_names\":\"COMPANY XYZ ONLINE, XZY ENGINEERING ASIA PTE LTD\"}"
//       }
//     }
//   }
// };

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

// console.log(ETLfunc(input));
// if (require.main === module) {
//   console.log('Testing ETL with sample input...');
//   console.log('Input:', JSON.stringify(input, null, 2));
//   const result = ETLfunc(input);
//   console.log('Output:', JSON.stringify(result, null, 2));
// }

module.exports = { ETLfunc };