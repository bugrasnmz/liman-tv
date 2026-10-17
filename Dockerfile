FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
COPY public ./public
ENV PORT=8080 HOST=0.0.0.0
EXPOSE 8080
USER node
CMD ["node", "server.js"]
