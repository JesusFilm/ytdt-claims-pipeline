import axios from 'axios'
import { GoogleAuth } from 'google-auth-library'

import { env } from '../env.js'

export async function createAuthedClient(baseURL, options = {}) {
  const headers = {}

  // Optional: auto-detect Cloud Run environment (service-to-service auth)
  if (env.K_SERVICE && baseURL) {
    const auth = new GoogleAuth()
    const client = await auth.getIdTokenClient(baseURL)
    const token = await client.idTokenProvider.fetchIdToken(baseURL)
    headers.Authorization = `Bearer ${token}`
  }

  return axios.create({
    baseURL,
    headers,
    timeout: options.timeout || 30000,
    ...options,
  })
}
