# figma-review-loop

**Bring Claude Code into your Figma comments like any other collaborator — tag it (@Claude), it does the work, it replies in the thread.**

Leave a comment in Figma, tag `@claude`, and Claude Code picks it up, does the
work — in code, or in the Figma file itself — and replies in the thread. You
review where you already review; the agent answers where you asked.

```
@claude the Change link isn't clear enough that it's a link
```

```
↳ Claude: Underlined on both boards, matching the Details treatment exactly —
  full ink with an underline, rust on hover. Change was at 70% opacity, which
  would have read washed out once underlined, so it's at 100% now.
```

Built for a solo developer working with a designer in a shared file, and used
daily for weeks before publishing. It is a small Node script plus a skill; no
server, no daemon, no framework.

## What it does

| Command | |
|---|---|
| `list` | threads that need attention — new, or a human replied after Claude did |
| `show <id> --render` | the comment, its replies, and a PNG of the frame it's pinned to |
| `reply <id> "…"` | reply in-thread |
| `ack <id>` | react ✅ — "seen, nothing to change" — without posting a paragraph |
| `note <node> "…"` | start a new thread pinned to a node (handing a screen to a designer, flagging a defect) |

Thread state is tracked so a sweep is idempotent:

| State | Meaning |
|---|---|
| **NEW** | nobody from our side has answered |
| **FOLLOW-UP** | Claude answered, then a human replied again — highest priority |
| acked | Claude reacted ✅ |
| answered | Claude's reply is the newest |
| awaiting | Claude started the thread and nobody has replied |
| resolved | a human hit Figma's resolve button |

**FOLLOW-UP is the state every naive implementation gets wrong.** Checking "did
Claude reply" instead of "is the *newest* reply Claude's" silently swallows every
correction a reviewer makes after the first answer — and it looks identical to a
healthy sweep. This tool compares timestamps.

## Who the reply appears to be from

Figma owns the author line. A reply posted with your token renders as **you
talking to yourself**, and your collaborators can't tell it was the agent.
Worse, Figma suppresses notifications for your own comments, so you never learn
the reply landed.

Other tools have removed reply support over exactly this. The fix is a
dedicated account:

| Token belongs to | Reply renders as | You get notified |
|---|---|---|
| a dedicated Claude account (**Viewer seat is enough**) | `Claude: …` | yes |
| you (the fallback) | `You: [@claude] …` | no |

The script checks `GET /v1/me` and badges automatically when it's posting as a
human. Prefer a per-organisation account over a shared one — a shared account
would need standing access to every user's private files.

## On a shared file: whose comments get actioned

**Default is your own comments only.** Acting on a collaborator's comment means
their text becomes work executed on *your* machine, with *your* repo and Figma
credentials. That's a per-person decision, not a side effect of sharing a file.

```bash
node figma-comments.mjs list                   # yours
node figma-comments.mjs list --from ann,bob    # opt in to named people
node figma-comments.mjs list --from any        # everyone
```

Withheld threads are still reported — author and the exact flag to include
them — so nothing is hidden, it just isn't acted on silently. Widening scope
does **not** widen what a comment may ask for: comments are design and code
intent, not a command channel.

## Setup

**Tier 0 — about a minute.** Works immediately, replies badged under your name.

1. Figma → Settings → Security → *Personal access tokens*. Scopes:
   `current_user:read`, `file_comments:read`, `file_comments:write`,
   `file_content:read`. Nothing else. **Watch the expiration — it defaults to
   1 day.**
2. Set the env vars — in `.claude/settings.local.json` under `env` (gitignored),
   or your shell:

   ```json
   { "env": { "FIGMA_API_KEY": "figd_…", "FIGMA_FILE_KEY": "…" } }
   ```

   The file key is the segment after `/design/` in a Figma URL.

**Tier 1 — about ten minutes.** A dedicated account, for clean attribution and
real notifications.

1. Create a Figma account for the agent (`you+claude@…` works on most mail
   providers — no admin needed). A **Viewer** seat can comment; verified.
2. Give it access to the file, or reads 403 regardless of scopes.
3. Generate a token on *that* account, same four scopes, and add it:

   ```json
   { "env": { "FIGMA_COMMENT_TOKEN": "figd_…" } }
   ```

Reads stay on your token; replies and acks post under the agent's. Kept
separate deliberately — the agent account may see less, so a permissions gap
can only break a reply (loudly, with a 403) rather than silently posting as you.

### Install

```
/plugin marketplace add klezmer41/figma-review-loop
/plugin install figma-review-loop@figma-review-loop
```

Then `/figma-review` in any project, or `/loop 10m /figma-review` while a
review is in progress.

## What it can and can't do

- **Read comments** — yes, via REST. This is the one thing the Figma MCP servers
  don't expose; it's why the script exists.
- **Edit the Figma design** — through the Figma MCP's `use_figma`, not this
  script. Figma's REST API is read-only for design content, for every client,
  permanently.
- **Resolve threads** — no. The REST API has no resolve endpoint (comments,
  reactions, delete — that's the whole surface). `ack` uses a reaction instead,
  and resolving stays a human judgment, which is where it belongs.
- **Push notifications** — no. It's a sweep, run when you ask or on `/loop`.
  Figma has a `FILE_COMMENT` webhook if you want true push; that needs a server.

## Things learned the hard way

- Figma comments carry **no structured mention data** — every mention, real
  users included, is plain text. A dedicated account buys nothing for reading;
  matching is a substring either way. It buys attribution and notifications.
- A typo in the marker (`@cluade`) drops a thread **silently**, indistinguishable
  from "nothing new". `list` flags near-miss markers as warnings.
- Threads the agent *starts* won't contain the marker and aren't authored by
  you, so both filters would hide replies to your own questions. They're always
  in scope.
- Figma's write limit is low — around nine comments in a burst returned 429.
  The script retries with `Retry-After`, then exponential backoff.
- Figma paint entries carry a `visible` flag, and the API returns hidden
  strokes exactly like visible ones. Render before judging a design from its
  node tree.

## Status

Built for one workflow and shared as-is. It works; it is not a product. Issues
welcome, no support promised.

MIT.
