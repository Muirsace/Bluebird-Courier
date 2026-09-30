# Architecture fixtures

The Vitest cases create disposable source trees from the small snippets in
`test-utils.ts`. This directory records the fixture categories so adding a new
rule keeps its valid and invalid example next to the architecture tests without
putting intentionally invalid TypeScript into the project compilation.

- `valid/` contains documented dependency and boundary examples.
- `invalid/` contains examples that must be rejected by the policy.
