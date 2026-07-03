# Curie

Curie is a local-first RAG study and research assistant for an Obsidian vault. It indexes your vault, retrieves relevant chunks, and answers questions grounded in your notes and documents using Ollama-compatible models.

## Stack

- Backend: Express + TypeScript
- Frontend: React + Vite
- Retrieval: local JSON vector store with cosine similarity
- Models: Ollama chat + embedding models

## Supported vault content

Current ingestion support:

- `.md`, `.txt`, `.csv`, `.py`, `.json`, `.js`, `.ts`, `.tsx`, `.yaml`, `.yml`
- `.pdf`
- `.docx`
- `.xlsx`
- image files as filename-level placeholders
- unsupported binaries as filename-level placeholders

Notes:

- `.pptx`, `.pages`, and image OCR are not deeply parsed in this initial version.
- This project is optimized to be simple and runnable on an 8 GB Apple Silicon machine.

## Recommended models

For your hardware, prefer smaller fast models:

- Chat: `llama3.1:8b` or another Ollama-hosted 7B/8B instruct model
- Embeddings: `nomic-embed-text`

If you are using an Ollama cloud-compatible endpoint, set [`OLLAMA_HOST`](.env.example) accordingly.

## Setup

1. Copy [`.env.example`](.env.example) to `.env` and adjust values.
2. Install dependencies:

```bash
npm install
```

3. Run development mode:

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8787`

## Environment variables

See [`.env.example`](.env.example).

Required:

- `OLLAMA_HOST`
- `OLLAMA_MODEL`
- `OLLAMA_EMBED_MODEL`
- `VAULT_PATH`

## Usage

1. Start the app.
2. Click **Reindex vault**.
3. Ask questions in the chat UI.

Curie returns an answer plus source snippets and source file paths.

## Tradeoffs in this version

- Embeddings are generated sequentially for simplicity and lower memory pressure.
- Index is stored in [`.curie/index.json`](.curie/index.json) after first indexing.
- OCR and rich Office extraction are intentionally omitted to keep the implementation minimal and more reliable on your machine.
