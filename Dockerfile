# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /src

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html metadata.json tsconfig.json vite.config.ts ./
COPY src ./src
COPY public ./public

ARG VITE_API_BASE=/api
ARG VITE_WS_URL
ARG VITE_ASR_WS_URL
ARG VITE_IB_ACCOUNT_ISSUER
ARG VITE_IB_ACCOUNT_REDIRECT_URI
ARG VITE_IB_ACCOUNT_URL
ARG VITE_IB_ACCOUNT_CLIENT_ID
ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_WS_URL=$VITE_WS_URL \
    VITE_ASR_WS_URL=$VITE_ASR_WS_URL \
    VITE_IB_ACCOUNT_ISSUER=$VITE_IB_ACCOUNT_ISSUER \
    VITE_IB_ACCOUNT_REDIRECT_URI=$VITE_IB_ACCOUNT_REDIRECT_URI \
    VITE_IB_ACCOUNT_URL=$VITE_IB_ACCOUNT_URL \
    VITE_IB_ACCOUNT_CLIENT_ID=$VITE_IB_ACCOUNT_CLIENT_ID
RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=20s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1

