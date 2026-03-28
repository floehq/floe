FROM node:20-bookworm-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json

RUN npm ci

FROM deps AS build

COPY . .

RUN npm run build --workspace=apps/api
RUN npm prune --omit=dev --workspaces

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3001
ENV UPLOAD_TMP_DIR=/var/lib/floe/upload

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/api/package.json /app/apps/api/package.json
COPY --from=build /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build /app/apps/api/dist /app/apps/api/dist

RUN mkdir -p /var/lib/floe/upload && chown -R node:node /var/lib/floe /app

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch(`http://127.0.0.1:${process.env.PORT || 3001}/health`).then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
