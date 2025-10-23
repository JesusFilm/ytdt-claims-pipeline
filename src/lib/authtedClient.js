const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');


async function createAuthedClient(baseURL, options = {}) {
  const headers = {};
  
  // Auto-detect Cloud Run environment
  if (process.env.K_SERVICE && baseURL) {
    const auth = new GoogleAuth();
    const client = await auth.getIdTokenClient(baseURL);
    const token = await client.idTokenProvider.fetchIdToken(baseURL);
    headers.Authorization = `Bearer ${token}`;
  }
  
  return axios.create({
    baseURL,
    headers,
    timeout: options.timeout || 30000,
    ...options
  });
}

module.exports = { createAuthedClient };
