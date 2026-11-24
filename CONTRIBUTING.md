# Contributing

Thanks for helping build MCPGet. The project is currently at Milestone 0; check the implementation plan and open issues before proposing work. Do not begin a later milestone without direction from the project owner.

## Local setup

Use Node.js 20 or newer and npm. Clone the repository, run `npm install`, and use the scripts in `package.json` for linting, type checking, tests, formatting, and building.

## Change expectations

- Keep changes focused and explain their purpose.
- Use strict TypeScript and small, composable modules.
- Keep discovery, verification, compatibility, and installation concerns separate.
- Add tests for significant functionality when implementation work is authorized.
- Preserve existing user configurations and never expose secrets in logs.
- Update documentation when behavior or interfaces change.
- Do not claim integrations or publishers are official without supporting evidence.
- Follow [AGENTS.md](AGENTS.md) and the [security model](docs/development/SECURITY_MODEL.md).

## Pull requests

Describe the change, relevant milestone, verification performed, and known limitations. CI runs linting, type checking, tests, and a build. Do not include credentials, personal configuration files, or generated `dist/` output.
