# UMLith

A local visual architecture workspace for defining software architecture, ER models, interfaces, and optional function workflows with AI assistance. Humans own the intended specification; source analysis reconstructs the implemented model. A separate coding agent implements approved changes in an isolated workspace for human review.

The local application provides architecture/ER/function editing, saved-source analysis and synchronization, human-reviewed proposals, portable agent handoffs, candidate review, and guarded application with recovery. Optional integrated Codex execution requires usable Linux Bubblewrap isolation. Runtime behavior and business intent still require human judgment.

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

## Build and run

Requires Node.js 22.12 or newer.

```bash
npm install
npm run build
npm start
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). For development, run `npm run dev` and open [http://127.0.0.1:5173](http://127.0.0.1:5173). `npm test` runs the existing automated suite; `npm run test:watch` watches it.

Use **Agent workspace** on an open project to export a handoff, download a result template, import returned files, launch an isolated task, review a candidate, or inspect recovery. See [local operation](OPERATIONS.md) for setup, constraints, and the external-agent result format. Later milestones such as collaboration, runtime tracing, additional analyzers, and live database introspection remain deferred.

## License

See [LICENSE](LICENSE).
