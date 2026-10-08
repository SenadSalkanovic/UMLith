# Architecture Workspace

<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
Approved: React, Vite, React Flow; local Node.js/Fastify service; TypeScript compiler API; Prisma schema parser.

## Users
An individual developer who wants to understand and control software architecture while using coding agents.

## Product Purpose
Make intended architecture explicit and human-owned, reconstruct existing code, and review agent work against versioned constraints.

## Operating Context
Local browser and project folders. Both new and imported projects. Saved-file synchronization. Optional local or hosted coding agents.

## Capabilities and Constraints
Architecture, ER, and optional function workflows share a program graph. Intended and implemented models are separate. TypeScript and Prisma are the first analyzers. Review precedes application. Integrated execution initially targets Linux with Bubblewrap isolation.

## Product Principles
- Humans own the specification.
- Every extracted fact has source evidence.
- Unknown and stale information remains visible.
- Protected code and interfaces cannot silently change.
- Function detail is optional.

## Evidence on Hand
The approved implementation plan in this conversation. No performance claims have been measured yet.
