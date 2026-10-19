FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js member-store.js email-templates.js os-worker.js ./
COPY fulfillment ./fulfillment
COPY scripts ./scripts

RUN mkdir -p /app/public /app/private/books
COPY index.html member.html goal-tracker.html order-complete.html chatbot-knowledge.html os.html trend-map.html for-business.html demo.html privacy.html /app/public/
COPY assets /app/public/assets
COPY public-data /app/public-data
COPY os-data /app/os-data

# Paid library files stay on the /data volume (copied there from the running
# service). The free guidebook is the only book baked into the image.
COPY books/Clone_Centre_Prompt_Guidebook.pdf /app/private/books/Clone_Centre_Prompt_Guidebook.pdf

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
