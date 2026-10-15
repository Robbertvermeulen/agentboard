# Stage 1: build. better-sqlite3 compiles a native module when no prebuilt
# binary matches the platform, so the builder carries the toolchain; the
# runtime image below does not.
FROM node:22-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json AGENT.md ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

# Stage 2: runtime. git: the context repo (simple-git). openssh-client: the
# agent reaches client servers. gh: issues and pull requests on GitHub. gosu:
# drop root in start.sh. Claude Code: the default session command.
FROM node:22-bookworm-slim
# Fixed path, independent of HOME: the install below runs as root, the app
# later runs as node (gosu drop in start.sh) -- a HOME-relative default
# (~/.cache/ms-playwright) would put the browser where only root can see it.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl gosu \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@2.1.260
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web ./web
COPY --from=build /app/AGENT.md ./AGENT.md
COPY bin ./bin
# Browser binary for the native Playwright MCP tool (issue #107): baked into
# the image so every session pays this cost at build time, not a lazy
# first-use install with unpredictable latency inside a random session.
RUN npx playwright install --with-deps chromium \
 && chmod +x bin/start.sh bin/run.sh \
 && printf '#!/bin/sh\nexec node /app/dist/cli/index.js "$@"\n' > /usr/local/bin/agentboard \
 && chmod +x /usr/local/bin/agentboard \
 && git config --system user.name agentboard \
 && git config --system user.email agentboard@localhost \
 && mkdir -p /data /home/node/.claude \
 && mkdir -p /home/node/.ssh \
 && printf 'StrictHostKeyChecking accept-new\n' > /home/node/.ssh/config \
 && chown -R node:node /data /home/node /opt/playwright-browsers

ENV AGENTBOARD_DATA=/data \
    AGENTBOARD_WORK=/data/work \
    HOME=/home/node \
    NODE_ENV=production

EXPOSE 4666
CMD ["/app/bin/start.sh"]
