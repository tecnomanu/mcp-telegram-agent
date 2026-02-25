# AGENTS.md

Project-wide rules for AI coding agents working in this repository.

## Scope

- Apply these rules to the whole repository.
- If another local rule file exists in a subfolder, the most specific file wins for that subfolder.

## Main Policy

- `main` is the release branch.
- Pushing to `main` triggers automated release/publish flow.
- Do not push direct changes to `main` for normal feature/fix work.

## Branch Strategy (GitHub)

```text
feature/*  ---> Pull Request ---> main
fix/*      ---> Pull Request ---> main
hotfix/*   ---> main (emergencies only)
```

Rules:
- Use a separate branch for each responsibility.
- Do not mix unrelated tasks in the same branch.
- If a new request is unrelated, propose creating a new branch.
- Use `hotfix/*` only for urgent production issues.

## Commit Rules

- Use Conventional Commits in English.
- Add a relevant emoji in the subject.
- Keep commit scope clear and focused.

Format:

```text
type(scope): emoji short description
```

Examples:
- `feat(onboarding): ✨ add setup-code verification fallback`
- `fix(ci): 🐛 use CI-safe test glob`
- `docs(readme): 📝 add agent-first entrypoint`
- `test(mcp): ✅ add onboarding integration test`
- `chore(workflow): 🔧 adjust release pipeline`

## Quality Gates (Required)

Before creating PR or pushing important changes, run:

```bash
npm run check
npm run build
npm run test
```

Rules:
- Keep tests green.
- If behavior changes, update/add tests.
- Never skip tests silently.

## Release Rules

- Do not create manual releases unless explicitly requested by the user.
- Respect existing automation in `.github/workflows/release.yml`.
- Use commit types intentionally (`feat`, `fix`, `docs`, `test`, `chore`) since release logic depends on commits.

## Security Rules

- Never expose full secrets/tokens in logs or final responses unless user explicitly asks.
- Prefer masked token output in explanations.

## Mandatory Onboarding Behavior

- If user asks to install/configure this MCP, do not stop at explanation.
- Execute the onboarding flow with tools and ask only the required confirmations.
- Always require explicit `chat_id` confirmation before finalizing onboarding and sending test notifications.

## Agent Onboarding Command Guide

For the Telegram MCP setup command flow, read:

- [AGENT_SETUP.md](./AGENT_SETUP.md)
- [.cursor/commands/setup-mcp-telegram-agent.md](./.cursor/commands/setup-mcp-telegram-agent.md)
