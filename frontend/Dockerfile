# syntax=docker/dockerfile:1.7
FROM node:22-alpine
WORKDIR /usr/src/app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
EXPOSE 5173