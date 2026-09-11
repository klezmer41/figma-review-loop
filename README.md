# figma-review-loop

**Bring Claude Code into your Figma comments like any other collaborator — tag it (@Claude), it does the work, it replies in the thread.**

Leave a comment in Figma, tag `@claude`, and Claude Code picks it up, does the
work — in code, or in the Figma file itself — and replies in the thread. You
review where you already review; the agent answers where you asked.

```
@claude the Change link isn't clear enough that it's a link
```

```
↳ Claude: Underlined on both boards, matching the existing link treatment —
  body-text colour with an underline, accent colour on hover. Change was at
  70% opacity, which would have read washed out once underlined, so it's at
  100% now.
```

Built for a solo developer working with a designer in a shared file, and used
daily for weeks before publishing. It is a small Node script plus a skill; no
server, no daemon, no framework.

## How you use it

1. Review in Figma the way you already do. Leave comments on frames as you go,
   and tag `@claude` in the ones you want acted on.
2. In Claude Code, say **"please catch up on Figma comments"** (or run
   `/figma-review`).
3. Claude lists what's new, works through each thread — reads the frame, makes
   the change in code or in the Figma file — and replies in-thread.
4. Reply in Figma to anything that isn't right. On the next sweep those come up
   first, as FOLLOW-UP.

That's the whole loop. Nothing runs in the background: a sweep happens when
you ask for one, or on `/loop 10m /figma-review` during a live review session.

## What it does

| Command | |
|---|---|
| `check` | setup state, one line per thing, with the fix — runs with nothing configured |
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
human — an account whose display name contains "Claude" is the agent; anything
else is a person. Prefer a per-organisation account over a shared one — a
shared account would need standing access to every user's private files.

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

## Install

```
/plugin marketplace add klezmer41/figma-review-loop
/plugin install figma-review-loop@figma-review-loop
```

## Setup

**The short version: ask.** Tell Claude Code *"help me set up
figma-review-loop"*. It runs `check`, sees what's missing, and walks you through
the rest one step at a time. The only things it can't do for you are sign up for
an account and generate a token — and you never paste a token into chat; it goes
in a gitignored file, and Claude confirms it works. Most of the hurdle with
tools like this is not knowing how much of the setup you can hand off. All of it,
except the clicks that need to be you.

What follows is what that conversation covers, for doing it by hand.

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

1. **Create an email address for Claude.** A plus address is enough:
   `you+claude@gmail.com` lands in your own inbox, and Figma treats it as a
   separate person. Gmail, Outlook.com, iCloud and Fastmail all support this;
   if your provider doesn't, a catch-all on your own domain or a free mailbox
   works. No admin needed — the address only has to receive Figma's
   verification email.
2. **Create the Figma account.** Sign up at figma.com with that address, in a
   private window so you stay logged in as yourself. **Put "Claude" in the
   name** — plain `Claude` is fine. The script recognises the agent by that
   word in the display name; without it, every reply is badged as if a person
   posted it.
3. **Add Claude to the file.** Share → the agent's email → *can view*. A
   **Viewer** seat can comment; verified. Do this per file, or add the account
   to the team or project as a viewer. Skip it and reads 403 regardless of
   scopes.
4. **Generate a token on Claude's account.** Log in as the agent → Settings →
   Security → *Personal access tokens*, same four scopes as tier 0, same
   expiration warning. Add it alongside your own:

   ```json
   { "env": { "FIGMA_COMMENT_TOKEN": "figd_…" } }
   ```

5. **Check it.** `node figma-comments.mjs check` should end with
   `Tier 1 ready — reads as You, replies as Claude`. It verifies the name from
   step 2 and the file access from step 3 without posting anything.

Reads stay on your token; replies and acks post under the agent's. Kept
separate deliberately — the agent account may see less, so a permissions gap
can only break a reply (loudly, with a 403) rather than silently posting as you.

`node figma-comments.mjs check` at any point shows where you are:

```
  FIGMA_API_KEY        ✓ Ann Example
  FIGMA_FILE_KEY       ✓ AbC123… — 42 comments readable
  FIGMA_COMMENT_TOKEN  ✗ account is named "Design Bot" — the name must contain "Claude"
                         or every reply is badged as if a person posted it. Rename it in Figma › Settings.

Not ready — fix the ✗ items above, then run check again.
```

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
