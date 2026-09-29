#!/usr/bin/env node
// Tests for charter-lock.mjs. Each case pipes a real tool call into the hook as
// a separate process and reads its answer, so what is tested is what runs.
//
//   node test-charter-lock.mjs            run the suite against the hook
//   node test-charter-lock.mjs --runs 3   run it three times (the result must repeat)
//
// The suite also proves it can fail: it runs once against a hook that lets
// everything through, and that run must report failures. A suite that passes a
// hook which does nothing is a green light wired to nothing.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const HOOK = path.join(here, 'charter-lock.mjs')

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } })
const ps = (command) => ({ tool_name: 'PowerShell', tool_input: { command } })
const mcp = (name, input = {}) => ({ tool_name: name, tool_input: input })

const MUST_ASK = [
  bash('git push origin main'),
  bash('git push --force'),
  bash('git reset --hard HEAD~3'),
  bash('git rm old-notes.md'),
  bash('npm publish'),
  bash('gh pr create --title "x" --body "y"'),
  bash('gh api repos/me/x/issues -X POST -f title=hi'),
  bash('curl -X POST https://api.example.com/send -d "{}"'),
  bash("curl https://hooks.example.com -d 'text=hello'"),
  bash('curl --json \'{"a":1}\' https://api.example.com'),
  bash('vercel deploy --prod'),
  bash('npx wrangler deploy'),
  bash('echo "hi" | mail -s "Hello" dana@example.com'),
  bash('rm -rf build'),
  bash('cd notes && rm draft.md'),
  bash('find . -name "*.tmp" | xargs rm'),
  bash('find . -name "*.log" -delete'),
  bash('psql $DB -c "DELETE FROM contacts WHERE id = 3"'),
  bash('sendmail dana@example.com < reply.txt'),
  ps('Remove-Item -Recurse .\\old'),
  ps('Invoke-RestMethod -Uri https://api.example.com -Method Post -Body $b'),
  ps('Send-MailMessage -To a@b.c -Subject hi'),
  mcp('mcp__gmail__send_email', { to: 'a@b.c' }),
  mcp('mcp__buffer__create_post', { text: 'hi' }),
  mcp('mcp__slack__post_message', { text: 'hi' }),
  mcp('mcp__stripe__create_payment_link', {}),
  mcp('mcp__supabase__delete_branch', {}),
  mcp('mcp__vercel__cancel_deployment', {}),
  mcp('mcp__buffer__execute_mutation', {}),
  mcp('mcp__db__execute_sql', { query: 'drop table users' }),
  mcp('mcp__drive__removeFile', {}),
]

const MUST_PASS = [
  bash('git status'),
  bash('git log --oneline -5'),
  bash('git diff'),
  bash('ls -la'),
  bash('npm run build'),
  bash('npm test'),
  bash('curl -sL https://example.com'),
  bash("curl -sL -o /dev/null -w '%{http_code}' https://example.com"),
  bash('grep -rn "rm " src'),
  bash('grep -rn mail src'),
  bash('cat README.md'),
  bash('echo "remember to clear the list later"'),
  bash('node scripts/check.mjs'),
  bash('gh pr view 12'),
  ps('Get-ChildItem'),
  mcp('mcp__buffer__list_posts', {}),
  mcp('mcp__buffer__get_post', { id: 1 }),
  mcp('mcp__gmail__search_threads', { q: 'invoice' }),
  mcp('mcp__db__execute_sql', { query: 'select * from users' }),
  mcp('mcp__docs__create', { title: 'Notes' }),
  { tool_name: 'Read', tool_input: { file_path: 'a.md' } },
  { tool_name: 'Write', tool_input: { file_path: 'rm.md', content: 'rm -rf /' } },
  { tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } },
]

function answer(hookCommand, call) {
  const r = spawnSync(hookCommand[0], hookCommand.slice(1), {
    input: JSON.stringify(call),
    encoding: 'utf8',
  })
  if (r.status !== 0) return { decision: `exit ${r.status}` }
  const out = r.stdout.trim()
  if (!out) return { decision: 'pass' }
  try {
    return { decision: JSON.parse(out).hookSpecificOutput?.permissionDecision ?? 'unreadable' }
  } catch {
    return { decision: 'unreadable' }
  }
}

