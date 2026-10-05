FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY examples ./examples
ENV PORT=8090 CATALOGUE_DIR=/app/catalogue
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8090/api/health || exit 1
CMD ["node", "server.js"]
