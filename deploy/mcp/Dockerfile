FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY bridge/package.json bridge/package-lock.json ./
# The gateway needs no PTY or WebRTC native binaries.
RUN npm ci --ignore-scripts
COPY bridge/tsconfig.json ./
COPY bridge/src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["node", "dist/mcp-cli.js"]
