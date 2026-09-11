#!/usr/bin/env node
/**
 * figma-comments — read Figma review comments, render the frames they point at,
 * reply in-thread, and mark threads handled.
 *
 * Built so a design review can happen in Figma while the work happens in Claude
 * Code, instead of copy-pasting node URLs between two windows.
 *
 * SCOPE
 *   Comments only. That is the one part of the loop the Figma MCP servers do not
 *   expose — they have no comment tools at all.
 *
 *   This cannot edit the design, and that is a property of Figma, not of this
 *   script: the REST API is read-only for design content, permanently, for every
 *   client. Design edits go through the Figma MCP `use_figma` tool, which drives
 *   the Plugin API instead. Two different mechanisms; don't conflate them.
 *
 * ENV
 *   FIGMA_API_KEY        required — personal access token (Settings › Security)
 *                        scopes: current_user:read, file_comments:read,
 *                                file_comments:write, file_content:read
 *   FIGMA_FILE_KEY       required unless --file is passed
 *   FIGMA_COMMENT_TOKEN  optional — token for a dedicated Claude account, used
 *                        for replies/acks only so they carry their own author
 *                        line. A Viewer seat is enough. Falls back to
 *                        FIGMA_API_KEY, in which case replies are badged.
 *
 * USAGE
 *   node figma-comments.mjs list  [--from me|any|handle,handle] [--marker @claude] [--all]
 *   node figma-comments.mjs show  <comment_id> [--render]
 *   node figma-comments.mjs reply <comment_id> "message"
 *   node figma-comments.mjs ack   <comment_id> [:shortcode:]
 *
 *   --file <key>  overrides FIGMA_FILE_KEY. The key is the segment after
 *                 /design/ in a Figma URL:
 *                 figma.com/design/<FILE_KEY>/Name?node-id=1-2
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Read a flag from argv directly — needed before the arg parser runs. */
function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : null
}

const TOKEN = process.env.FIGMA_API_KEY
const FILE_KEY = argValue('--file') || process.env.FIGMA_FILE_KEY
const API = 'https://api.figma.com/v1'

/**
 * Optional second token belonging to a dedicated Claude account, used for
 * REPLIES ONLY so they carry their own author line instead of the operator's.
 *
 * Kept separate from FIGMA_API_KEY rather than replacing it: that account only
 * needs a Viewer seat and may have narrower file access, so reads stay on the
 * operator's token and keep working even if the bot account can't see
 * everything. A permissions gap can then only break a reply — loudly — instead
 * of silently posting under the wrong identity.
 */
const REPLY_TOKEN = process.env.FIGMA_COMMENT_TOKEN || TOKEN

/** Appended to every reply so a sweep can tell answered threads from new ones. */
const SIGNATURE = '— via Claude Code'

/**
 * Leading badge used when replying with a HUMAN's token.
 *
 * Figma owns the author line and it can't be changed, so a reply posted with the
 * operator's token renders as that person talking to themselves — the trailing
 * signature sits below the fold in most comment UIs. The badge goes first so the
 * attribution is legible before anyone expands anything.
 *
 * Skipped automatically when the token belongs to a dedicated Claude account,
 * because then the author line already says so.
 */
const BADGE = '[@claude]'

/**
 * Reaction used to mark a thread handled without posting a reply.
 *
 * Figma's REST API has no resolve endpoint — GET/POST comments, DELETE comment,
 * and reactions are the entire surface — so a reaction is the only Figma-native
 * status that can be written. It covers the case a reply handles badly: a
 * comment that needs acknowledging but not a paragraph. Resolving stays a human
 * judgment, which is the right place for it.
 *
 * MUST be a shortcode, not a literal emoji character — the API rejects the raw
 * glyph. Valid codes come from emoji-mart's native.json set.
 */
const ACK_EMOJI = ':white_check_mark:'

if (!TOKEN) {
  console.error(
    'FIGMA_API_KEY is not set.\n' +
    'Create a token at Figma › Settings › Security › personal access tokens with\n' +
    'scopes: current_user:read, file_comments:read, file_comments:write, file_content:read'
  )
  process.exit(1)
}

if (!FILE_KEY) {
  console.error(
    'No Figma file specified. Set FIGMA_FILE_KEY or pass --file <key>.\n' +
    'The key is the segment after /design/ in the URL:\n' +
    '  figma.com/design/<FILE_KEY>/Some-Name?node-id=1-2'
  )
  process.exit(1)
}

/** Retries on 429 before giving up. Figma's write limit is low enough that a
 *  sweep replying to a handful of threads in a row will hit it. */
