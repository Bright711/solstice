FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p data
EXPOSE 4000
CMD ["sh", "-c", "node server/seed.js && node server/index.js"]
