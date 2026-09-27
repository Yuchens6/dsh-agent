FROM node:24.14.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY dsh-agent-contracts/ dsh-agent-contracts/
COPY dsh-agent-api/ dsh-agent-api/
COPY dsh-agent-chat/ dsh-agent-chat/
COPY dsh-agent-stream/ dsh-agent-stream/
COPY dsh-agent-workspace/ dsh-agent-workspace/
COPY dsh-agent-catalog/ dsh-agent-catalog/
COPY dsh-agent-run-control/ dsh-agent-run-control/
COPY dsh-agent-runtime-dsh/ dsh-agent-runtime-dsh/
COPY dsh-agent-quota/ dsh-agent-quota/
COPY dsh-agent-audit/ dsh-agent-audit/
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24.14.0-bookworm-slim AS runtime
ARG SERVICE=dsh-agent-api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dsh-agent-contracts ./dsh-agent-contracts
COPY --from=build --chown=node:node /app/${SERVICE} ./service
COPY --chown=node:node dsh-agent-deploy/init-stream.mjs ./dsh-agent-deploy/init-stream.mjs
USER node
WORKDIR /app/service
EXPOSE 8080
CMD ["node", "dist/main.js"]
