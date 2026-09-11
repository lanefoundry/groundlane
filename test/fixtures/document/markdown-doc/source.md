# Groundlane Architecture

Groundlane is an open-source remote MCP server and trusted content access layer for AI agents.

## Core Principles

1. Deterministic extraction without hidden LLM calls
2. Provider-neutral tool contracts
3. Bounded resource consumption

## Tools

| Tool | Description |
|------|-------------|
| web_fetch | Reads a public URL as Markdown |
| web_search | Searches the public web |
| document_parse | Parses bounded documents |

The system prioritizes cheap HTTP retrieval over browser rendering.