function runSuite(hookCommand) {
  const failures = []
  for (const call of MUST_ASK) {
    const { decision } = answer(hookCommand, call)
    if (decision !== 'ask') failures.push(`should ask, got ${decision}: ${JSON.stringify(call)}`)
  }
  for (const call of MUST_PASS) {
    const { decision } = answer(hookCommand, call)
    if (decision !== 'pass') failures.push(`should pass, got ${decision}: ${JSON.stringify(call)}`)
  }
  return failures
}

const runsFlag = process.argv.indexOf('--runs')
const runs = runsFlag > -1 ? Number(process.argv[runsFlag + 1]) || 1 : 1

// 1. The suite must be able to fail. A hook that lets everything through has to
//    fail every must-ask case.
const nullHook = [process.execPath, '-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))']
const nullFailures = runSuite(nullHook)
if (nullFailures.length !== MUST_ASK.length) {
  console.error(`FAIL: the planted pass-everything hook produced ${nullFailures.length} failures, expected ${MUST_ASK.length}. The suite cannot be trusted.`)
  process.exit(1)
}
console.log(`Planted hook check: the suite caught all ${MUST_ASK.length} misses on a hook that does nothing.`)

// 2. The real hook, repeated.
let allClean = true
for (let i = 1; i <= runs; i++) {
  const failures = runSuite([process.execPath, HOOK])
  if (failures.length) {
    allClean = false
    console.error(`Run ${i}: ${failures.length} failure(s)`)
    for (const f of failures) console.error(`  ${f}`)
  } else {
    console.log(`Run ${i}: ${MUST_ASK.length} must-ask and ${MUST_PASS.length} must-pass cases all correct.`)
  }
}
// 3. Your own commands. A temporary copy of the hook with one entry in
//    MY_COMMANDS must ask for that command however it is chained, and only it.
const tmp = path.join(os.tmpdir(), `charter-lock-mine-${process.pid}.mjs`)
const source = readFileSync(HOOK, 'utf8')
// Either line ending, since git may check the hook out with CRLF on Windows.
const withMine = source.replace(/const MY_COMMANDS = \[\r?\n\]/, "const MY_COMMANDS = [\n  'node send.mjs',\n]")
if (withMine === source) {
  console.error('FAIL: could not find the empty MY_COMMANDS list in the hook.')
  process.exit(1)
}
writeFileSync(tmp, withMine)
const MINE_ASK = [
  bash('node send.mjs dana@example.com "Re: Thursday"'),
  bash("cd studio && node send.mjs dana@example.com hi <<'EOF'\nHi Dana\nEOF"),
  bash('cat reply.txt | node send.mjs dana@example.com hi'),
  ps('Get-Content reply.txt | node send.mjs dana@example.com hi'),
]
const MINE_PASS = [bash('node check.mjs'), bash('cat send.mjs'), bash('node sender-test.mjs')]
for (let i = 1; i <= runs; i++) {
  const failures = []
  for (const call of MINE_ASK) {
    const { decision } = answer([process.execPath, tmp], call)
    if (decision !== 'ask') failures.push(`own command should ask, got ${decision}: ${JSON.stringify(call)}`)
  }
  for (const call of MINE_PASS) {
    const { decision } = answer([process.execPath, tmp], call)
    if (decision !== 'pass') failures.push(`own command should pass, got ${decision}: ${JSON.stringify(call)}`)
  }
  if (failures.length) {
    allClean = false
    console.error(`Own commands, run ${i}: ${failures.length} failure(s)`)
    for (const f of failures) console.error(`  ${f}`)
  } else {
    console.log(`Own commands, run ${i}: ${MINE_ASK.length} must-ask and ${MINE_PASS.length} must-pass cases all correct.`)
  }
}
rmSync(tmp, { force: true })

process.exit(allClean ? 0 : 1)
