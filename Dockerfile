FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js .
EXPOSE 3099
CMD ["node", "server.js"]
