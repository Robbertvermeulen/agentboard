# Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every merge to main that carries a `feat`/`fix` produces a GitHub release with notes, a version bump committed back, and a Docker image on GHCR tagged with the version. PR titles are validated as conventional commits. Nothing deploys.

**Architecture:** Two workflows. `ci.yml` (replaces `build.yml`) builds on PRs and pushes to main and validates PR titles. `release.yml` runs semantic-release on pushes to main via `cycjimmy/semantic-release-action`, then a second job builds and pushes `ghcr.io/robbertvermeulen/agentboard:<version>` and `:latest` when a release was published. Squash-merge only, so the PR title becomes the commit on main.

**Tech Stack:** GitHub Actions, semantic-release (angular preset), `@semantic-release/changelog`, `@semantic-release/git`, `docker/build-push-action`, GHCR.

**Spec:** `docs/superpowers/specs/2026-09-04-auth-deploy-release-update-design.md` — Part 3.

## Global Constraints

- Tag `v0.1.0` must exist on `main` **before** this PR merges, or the first release becomes `1.0.0`.
- The PR for this plan is a `ci:` commit: it must not release.
- Release commit message: `chore(release): ${nextRelease.version} [skip ci]` — the `[skip ci]` prevents a loop.
- Image name is fixed: `ghcr.io/robbertvermeulen/agentboard`. Platform `linux/amd64`.
- Conventional commits on branch `ci/release-pipeline` off `main`.

---

### Task 0: Tag the current main (operator step, before anything else)

- [ ] On `main`, up to date with origin:

```bash
git checkout main && git pull --ff-only
git tag -a v0.1.0 -m "v0.1.0 — the state before the release pipeline"
git push origin v0.1.0
git ls-remote --tags origin | grep v0.1.0
```

Expected: the tag is listed on origin.

---

### Task 1: CI workflow, PR-title check, CONTRIBUTING, badge

**Files:**
- Create: `.github/workflows/ci.yml`
- Delete: `.github/workflows/build.yml`
- Create: `CONTRIBUTING.md`
- Modify: `README.md:3` (badge URL)

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull --ff-only && git checkout -b ci/release-pipeline
```

- [ ] **Step 2: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build

  pr-title:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
    steps:
      - uses: amannn/action-semantic-pull-request@v5
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

```bash
git rm -q .github/workflows/build.yml
ruby -ryaml -e 'y = YAML.load_file(".github/workflows/ci.yml"); puts "ci.yml ok: #{y["jobs"].keys.join(",")}"'
```

Expected: `ci.yml ok: build,pr-title`.

- [ ] **Step 3: Badge URL in README**

In `README.md` line 3 replace both occurrences of `workflows/build.yml` with `workflows/ci.yml`:

```bash
perl -pi -e 's#workflows/build\.yml#workflows/ci.yml#g' README.md
grep -c 'workflows/ci.yml' README.md
```

Expected: `2`.

- [ ] **Step 4: Write `CONTRIBUTING.md`**

```markdown
# Contributing

- Commits and PR titles follow [Conventional Commits](https://www.conventionalcommits.org): `feat(web): …`, `fix(cli): …`, `docs: …`. PRs are squash-merged, so the title becomes the commit on main and drives the release: `feat` → minor, `fix` → patch, a `BREAKING CHANGE:` footer → major.
- Keep PRs small. `npm run build` must pass; probes live in `docs/superpowers/plans/verify-*.sh`.
- The code is under the Functional Source License (see LICENSE). By contributing you agree your contribution is licensed the same way.
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml CONTRIBUTING.md README.md
git commit -m "ci: ci workflow with pr-title check, contributing notes"
```

---

### Task 2: Release workflow and semantic-release config

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `.releaserc.json`

**Interfaces:**
- Produces: on a releasing push to main, tag `vX.Y.Z`, GitHub release, `CHANGELOG.md` + `package.json` bump committed, image `ghcr.io/robbertvermeulen/agentboard:X.Y.Z` and `:latest`.

- [ ] **Step 1: Write `.releaserc.json`**

```json
{
  "branches": ["main"],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/changelog", { "changelogFile": "CHANGELOG.md" }],
    ["@semantic-release/npm", { "npmPublish": false }],
    [
      "@semantic-release/git",
      {
        "assets": ["package.json", "package-lock.json", "CHANGELOG.md"],
        "message": "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
      }
    ],
    "@semantic-release/github"
  ]
}
```

- [ ] **Step 2: Write `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    branches: [main]

