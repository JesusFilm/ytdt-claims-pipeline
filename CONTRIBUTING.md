# Contributing to ytdt-claims-pipeline

Thank you for your interest in contributing!

## Development Setup

1. Clone the repository
2. Install dependencies: `pnpm install`
3. Copy `.env.example` to `.env` and configure
4. Set up MongoDB (see README.md)
5. Run development server: `pnpm dev`

## Code Style

- We use ESLint and Prettier for code formatting
- Run `pnpm format` before committing
- Run `pnpm lint` to check for issues
- Pre-commit hooks will automatically format and lint your code

## Making Changes

1. Create a branch from `main`
2. Make your changes
3. Ensure all tests pass (if applicable)
4. Run `pnpm lint` and `pnpm format:check`
5. Commit your changes (pre-commit hooks will run automatically)
6. Push and create a pull request

## Commit Messages

- Use clear, descriptive commit messages
- Reference issue numbers when applicable

## Pull Requests

- Keep PRs focused on a single feature or fix
- Ensure CI checks pass
- Request review from maintainers
