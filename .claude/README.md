# `.claude/settings.json`: what each deny rule is for

JSON can't hold comments, so the explanations live here. Claude Code **enforces**
these rules: a matching tool call is refused before it runs. (Rules in `CLAUDE.md`
are only advice.) The file is committed, so every developer's Claude gets them.

**What this protects:** production holds the real business, and staging is shared.
Once the CI/CD setup is finished, both change only through GitHub Actions after a
pull request (and, for production, after the owner's approval click). Until then,
the owner applies migrations and deploys functions by hand, from their own
terminal. Either way, these rules stop Claude from changing either one from a
laptop, by any route.

Each command is listed twice, as `Bash(...)` and `PowerShell(...)`, because Claude
can run commands through either tool on this machine. A rule covers only the tool
it names. Rules match the command's *text*, so they are a strong guard, not a
guarantee. The `CLAUDE.md` rules and the habit of deploying only through CI still matter.

When a person really needs one of these commands (a one-off recovery), they run it
in their own terminal. These rules bind Claude only.

## Supabase MCP tools (any server name: `mcp__*__`)

| Rule | Allows instead | Protects against |
|---|---|---|
| `apply_migration` | Migrations as files in a PR, applied by CI | A schema change on a live database that git doesn't know about ("drift") |
| `deploy_edge_function` | Function code merged in git, deployed by CI | Running function code that matches no commit. Functions have no version history, so it can't be rolled back |
| `create_branch` / `merge_branch` / `reset_branch` / `rebase_branch` / `delete_branch` | Nothing for now: Supabase branches need a paid plan | Creating or wiping database branches (some of these cost money, some destroy data) |

The `*` in the name also catches a Supabase connector added later under another
name, such as one from claude.ai.

## Supabase CLI commands

| Rule | Protects against |
|---|---|
| `supabase db push` | Applying migrations from a laptop instead of CI |
| `supabase functions deploy` / `functions delete` | Deploying or removing a function outside CI |
| `supabase secrets set` / `secrets unset` | Changing a live function's secrets. The owner sets those in their own terminal, so the values never pass through Claude |
| `supabase migration repair` | Marking a migration as run when it wasn't, or the reverse. The next deploy then skips it or runs it twice |
| `supabase db pull` | It also writes a history row into the linked project (its prompt defaults to "yes") |
| `supabase db reset --linked / --remote / --db-url` | Wiping a **remote** database. A plain `supabase db reset` on the local stack is still allowed |
| `supabase migration squash --linked / --remote` | Rewriting a remote project's migration history |
| `supabase config push` | Pushing `supabase/config.toml` settings (auth, API, and so on) onto a live project. Added for Ori; the playbook doesn't list it |
| `*deploy*` with either project ID (`zvzq…` production, `owjg…` staging) | Any deploy command aimed directly at production or staging |

## GitHub

| Rule | Protects against |
|---|---|
| `pending_deployments` / `approveDeployments` | Approving a waiting production deploy through GitHub's API, which would skip the owner's approval click |

## Drizzle (added for Ori)

| Rule | Protects against |
|---|---|
| `db:migrate`, `drizzle-kit migrate`, `drizzle-kit push` | This laptop's `.env` points `DATABASE_URL` at the hosted **production** database, so any of these would change production directly. Production's Drizzle history also stops at 0033, so `migrate` would try to re-run 0034 onwards. These can go once the switch to Supabase CLI migrations is complete. |
