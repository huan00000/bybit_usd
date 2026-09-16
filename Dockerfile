FROM node:24-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY USD.js ./
# Only check syntax/load dependencies; never start the bot during a build.
RUN node --check USD.js \
    && node -e "require('bybit-api'); require('dotenv')" \
    && mkdir -p /data && chown node:node /data
USER node
CMD ["node", "USD.js"]
