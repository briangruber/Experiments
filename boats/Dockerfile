# The whole game in one layer: no dependencies to install, no build step.
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
