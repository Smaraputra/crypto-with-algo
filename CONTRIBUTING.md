# Contributing

Thanks for your interest in contributing. This document covers the local setup
and the conventions every change is expected to follow.

## Local Setup

Prerequisites: Node.js 18+, MongoDB 7+ (local or Atlas), and a Redis instance
(Upstash recommended).

```bash
git clone https://github.com/Smaraputra/crypto-with-algo.git
cd crypto-with-algo
npm install
cp .env.example .env.local   # then fill in your own values
docker-compose up -d         # start local MongoDB (required for E2E)
npm run dev
```

Never commit secrets. `.env*` files are gitignored except the
`.env.example` / `.env.production.example` templates.

## Workflow

1. Fork the repository and create a feature branch
   (`git checkout -b feature/your-feature`).
2. Make your change with accompanying tests.
3. Run the full check suite (below) and ensure it is green.
4. Commit using Conventional Commits.
5. Push and open a Pull Request describing the change and how you tested it.

## Required Checks

Every change must pass all of the following before it can be merged:

```bash
npm run lint        # zero ESLint errors
npm run typecheck   # zero TypeScript errors
npm run test        # all unit tests pass
npm run build       # clean production build
npm run test:e2e    # all E2E tests pass (requires docker-compose up -d)
```

## Commit Convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): description`.

Allowed types: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`.

Examples:

```
feat(signals): add RSI divergence detection
fix(auth): handle expired refresh token
test(backtest): cover walk-forward edge cases
```

## Testing Conventions

- Unit tests live alongside source (`src/lib/utils.ts` ->
  `src/lib/utils.test.ts`) using Vitest + Testing Library.
- E2E tests live in `e2e/` and use Playwright.
- Fixtures go in `src/__fixtures__/`, module mocks in `src/__mocks__/`.
- Add meaningful assertions; do not force-pass tests.
