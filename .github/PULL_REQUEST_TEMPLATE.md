## What does this change?

<!-- One or two sentences. Link the issue it closes, if any. -->

Closes #

## Type

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / internal change
- [ ] Documentation

## How was it tested?

<!-- Be specific: which command, which scenario, what did you observe? -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Docker E2E (`npm run test:e2e`) — only needed for container/deploy changes
- [ ] Manual check in the browser

## Checklist

- [ ] The change is focused (one topic) and the diff is as small as it can be.
- [ ] Behaviour changes come with tests (backend, frontend render, or end-to-end).
- [ ] No secrets, tokens, real IP addresses, databases or application data are included.
- [ ] Documentation updated when user-visible behaviour changed (`README.md`, `docs/`).
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]`.
- [ ] The backend stays the source of truth (the frontend does not talk to Docker directly).
