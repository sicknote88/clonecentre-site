FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./server.js
COPY fulfillment ./fulfillment

RUN mkdir -p /app/public /app/private/books
COPY index.html goal-tracker.html order-complete.html chatbot-knowledge.html /app/public/
COPY assets /app/public/assets

# Paid files are intentionally gitignored and are included only by the private
# Railway CLI deployment (`railway up --no-gitignore`). They are never served
# by Express as static assets.
COPY books/paid /app/private/books
COPY books/Clone_Centre_Prompt_Guidebook.pdf /app/private/books/Clone_Centre_Prompt_Guidebook.pdf

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
