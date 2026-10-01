# Stages: deps → test (prettier + unit tests, `docker build --target test`) · build → prod (nginx).
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .

FROM deps AS test
ENV CI=true TZ=Europe/Berlin
RUN npx prettier --check . && npx ng test --watch=false

FROM deps AS build
RUN npx ng build

FROM nginx:1.30-alpine AS prod
ENV BACKEND_URL=http://backend:8000 \
    API_BASE=/api/v2 \
    KEYCLOAK_URL=http://localhost:18180 \
    KEYCLOAK_REALM=daily2 \
    KEYCLOAK_CLIENT_ID=daily2-app
COPY docker/default.conf.template /etc/nginx/templates/default.conf.template
COPY docker/16-keycloak-origin.envsh /docker-entrypoint.d/16-keycloak-origin.envsh
COPY docker/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
COPY --from=build /app/dist/daily2-frontend/browser /usr/share/nginx/html
# jq escapes the runtime config; the entrypoint sources executable *.envsh files, so
# KEYCLOAK_ORIGIN from 16-* reaches envsubst.
RUN apk add --no-cache jq \
    && chmod 755 /docker-entrypoint.d/40-runtime-config.sh /docker-entrypoint.d/16-keycloak-origin.envsh
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
