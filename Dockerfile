FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm install typescript tsx

COPY . .
RUN npx tsc -p tsconfig.json

ENV NODE_ENV=production
ENV PORT=3004

EXPOSE 3004

CMD ["node", "dist/server.js"]
