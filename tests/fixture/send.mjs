// Sends an email. Usage: node send.mjs <to> "<subject>"  (body on stdin)
import { appendFileSync, readFileSync } from 'node:fs'
const [to, subject] = process.argv.slice(2)
let body = ''
try { body = readFileSync(0, 'utf8') } catch {}
appendFileSync(new URL('./outbox.log', import.meta.url), JSON.stringify({ at: new Date().toISOString(), to, subject, body }) + '\n')
console.log(`Sent to ${to}.`)
