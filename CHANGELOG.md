# Changelog

## [1.2.0](https://github.com/dashecorp/claude-memory-mcp/compare/claude-memory-mcp-v1.1.0...claude-memory-mcp-v1.2.0) (2026-04-13)


### Features

* add PostgreSQL backend for persistent shared memory ([#26](https://github.com/dashecorp/claude-memory-mcp/issues/26)) ([9d21cfc](https://github.com/dashecorp/claude-memory-mcp/commit/9d21cfcb7e83f37f9fe5560b423eafa61ae23a8a))


### Bug Fixes

* strip undefined values before Firestore sync ([#28](https://github.com/dashecorp/claude-memory-mcp/issues/28)) ([5127d77](https://github.com/dashecorp/claude-memory-mcp/commit/5127d773bd54452b0159b722c0d27e40f00a8679))

## [1.1.0](https://github.com/Stig-Johnny/claude-memory-mcp/compare/claude-memory-mcp-v1.0.0...claude-memory-mcp-v1.1.0) (2026-03-05)


### Features

* Add /load-memory slash command ([0b058bb](https://github.com/Stig-Johnny/claude-memory-mcp/commit/0b058bbf15b59fd6d50386c46d90c5548ee0310c))
* Add category support for decisions and errors (v2.6.0) ([7085c1f](https://github.com/Stig-Johnny/claude-memory-mcp/commit/7085c1f34eb5c060b842993b9fca3b5e57f3c2ba))
* Add list_decisions, memory_stats, bulk_cleanup tools (v2.2.0) ([4a66c11](https://github.com/Stig-Johnny/claude-memory-mcp/commit/4a66c111e2ce4430cbbbcf73c6e502651fb2a7b0))
* Add load_comprehensive_memory function (v2.4.0) ([f342b58](https://github.com/Stig-Johnny/claude-memory-mcp/commit/f342b5829858e51991044c705937d189924eeb96))
* Add memory management tools (v2.1.0) ([9df142d](https://github.com/Stig-Johnny/claude-memory-mcp/commit/9df142d0a6b8e86acb511a6021b580c45e4f5717))
* Add memory tiers for usage tracking (v2.7.0) ([ebbf6f9](https://github.com/Stig-Johnny/claude-memory-mcp/commit/ebbf6f9660160540e218673cfb52c16177049bd3))
* Add optional Firestore cloud sync (v2.0.0) ([dbbdb95](https://github.com/Stig-Johnny/claude-memory-mcp/commit/dbbdb95468cbe5957d5b692e2fd85cd401053f9a))
* Add priority field for decisions, errors, learnings (v2.5.0) ([ddd8e19](https://github.com/Stig-Johnny/claude-memory-mcp/commit/ddd8e19aeff5308f3b8bca9702dd993e9e8eabaa))
* add temporal decay for memory retrieval ([#12](https://github.com/Stig-Johnny/claude-memory-mcp/issues/12)) ([588daf3](https://github.com/Stig-Johnny/claude-memory-mcp/commit/588daf30ca00608fa18db45bf787f9ffa9d14d5d))
* Add workspace-aware session storage (v2.3.0) ([5517118](https://github.com/Stig-Johnny/claude-memory-mcp/commit/5517118bf6206654db8145caf139f24701a8cc7a))


### Bug Fixes

* **ci:** replace peter-evans auto-merge with github-script ([#18](https://github.com/Stig-Johnny/claude-memory-mcp/issues/18)) ([598864d](https://github.com/Stig-Johnny/claude-memory-mcp/commit/598864d0a34699e6d9d24e52a091baa875dba668))
* Correct author name in LICENSE and package.json ([a07de6d](https://github.com/Stig-Johnny/claude-memory-mcp/commit/a07de6d4bf5322e9224a7cdd726f4f0430fc5e40))
* Correct author name to Stig-Johnny Stoebakk ([8c3af0f](https://github.com/Stig-Johnny/claude-memory-mcp/commit/8c3af0f63b8b32d6fab4531bfb7c77f242d07297))
* **deps:** update @modelcontextprotocol/sdk to fix ReDoS vulnerability ([064acdc](https://github.com/Stig-Johnny/claude-memory-mcp/commit/064acdcd6785d9c188712057081317a2d8ed0955))
* Update copyright year to 2025 ([c9f0c63](https://github.com/Stig-Johnny/claude-memory-mcp/commit/c9f0c63232b9a5be76d80210259547e3f9460856))
