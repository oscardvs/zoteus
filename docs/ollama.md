# Embed with Ollama

Semantic search needs an embedding model. Zoteus has four ways to run one, and this is the third:

| `ZOTEUS_EMBEDDINGS` | Where the model runs | Does library text leave your machine? | What it costs you |
|---|---|---|---|
| `local` (default) | In this server's own process | No | A ~700 MB `@huggingface/transformers` install |
| `ollama` | An Ollama daemon on your machine | No | An Ollama install and one `ollama pull` |
| `openai` / `gemini` | The provider's servers | **Yes** | An API key and per-token spend |
| `off` | Nowhere | No | Keyword (BM25) search only |

Ollama is worth choosing when `local` will not install. That is the normal case for the Claude Desktop extension: the bundle cannot carry the on-device runtime (the resolved dependency tree, onnxruntime's native binaries included, is about 700 MB), so a desktop-extension user who does not set up a separate install has no private embedding option at all. If you already run Ollama for anything else, this reuses it, including its GPU.

If you already have `@huggingface/transformers` working, the gain is smaller: one model cache instead of two, and whatever acceleration Ollama gets on your hardware. `local` is not worse for privacy, and it is one fewer process to keep running.

## Setup

```bash
ollama serve                 # or just open the Ollama app, which runs it
ollama pull all-minilm       # ~46 MB
```

Then in your environment:

```bash
ZOTEUS_EMBEDDINGS=ollama
# ZOTEUS_OLLAMA_URL=http://127.0.0.1:11434   # the default; set it only for another machine
```

In the Claude Desktop extension there is no environment to set, so both live in its Configure screen instead: type `ollama` into **Semantic-search embeddings**, and leave **Ollama URL** empty unless your daemon listens somewhere other than `http://127.0.0.1:11434` (another port through `OLLAMA_HOST`, a container with a published port, or another machine).

Restart the server (in the desktop extension, quit and reopen the app) and build the index:

> Build my Zotero index, then tell me which embedder is active.

`zotero_index action:"status"` reports `embedder: "ollama"` and a non-zero `vectors` count when it is working. `zotero_whoami` reports the same thing, and says so plainly when it is not.

## The model

`ZOTEUS_EMBEDDING_MODEL` names the model, and unset means **`all-minilm`**. That is the same checkpoint the `local` provider defaults to (`all-MiniLM-L6-v2`): small, fast, English-centric, and trained without input prefixes.

Any Ollama embedding model works. Pull it first, then name it. How you spell the tag does not matter: `all-minilm`, the `all-minilm:latest` that `ollama list` prints, and the fully qualified `registry.ollama.ai/library/all-minilm:latest` are one pull, and Zoteus records them as one embedder, so moving between those spellings never costs you a rebuild. A tag that names a different version (`nomic-embed-text:v1.5`) is a different model and is recorded as one.

**One caveat, and it is the reason `all-minilm` is the default rather than the more popular `nomic-embed-text`.** Nomic's model card requires a task prefix on every input: `search_document: ` before a passage, `search_query: ` before a query. Zoteus adds prefixes automatically for the E5 family only (see `ZOTEUS_EMBEDDING_PREFIXES`), so a nomic model gets none. Nothing errors, and the index stays internally consistent: it simply retrieves worse than that model can, invisibly. Zoteus logs a warning at startup if you name one anyway. If you want nomic quality today, use it knowing that; otherwise stay on `all-minilm`, or pull an E5 model, which is prefixed for you.

## Switching providers invalidates your vectors, on purpose

The index stamps the vectors it stores with the provider and the model that made them: `ollama:all-minilm`, `local:Xenova/all-MiniLM-L6-v2`, `openai:text-embedding-3-small`. On startup, vectors stamped with anything other than the current embedder are discarded, with a message saying so, and `zotero_index action:"build"` re-embeds the library.

This happens even when the model name looks identical, and that is deliberate: two runtimes of the same weights are not guaranteed to produce the same numbers, and ranking a query from one against passages from the other returns plausible nonsense rather than an error. Keyword search is never affected, so the library stays searchable while you rebuild.

The stamp holds the canonical name of the pull, not the string you typed: an explicit `:latest` and the `registry.ollama.ai/library/` prefix are both dropped, and the name is lower-cased, so the three spellings above all stamp `ollama:all-minilm`. Renaming is therefore free; changing the model is not.

**Known gap.** Ollama tags are mutable and the base URL is not part of the stamp. If you re-pull `all-minilm` at a different quantization, or point `ZOTEUS_OLLAMA_URL` at a different machine running a different build of the same tag, the stamp does not change and Zoteus cannot tell. Run `zotero_index action:"build"` yourself after either.

## When it does not work

Both of the failures you are likely to hit degrade to keyword-only search, name themselves in `zotero_index action:"status"` and `zotero_whoami`, and never stop the server from starting.

**The daemon is not running.** `Ollama is not running at http://127.0.0.1:11434.` Start it with `ollama serve`, or open the Ollama app. Zoteus checks once per run, before the first batch, and does not sit through a retry schedule against a refused connection.

**The model is not pulled.** `The Ollama model "x" is not pulled.` Run `ollama pull x`. Zoteus lists what the daemon does hold, so a typo in the model name is visible rather than guessed at.

Either way, run `zotero_index action:"build"` again once it is fixed. Nothing was indexed with the wrong embedder, so there is nothing to undo.

## What this does not do

- It does not start, install or manage Ollama. That is a separate application, and it has to be running on the machine this server runs on (or one this server can reach over the network).
- It does not send your library anywhere by itself, but it is still an HTTP request: if you point `ZOTEUS_OLLAMA_URL` at another host, your library text goes to that host. On the default loopback address it does not leave the machine.
- It does not report a tokens-per-minute rate the way `openai` and `gemini` do. Your own hardware has no such ceiling, so `embedRate` stays absent. `ZOTEUS_EMBED_BATCH_SIZE` and `ZOTEUS_EMBED_BATCH_DELAY_MS` still work: use them to leave the GPU room for something else, not to stay under a limit.
- `ZOTEUS_EMBEDDING_DTYPE` and `ZOTEUS_EMBEDDING_POOLING` do nothing here and say so at startup. Ollama runs whatever the model file it pulled specifies, which is its business and not Zoteus's.
- The hosted server does not offer this. It runs with `ZOTEUS_EMBEDDINGS=off`, and a loopback address inside that container is not your machine.
