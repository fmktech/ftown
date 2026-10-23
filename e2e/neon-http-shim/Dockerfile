FROM node:24.22.1-alpine
RUN apk add --no-cache --upgrade ca-certificates && update-ca-certificates
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY shim.mjs ./
EXPOSE 443
CMD ["node", "shim.mjs"]
