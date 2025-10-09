function testETL(textData) {
    const lines = textData.split('\n');
    const result = [];

    let NameOfCompany = '';
    let UEN = '';
    let IncorporationDate = '';

    for (const line of lines) {
        if (line.startsWith('Name of Company:')) {
            nameOfCompany = line.replace('Name of Company:', '').trim();
        }
        if (line.startsWith('UEN:')) {
            uen = line.replace('UEN:', '').trim();
        }
        if (line.startsWith('Incorporation Date:')) {
            incorporationDate = line.replace('Incorporation Date:', '').trim();
        }
    }

    if (nameOfCompany || uen || incorporationDate) {
        result.push({
            nameOfCompany,
            uen,
            incorporationDate
        });
    }

    return result;
}

module.exports = { testETL };