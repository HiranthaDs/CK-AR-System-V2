FROM node:22-alpine AS build

WORKDIR /app

ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_API_URL=/api/v1

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_API_URL=$VITE_API_URL

COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig*.json vite.config.ts eslint.config.js ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    APP_ENV=production \
    APP_HOST=0.0.0.0 \
    PORT=10000 \
    STATIC_DIR=/app/dist

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY scripts/run-api.mjs ./scripts/run-api.mjs
COPY --from=build /app/dist ./dist

USER node
EXPOSE 10000

CMD ["npm", "start"]
