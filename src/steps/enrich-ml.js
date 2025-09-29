const axios = require('axios');
const FormData = require("form-data"); 
const fs = require('fs');


/**
 * Enrich unprocessed claims via external ML service (e.g. YT-Validator)
 * Sends CSV file to ML API endpoint, which should return immediately with a task ID,
 * a status of "running", eg. {"status":"running","task_id":"00dbf7d6-f525-43fb-86c9-c47d8804d931"}
 * The ML service will call back our webhook when done.
 */
async function enrichML(context) {
  
  const unprocessedPath = context.outputs.exports?.export_unprocessed_claims?.path;
  if (!unprocessedPath) {
    console.log('No unprocessed claims to enrich');
    return;
  }

  try {

    if (process.env.ML_API_ENDPOINT) {

      const formData = new FormData();
      formData.append('file', fs.createReadStream(unprocessedPath));
      formData.append('webhook_url', `${process.env.BASE_URL}/api/ml-webhook`); 
      formData.append('pipeline_run_id', context.runId);  // TODO: make required ?
      formData.append('skip_validation', String(true));

      const response = await axios.post(process.env.ML_API_ENDPOINT, formData, {headers: formData.getHeaders()});
      console.log('ML enrichment running: ', response.data);
      return response.data

    } else {
      throw new Error("ML enrichment disabled: env not set `ML_API_ENDPOINT`")
    }
    
  } catch (error) {
    throw new Error('ML enrichment failed:' + error.message)
  }
}

module.exports = enrichML;
