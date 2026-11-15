FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY tenants ./tenants
COPY public ./public
COPY config ./config
ENV NODE_ENV=production PORT=8080
RUN mkdir -p /app/data && chown -R node:node /app/data /app/tenants
# Mount /app/data and /app/tenants as volumes so logins, client settings and logs survive redeploys
VOLUME ["/app/data", "/app/tenants"]
EXPOSE 8080
USER node
COPY start.js ./
CMD ["node", "start.js"]