const MAX_RETRIES = 4

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(path, init = {}, token = TOKEN, attempt = 0) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'X-Figma-Token': token, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })

  if (res.status === 429 && attempt < MAX_RETRIES) {
    // Honour Retry-After when Figma sends one; otherwise back off exponentially.
    const hinted = Number(res.headers.get('retry-after'))
    const wait = hinted > 0 ? hinted * 1000 : Math.min(2000 * 2 ** attempt, 30000)
    console.error(`  rate limited on ${path} — waiting ${wait / 1000}s (retry ${attempt + 1}/${MAX_RETRIES})`)
    await sleep(wait)
    return api(path, init, token, attempt + 1)
  }

  if (!res.ok) {
    throw new Error(`Figma API ${res.status} ${res.statusText} on ${path}\n${await res.text()}`)
  }
  return res.json()
}

const fetchComments = () => api(`/files/${FILE_KEY}/comments`).then((d) => d.comments || [])

/** Threads = top-level comments plus their replies (replies carry parent_id). */
function buildThreads(comments) {
  const roots = comments.filter((c) => !c.parent_id)
  const repliesByParent = new Map()
  for (const c of comments) {
    if (!c.parent_id) continue
    if (!repliesByParent.has(c.parent_id)) repliesByParent.set(c.parent_id, [])
    repliesByParent.get(c.parent_id).push(c)
  }
  return roots.map((root) => ({ root, replies: repliesByParent.get(root.id) || [] }))
}

const isClaudeAccount = (handle) => /claude/i.test(handle || '')

/**
 * Was this reply ours? Author handle first — it's structural and survives any
 * edit to the message. The text markers remain as fallback for replies posted
 * through a human's token, where the author line can't tell us anything.
 */
const isClaudeReply = (r) => {
  if (isClaudeAccount(r.user?.handle)) return true
  const m = r.message || ''
  return m.includes(SIGNATURE) || m.startsWith(BADGE)
}

/** Did the account we post as already ack this thread? */
const hasAck = (comment, selfHandle) =>
  (comment.reactions || []).some(
    (r) =>
      r.emoji === ACK_EMOJI &&
      (isClaudeAccount(r.user?.handle) || (selfHandle && r.user?.handle === selfHandle))
  )

/**
 * A thread is settled only when Claude's reply is the LAST one.
 *
 * Checking "did Claude reply at all" is the bug every implementation of this
 * shape starts with: the moment someone follows up ("actually, do it this way"),
 * the thread flips to answered and the correction is never swept again. It looks
 * identical to a healthy sweep, which is what makes it dangerous.
 *
 *   NEW        nobody from our side has answered
 *   FOLLOW-UP  Claude answered, then a human replied again — highest priority
 *   acked      Claude reacted, no reply needed
 *   answered   Claude's reply is the most recent word
 *   resolved   a human hit Figma's resolve button
 */
/** A thread WE started via `note` — we own the follow-up on it. */
const isOwnThread = (thread) => isClaudeAccount(thread.root.user?.handle)

function threadState(thread, selfHandle) {
  // Figma's own resolve button is the strongest signal there is — a human has
  // explicitly closed this out. It wins over any bookkeeping of ours.
  if (thread.root.resolved_at) return 'resolved'

  if (thread.replies.length) {
    const byTime = [...thread.replies].sort(
      (a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0)
    )
    if (isClaudeReply(byTime[byTime.length - 1])) return 'answered'
    // On a thread we started, any reply is by definition a response to us.
    return isOwnThread(thread) || thread.replies.some(isClaudeReply) ? 'FOLLOW-UP' : 'NEW'
  }

  // We asked, nobody has answered yet — theirs to act on, not ours.
  if (isOwnThread(thread)) return 'awaiting'

  // Acked but never replied to — seen, nothing to say. Checked after replies so
  // a human following up on an acked thread still surfaces.
  if (hasAck(thread.root, selfHandle)) return 'acked'
  return 'NEW'
}

const NEEDS_ATTENTION = new Set(['NEW', 'FOLLOW-UP'])

/** Who will the reply post as? Decides whether it needs the badge. */
async function identity() {
  try {
    return (await api('/me', {}, REPLY_TOKEN)).handle || null
  } catch {
    return null // /me is a nicety; never block a reply on it
  }
}

/** Whose machine and credentials is this running on? Drives the author filter. */
async function operatorIdentity() {
  try {
    return (await api('/me', {}, TOKEN)).handle || null
  } catch {
    return null
  }
}

/**
 * Whose comments should this sweep act on? Defaults to the operator's own.
 *
 * On a shared file, actioning a collaborator's comment means their text becomes
 * work executed on YOUR machine with YOUR repo and Figma credentials, replying
 * under YOUR account. That is a decision to make explicitly per person, not a
 * side effect of sharing a file. Widen with `--from someone,else` or
 * `--from any` when that is what you want.
 */