concurrency: release

permissions:
  contents: write
  issues: write
  pull-requests: write
  packages: write

jobs:
  release:
    runs-on: ubuntu-latest
    outputs:
      published: ${{ steps.semrel.outputs.new_release_published }}
      version: ${{ steps.semrel.outputs.new_release_version }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - id: semrel
        uses: cycjimmy/semantic-release-action@v4
        with:
          extra_plugins: |
            @semantic-release/changelog
            @semantic-release/git
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  image:
    needs: release
    if: needs.release.outputs.published == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: v${{ needs.release.outputs.version }}
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64
          push: true
          tags: |
            ghcr.io/robbertvermeulen/agentboard:${{ needs.release.outputs.version }}
            ghcr.io/robbertvermeulen/agentboard:latest
```

- [ ] **Step 3: Validate**

```bash
ruby -ryaml -e 'y = YAML.load_file(".github/workflows/release.yml"); puts "release.yml ok: #{y["jobs"].keys.join(",")}"'
node -e 'JSON.parse(require("fs").readFileSync(".releaserc.json","utf8")); console.log(".releaserc.json ok")'
test -f Dockerfile && echo "Dockerfile present (PR 2 merged)" || echo "WARNING: Dockerfile missing — merge PR 2 before the first release"
```

Expected: both `ok` lines; the Dockerfile line says present.

- [ ] **Step 4: Commit**

```bash
git add .releaserc.json .github/workflows/release.yml
git commit -m "ci: semantic-release with changelog, version bump and ghcr image per release"
```

---

### Task 3: Repo settings (operator step)

- [ ] Squash-merge only, PR title as commit title:

```bash
gh api -X PATCH repos/Robbertvermeulen/agentboard \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
  --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, squash_merge_commit_title}'
```

Expected: squash true, merge/rebase false, title `PR_TITLE`.

- [ ] Actions must be allowed to create releases and push: Settings → Actions → General → Workflow permissions → "Read and write permissions" (or `gh api -X PUT repos/Robbertvermeulen/agentboard/actions/permissions/workflow -f default_workflow_permissions=write -F can_approve_pull_request_reviews=false`).

---

### Task 4: PR and the first release

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin ci/release-pipeline
gh pr create --title "ci: release pipeline with semantic-release and GHCR image" --body "$(cat <<'EOF'
Release pipeline — spec Part 3 (docs/superpowers/specs/2026-09-04-auth-deploy-release-update-design.md).

- ci.yml replaces build.yml: build on PRs and main, PR title validated as a conventional commit
- release.yml: semantic-release on main (angular preset, CHANGELOG + package.json bump committed with [skip ci]), then an image job pushing ghcr.io/robbertvermeulen/agentboard:<version> and :latest
- CONTRIBUTING.md
- Tag v0.1.0 is on main, so the first release will be 0.2.0

This PR is a `ci:` change and must not release anything.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: the `pr-title` check passes on this PR.

- [ ] **Step 2: After merge, confirm nothing released**

```bash
gh run list --workflow release.yml --limit 1
gh release list --limit 1
```

Expected: the Release run succeeded and `gh release list` is still empty (a `ci:` commit releases nothing).

- [ ] **Step 3: After the first `feat`/`fix` merge (PR 4), confirm the release**

```bash
gh release list --limit 1                       # v0.2.0
git pull --ff-only && head -5 CHANGELOG.md      # 0.2.0 section
gh api /users/Robbertvermeulen/packages/container/agentboard/versions --jq '.[0].metadata.container.tags'
```

Expected: `v0.2.0`, a changelog, tags `["0.2.0","latest"]`.

- [ ] **Step 4: Make the GHCR package public (once)**

The first push creates a private package. In GitHub: profile → Packages → `agentboard` → Package settings → Change visibility → Public. Then, from anywhere without credentials:

```bash
docker manifest inspect ghcr.io/robbertvermeulen/agentboard:latest >/dev/null && echo "public pull ok"
```

Expected: `public pull ok` (or, without Docker, `curl -s https://ghcr.io/v2/robbertvermeulen/agentboard/tags/list` returns a token challenge rather than 404). Note the outcome in `docs/deploy.md` under "Day two".
