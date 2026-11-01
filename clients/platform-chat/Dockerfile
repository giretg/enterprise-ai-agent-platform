# #1004 platform-chat worker — Cloud Run, request-based, min=0.
FROM node:22-slim
WORKDIR /srv
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/main.ts"]
