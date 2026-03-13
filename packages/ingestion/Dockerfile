FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

FROM deps AS build
COPY packages ./packages
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

CMD ["node", "dist/packages/ingestion/src/index.js"]
