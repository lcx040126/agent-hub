FROM node:24-bookworm-slim AS build

RUN npm install --global pnpm@11.19.0
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
ENV AGENT_HUB_DATA_DIR=/app/data

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 4173
VOLUME ["/app/data"]
CMD ["node", "dist/server/index.js"]
