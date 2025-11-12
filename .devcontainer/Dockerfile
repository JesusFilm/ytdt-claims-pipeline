FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bullseye

# Install OpenVPN and required tools
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
  && apt-get -y install --no-install-recommends \
  openvpn \
  iputils-ping \
  sudo \
  && apt-get clean -y && rm -rf /var/lib/apt/lists/*

# Configure sudo for node user (needed for OpenVPN)
RUN echo "node ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Set working directory
WORKDIR /workspace

