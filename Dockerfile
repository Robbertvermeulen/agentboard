FROM node:22-bookworm-slim

# git: the context repo (simple-git). openssh-client: the agent reaches
# client servers. gosu: drop root in start.sh. Claude Code: the default
# session command.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl gosu \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json AGENT.md ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

COPY bin ./bin
RUN chmod +x bin/start.sh bin/run.sh \
 && printf '#!/bin/sh\nexec node /app/dist/cli/index.js "$@"\n' > /usr/local/bin/agentboard \
 && chmod +x /usr/local/bin/agentboard \
 && mkdir -p /data /home/node/.claude \
 && chown -R node:node /data /home/node

ENV AGENTBOARD_DATA=/data \
    AGENTBOARD_WORK=/data/work \
    HOME=/home/node \
    NODE_ENV=production

EXPOSE 4666
CMD ["/app/bin/start.sh"]
