FROM node:22-bookworm-slim

# 必要パッケージ: git (target clone), chromium (playwright-cli), jq (scripts), gh CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git chromium jq \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Codex CLI / playwright-cli / tsx をグローバルに
RUN npm install -g @openai/codex playwright-cli tsx

WORKDIR /app

# project deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# project source
COPY lib ./lib
COPY scripts ./scripts
COPY prompts ./prompts

RUN chmod +x scripts/*.sh

# playwright-cli が chromium バイナリを探す場所
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
# Codex login の credential 永続化先 (compose で volume mount)
ENV CODEX_HOME=/root/.codex

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["sleep", "infinity"]
