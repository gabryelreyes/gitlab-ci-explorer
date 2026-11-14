# Static SPA: build with Node, serve with nginx.
FROM node:26-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/web/package.json packages/web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w @gce/web

FROM nginx:1.29-alpine
COPY --from=build /src/packages/web/dist /usr/share/nginx/html
EXPOSE 80
