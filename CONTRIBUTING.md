# Contributing

- Commits and PR titles follow [Conventional Commits](https://www.conventionalcommits.org): `feat(web): …`, `fix(cli): …`, `docs: …`. PRs are squash-merged, so the title becomes the commit on main and drives the release: `feat` → minor, `fix` → patch, a `BREAKING CHANGE:` footer → major.
- Keep PRs small. `npm run build` must pass; probes live in `docs/superpowers/plans/verify-*.sh`.
- The code is under the Functional Source License (see LICENSE). By contributing you agree your contribution is licensed the same way.
