# Build with development tools; the runtime contains production dependencies only.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --chown=node:node docs ./docs
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
