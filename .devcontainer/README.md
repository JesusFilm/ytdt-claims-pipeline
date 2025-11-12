# Dev Container Setup

This project includes a VS Code Dev Container configuration for consistent development environments.

## Features

- **Node.js 18** with pnpm support (via corepack)
- **MongoDB 6** service running automatically
- **OpenVPN** installed and configured with sudo access
- **VS Code extensions** pre-installed:
  - ESLint
  - Prettier
  - TypeScript
  - Vitest Explorer

## Usage

1. Open the project in VS Code
2. When prompted, click "Reopen in Container" (or use Command Palette: "Dev Containers: Reopen in Container")
3. Wait for the container to build and start
4. Dependencies will be installed automatically via `pnpm install`

## Environment Variables

Create a `.env` file in the project root with required variables. See `src/env/env.js` for the complete list.

**Required for basic operation:**

- `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`
- `VPN_CONFIG_FILE` (path to OpenVPN config, e.g., `./config/vpn/client.ovpn`)
- `FRONTEND_URL`, `BASE_URL`, `GOOGLE_REDIRECT_URI`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_WORKSPACE_DOMAINS`
- `JWT_SECRET`

**Optional:**

- `SKIP_VPN=true` (to skip VPN connection during development)
- `GOOGLE_DRIVE_NAME`
- `ML_API_ENDPOINT`
- Slack integration variables

**Note:** `MONGODB_URI` is automatically set to `mongodb://mongodb:27017/ytdt-claims-pipeline` in the container.

## Running the Application

```bash
pnpm dev
```

The API server will be available at `http://localhost:3000`.

## VPN Configuration

Place your VPN configuration files in `./config/vpn/`:

- `ca.crt`
- `client.crt`
- `client.key`
- `client.ovpn`

Set `VPN_CONFIG_FILE=./config/vpn/client.ovpn` in your `.env` file.

## Troubleshooting

- **Port conflicts**: If port 3000 or 27017 are already in use, modify `forwardPorts` in `devcontainer.json`
- **VPN issues**: Ensure VPN config files are in the correct location and permissions are set correctly
- **Dependencies**: Run `pnpm install` manually if post-create command fails
