FROM node:20-slim

RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates --no-install-recommends \
  && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
  && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
  && apt-get update \
  && apt-get install -y google-chrome-stable \
    fonts-ipafont-gothic fonts-wqy-zenhei --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/google-chrome-stable

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js .

EXPOSE 3099
CMD ["node", "server.js"]
