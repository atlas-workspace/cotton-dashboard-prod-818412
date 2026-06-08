FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY index.html ./
COPY assets ./assets
COPY last-*.json ./
ENV NODE_ENV=production
ENV PORT=80
EXPOSE 80
CMD ["node", "server.js"]
