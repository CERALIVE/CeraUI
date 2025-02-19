FROM --platform=linux/arm64 ubuntu

# Set working directory
WORKDIR /app

RUN apt-get update && apt-get install -y curl unzip bash

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Install specific PR. it will be installed as bun-xxxx (xxxx is PR number)
ARG PR
RUN BUN_OUT_DIR=/root/.bun/bin bun x bun-pr "$PR"
