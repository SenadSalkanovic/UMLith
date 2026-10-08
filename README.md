# UMLith

A local visual architecture workspace for defining software architecture, ER models, interfaces, and optional function workflows with AI assistance. Humans own the intended specification; source analysis reconstructs the implemented model. A separate coding agent implements approved changes in an isolated workspace for human review.

This repository is a work in progress. It contains the preserved product plan, a detailed task backlog, and initial TypeScript modules and tests. The complete browser application is still under development.

## Plan and task backlog

- [Original product plan](docs/tasks/architecture-workspace/ORIGINAL-PLAN.md)
- [103 individual tasks in implementation order](docs/tasks/architecture-workspace/README.md)
- [Requirement coverage](docs/tasks/architecture-workspace/REQUIREMENTS.md)
- [Shared constraints and architecture](docs/tasks/architecture-workspace/CONTRACT.md)
- [Decisions](docs/tasks/architecture-workspace/DECISIONS.md)
- [Product purpose](PRODUCT.md)

Task files record dependencies, acceptance criteria, validation scenarios, and completion evidence. Existing code must be assessed against those criteria before a task is marked complete.

## Stack

React, Vite, React Flow, Node.js/Fastify, shared TypeScript types with Zod, TypeScript compiler API pinned to 6.0.3, and Prisma schema parsing. Integrated agent execution initially targets Linux with Bubblewrap isolation.

## Development checks

Requires Node.js 22.12 or newer.

```bash
npm ci
npm test
npm run build
```

At the initial project upload on 2026-10-08, all 12 tests across 7 test files passed. The build failed with TypeScript error TS2367 at `server/jobs.ts:99`, involving a comparison between the running and cancelled job states. This records the initial snapshot; future task completion should include fresh validation evidence.

## License

See [LICENSE](LICENSE).
