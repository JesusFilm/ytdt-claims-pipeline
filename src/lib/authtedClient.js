const axios = require('axios');


async function createAuthedClient(baseURL, options = {}) {
  return axios.create({
    baseURL,
    timeout: options.timeout || 30000,
    ...options
  });
}

module.exports = { createAuthedClient };
