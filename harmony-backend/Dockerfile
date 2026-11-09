FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node src ./src
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=47832 DATA_DIR=/app/data NODE_ENV=production COOKIE_SECURE=true
EXPOSE 47832
VOLUME ["/app/data"]
CMD ["node", "src/index.js"]
