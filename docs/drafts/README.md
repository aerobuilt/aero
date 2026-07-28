# Aero Documentation

This directory contains the main documentation for the [Aero](https://github.com/jamiewilson/aero) framework. The root [README](../README.md) gives a short overview and quick start.

## Getting started

- **[Getting Started](getting-started.md)** — Build your first Aero project: pages, components, layouts, data, and scripts.
- **[Learner's guide: native web vs Aero](learners-guide.md)** — A beginner-friendly map of what stays native HTML/CSS/JS and what Aero adds.
- **[Overview](overview.md)** — What Aero is, core stack and philosophy, and what it supports (with links to deeper docs).
- **[Aero principles & goals](../_reference/guides/aero-principles-and-goals.md)** — Canonical product goals, web-platform stance, toolchain commitments, and engineering principles (for refactors and consistency).
- **[What Makes Aero Different?](what-makes-aero-different.md)** — Aero's architectural philosophy and differences from standard frameworks.
- **[Why Not Web Components?](why-not-web-components.md)** — A comparison of Aero's approach versus standard Web Components.

## Routing and pages

- **[Routing](routing.md)** — File-based routing, static and dynamic routes, `getStaticPaths`, and template context.

## Components and templating

- **[Interpolation](interpolation.md)** — `{ }` expressions in text and attributes (Svelte-style nested braces), literal braces via string expressions / entities, and `props` semantics (spread for object properties as CSS vars).
- **[HTML `<template>`](html-template-element.md)** — Wrapperless `if` / `for` (no extra element in output), literal inert templates, and restricted HTML contexts.
- **[Props guide](props.md)** — Passing and receiving props, how attribute values work, `props`, and globals.
- **[Slot passthrough](slot-passthrough.md)** — Passing named slots through layout hierarchies.
- **[TypeScript guide](typescript-guide.md)** — Typing props, content globals, collections, and ambient types for type-safe build scripts.

## Scripts and data

- **[Script taxonomy](script-taxonomy.md)** — Script types (`is:build`, plain `<script>`, `is:inline`, `is:blocking`, `src`), behavior, and `props` with multiple instances.
- **[props directive](props-directive.md)** — Threading build-time data into client scripts and `<style>`.
- **[Importing and bundling](importing-and-bundling.md)** — How client scripts are bundled; options (single bundle, CDN + globals, externals, code-splitting) for htmx, Alpine, and other deps.

## Content and configuration

- **[Content API](content-api.md)** — Content collections, `getCollection()`, `render()`, and `getStaticPaths` with props.
- **[Dependency policy](dependency-policy.md)** — Catalog vs overrides vs explicit versions, plus CI guardrails.
- **[Site URL](site-url.md)** — Canonical URL, sitemap, and `Aero.site` / `import.meta.env.SITE`.
- **[Environment variables](environment-variables.md)** — Vite env, `VITE_` prefix, `.env` files, and TypeScript.
- **[Middleware and redirects](middleware.md)** — Request-time middleware (dev) and config redirects.

## Image Handling

- **[Image optimization](image-optimization.md)** — Optional image pipeline during build.

## Tooling

- **[Aero CLI (`aero check`) and tooling APIs](aero-cli-and-check.md)** — `aero check`, `aero check --types`, `aero doctor`, exit codes, and related package APIs.
- **[Incremental static build](build-performance.md)** — `AERO_INCREMENTAL`, `.aero/cache/build-manifest.json`, and when prerender is skipped or partial.
- **[Standalone runtime](standalone-runtime.md)** — Use Aero compile/runtime helpers in ESM scripts and non-Vite execution flows.
- **VS Code extension** — Install from the marketplace; features and settings are documented in [packages/vscode/README.md](../packages/vscode/README.md).

## Server and client libraries

- **[Nitro](nitro-overview.md)** — `server: true`, root `nitro.config.ts`, Nitro-native APIs, storage, cache, database, tasks, plugins, and deployment presets.
- **[HTMX and Alpine](htmx-and-alpine.md)** — Using htmx and Alpine.js with Aero, including together.

## Testing and contribution

- **Tests** — From the repo root, `pnpm test` runs Vitest for compiler and related packages; see [monorepo.md](monorepo.md) for layout and package paths.
