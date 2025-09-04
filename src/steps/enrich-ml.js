const axios = require('axios');
const fs = require('fs').promises;
const csv = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');


async function enrichML(context) {
  
  const unprocessedPath = context.outputs.exports?.export_unprocessed_claims?.path;
  if (!unprocessedPath) {
    console.log('No unprocessed claims to enrich');
    return;
  }

  try {
    // Call ML API (or use dummy data for now)
    if (process.env.ML_API_ENDPOINT) {
      const formData = new FormData();
      formData.append('file', await fs.readFile(unprocessedPath));
      
      const response = await axios.post(process.env.ML_API_ENDPOINT, formData);
      await fs.writeFile(unprocessedPath, response.data);
    } else {
      // Add dummy ratings
      const content = await fs.readFile(unprocessedPath, 'utf8');
      const rows = csv.parse(content, { columns: true });
      
      rows.forEach(row => {
        row.rating = Math.random(); // Dummy rating 0-1
      });
      
      const enrichedCSV = stringify(rows, { header: true });
      await fs.writeFile(unprocessedPath, enrichedCSV);
    }
    
    console.log('ML enrichment completed');
  } catch (error) {
    console.warn('ML enrichment failed, continuing without ratings:', error.message);
  }
}

module.exports = enrichML;
