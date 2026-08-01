import process from 'node:process'

import { startRelay } from './app'

const host = process.env.HOST?.trim() || '127.0.0.1'
const port = Number(process.env.PORT || 8080)
const publishSecret = process.env.PUBLISH_SECRET || ''
const sessionSigningSecret = process.env.SESSION_SIGNING_SECRET || ''
const publicBaseUrl = process.env.PUBLIC_BASE_URL || ''
const problems: string[] = []
if (!Number.isInteger(port) || port < 1 || port > 65535)
  problems.push('PORT must be an integer from 1 to 65535')
if (!publishSecret || !sessionSigningSecret)
  problems.push('publisher and signing secrets are required')
if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET)
  problems.push('Discord OAuth credentials are required')
if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
  try {
    if (new URL(publicBaseUrl).protocol !== 'https:')
      problems.push('a public relay must use an HTTPS PUBLIC_BASE_URL')
  }
  catch {
    problems.push('a public relay requires a valid PUBLIC_BASE_URL')
  }
}
if (problems.length)
  throw new Error(`Invalid relay configuration: ${problems.join('; ')}`)

startRelay({
  host,
  port,
  publicBaseUrl,
  publishSecret,
  discordClientId: process.env.DISCORD_CLIENT_ID || '',
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  sessionSigningSecret,
})
console.info(`Discord avatar relay listening on ${host}:${port}`)