function authorAllowed(handle, from, operator) {
  if (from === 'any') return true
  const h = (handle || '').toLowerCase()
  if (from === 'me') return !!operator && h === operator.toLowerCase()
  return from.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).includes(h)
}

function line(thread, { showAnswered, selfHandle }) {
  const { root } = thread
  const node = root.client_meta?.node_id
  const state = threadState(thread, selfHandle)
  if (!NEEDS_ATTENTION.has(state) && !showAnswered) return null
  return [
    `  [${state}] ${root.id}`,
    `     node:   ${node || '(unpinned)'}`,
    `     from:   ${root.user?.handle || '?'}  ${root.created_at || ''}`,
    `     says:   ${JSON.stringify((root.message || '').replace(/\s+/g, ' ').slice(0, 160))}`,
    thread.replies.length ? `     replies: ${thread.replies.length}` : null,
  ].filter(Boolean).join('\n')
}

/** Levenshtein distance. Small inputs only — this compares @-tokens. */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * Threads whose @-token is *nearly* the marker — "@cluade", "@clade", "@caude".
 *
 * Figma comments carry no structured mention data — every mention, real users
 * included, is plain text in `message`. So there is no autocomplete and no
 * validation, and a typo drops the thread from the sweep silently. "You typed it
 * wrong" then looks exactly like "nothing new", and the comment simply never
 * gets answered. Surfacing near misses turns that into a warning.
 */
function nearMisses(comments, marker) {
  const want = marker.replace(/^@/, '').toLowerCase()
  const hits = []
  for (const c of comments) {
    if (c.parent_id) continue
    const msg = c.message || ''
    if (msg.toLowerCase().includes(marker.toLowerCase())) continue // matched properly
    for (const [, token] of msg.matchAll(/@([\w.-]+)/g)) {
      const dist = editDistance(token.toLowerCase(), want)
      if (dist > 0 && dist <= 2) {
        hits.push({ id: c.id, token, msg: msg.replace(/\s+/g, ' ').slice(0, 90) })
      }
    }
  }
  return hits
}

async function cmdList(args) {
  const marker = valueFor(args, '--marker') || '@claude'
  const showAnswered = args.includes('--all')
  const from = valueFor(args, '--from') || 'me'
  const comments = await fetchComments()
  const selfHandle = await identity() // so an ack posted under either tier counts
  const operator = await operatorIdentity()

  // Threads we started count regardless of marker or author filter — a `note`
  // addressed to someone else won't contain the marker, and its author is us,
  // so both filters would otherwise hide replies to our own questions.
  const tagged = buildThreads(comments).filter(
    (t) => isOwnThread(t) || (t.root.message || '').toLowerCase().includes(marker.toLowerCase())
  )

  const threads = tagged.filter((t) => isOwnThread(t) || authorAllowed(t.root.user?.handle, from, operator))
  const withheld = tagged.filter((t) => !threads.includes(t))

  const open = threads.filter((t) => NEEDS_ATTENTION.has(threadState(t, selfHandle))).length
  console.log(`Figma comments mentioning "${marker}" in ${FILE_KEY}`)
  console.log(`(${open} need attention, ${threads.length} total — from: ${from}${from === 'me' && operator ? ` = ${operator}` : ''})\n`)

  const out = threads.map((t) => line(t, { showAnswered, selfHandle })).filter(Boolean)
  console.log(out.length ? out.join('\n\n') : '  Nothing open. Use --all to include settled threads.')

  if (withheld.length) {
    const who = [...new Set(withheld.map((t) => t.root.user?.handle || '?'))]
    console.log(
      `\n${withheld.length} thread(s) addressed to Claude by others (${who.join(', ')}) — NOT swept.` +
      `\n   Acting on them runs their instructions under your credentials.` +
      `\n   Include deliberately: --from ${who.join(',')}   (or --from any)`
    )
  }

  const typos = nearMisses(comments, marker)
  if (typos.length) {
    console.log(`\n⚠  ${typos.length} comment(s) look like a mistyped "${marker}" and were NOT swept:`)
    for (const t of typos) {
      console.log(`     @${t.token}  (${t.id})\n     ${JSON.stringify(t.msg)}`)
    }
  }
}

