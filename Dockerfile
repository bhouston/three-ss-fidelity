# syntax=docker/dockerfile:1.6
# Build from the repo root: docker build -t three-ss-fidelity .
FROM node:24-slim

RUN npm install -g fidelity-kit@1.1.0

COPY results /data
RUN fidelity-kit process /data && fidelity-kit hash /data

EXPOSE 8080
CMD ["fidelity-kit", "serve", "/data", "--host", "0.0.0.0", "--port", "8080", "--no-process"]
