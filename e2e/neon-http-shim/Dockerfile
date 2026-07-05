FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY shim.mjs ./
EXPOSE 443
CMD ["node", "shim.mjs"]