async function cmdShow(args) {
  const id = args[0]
  if (!id) throw new Error('usage: show <comment_id> [--render]')

  const threads = buildThreads(await fetchComments())
  const thread = threads.find((t) => t.root.id === id)
  if (!thread) throw new Error(`No thread with id ${id}`)

  const { root } = thread
  const nodeId = root.client_meta?.node_id
  console.log(`from:  ${root.user?.handle || '?'}`)
  console.log(`node:  ${nodeId || '(unpinned)'}`)
  console.log(`\n${root.message}\n`)

  for (const r of thread.replies) {
    console.log(`  ↳ ${r.user?.handle || '?'}: ${(r.message || '').slice(0, 200)}`)
  }

  if (!nodeId) return

  const meta = await api(`/files/${FILE_KEY}/nodes?ids=${encodeURIComponent(nodeId)}&depth=1`)
  const doc = Object.values(meta.nodes || {})[0]?.document
  if (doc) {
    const b = doc.absoluteBoundingBox
    console.log(`\nframe: "${doc.name}" [${doc.type}]${b ? ` ${Math.round(b.width)}x${Math.round(b.height)}` : ''}`)
  }

  if (args.includes('--render')) {
    const img = await api(`/images/${FILE_KEY}?ids=${encodeURIComponent(nodeId)}&format=png&scale=2`)
    const url = Object.values(img.images || {})[0]
    if (!url) return console.log('render: node is not renderable')
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
    const out = `${process.env.TMPDIR || '/tmp'}/figma-comment-${id.replace(/\W/g, '')}.png`
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, buf)
    console.log(`render: ${out}`)
  }
}

async function cmdReply(args) {
  const [id, ...rest] = args
  const message = rest.join(' ').trim()
  if (!id || !message) throw new Error('usage: reply <comment_id> "message"')

  // POSTS TO A SHARED FILE — collaborators are notified. Confirm before use.
  const handle = await identity()
  const badged = isClaudeAccount(handle) ? message : `${BADGE} ${message}`

  const body = { message: `${badged}\n\n${SIGNATURE}`, comment_id: id }
  const created = await api(
    `/files/${FILE_KEY}/comments`,
    { method: 'POST', body: JSON.stringify(body) },
    REPLY_TOKEN
  )

  console.log(`replied to ${id} (new comment ${created.id})`)
  console.log(`posting as: ${handle || 'unknown'}${isClaudeAccount(handle) ? '' : ` — badged "${BADGE}"`}`)
}

/**
 * Mark a thread handled without replying — "seen, nothing to change".
 * Posts as REPLY_TOKEN's owner, so with a dedicated account the ✅ shows as
 * Claude's, which also lets multiple operators see a thread is already claimed.
 */
async function cmdAck(args) {
  const [id, emoji] = args
  if (!id) throw new Error('usage: ack <comment_id> [:shortcode:]')

  const code = emoji || ACK_EMOJI
  if (!/^:[a-z0-9_+-]+:(:skin-tone-\d:)?$/i.test(code)) {
    throw new Error(`emoji must be a shortcode like ":eyes:", got ${JSON.stringify(code)}`)
  }

  await api(
    `/files/${FILE_KEY}/comments/${id}/reactions`,
    { method: 'POST', body: JSON.stringify({ emoji: code }) },
    REPLY_TOKEN
  )
  console.log(`acked ${id} with ${code} (as ${(await identity()) || 'unknown'})`)
}

/**
 * Start a NEW thread pinned to a node — the counterpart to `reply`.
 *
 * Used to raise something proactively (handing a screen to a designer, flagging
 * a defect) rather than answering an existing thread. Pin position defaults to
 * the node's top-left area so the marker is visible without hunting.
 */
async function cmdNote(args) {
  const [nodeId, ...rest] = args
  const message = rest.filter((a, i) => !['--at'].includes(rest[i - 1]) && a !== '--at').join(' ').trim()
  if (!nodeId || !message) throw new Error('usage: note <node_id> "message" [--at x,y]')
  if (!/^\d+[:-]\d+$/.test(nodeId)) throw new Error(`node id looks wrong: ${nodeId} (expected like 123:456)`)

  const at = (valueFor(args, '--at') || '60,60').split(',').map(Number)
  const handle = await identity()
  const badged = isClaudeAccount(handle) ? message : `${BADGE} ${message}`

  const body = {
    message: `${badged}\n\n${SIGNATURE}`,
    client_meta: { node_id: nodeId.replace('-', ':'), node_offset: { x: at[0], y: at[1] } },
  }
  const created = await api(
    `/files/${FILE_KEY}/comments`,
    { method: 'POST', body: JSON.stringify(body) },
    REPLY_TOKEN
  )
  console.log(`posted note ${created.id} on node ${nodeId} (as ${handle || 'unknown'})`)
}

function valueFor(args, flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] : null
}

const [cmd, ...args] = process.argv.slice(2)
const commands = { list: cmdList, show: cmdShow, reply: cmdReply, ack: cmdAck, note: cmdNote }

if (!commands[cmd]) {
  console.log(
    'commands: list | show <id> [--render] | reply <id> "message" | ack <id> [:emoji:]\n' +
    '          note <node_id> "message" [--at x,y]'
  )
  process.exit(cmd ? 1 : 0)
}

commands[cmd](args).catch((err) => {
  console.error(err.message)
  process.exit(1)
})
