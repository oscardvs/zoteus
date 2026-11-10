import type { EmbeddingProvider } from './embeddings.js';

/**
 * A daily allowance on what one caller may send to the embedder.
 *
 * A hosted operator pays the embedding API for every tenant out of one key. The key itself
 * never leaves the server, so what a tenant can take is not the key but the money behind
 * it: a loop of index rebuilds over a large library is a bill. This puts a ceiling on that
 * per caller, and the provider's own spending cap stays the ceiling for all of them.
 *
 * Tokens are estimated at four characters each, which is close for English prose and
 * generous for everything else; the point is an order of magnitude, not an invoice.
 *
 * The ledger is module state keyed by the caller, not a field of the wrapper, because a
 * hosted deployment drops and rebuilds a tenant's context when it has been idle: a counter
 * that lived in the context would be reset by waiting.
 */
const CHARS_PER_TOKEN = 4;

interface Spend {
  day: string;
  tokens: number;
}

const ledger = new Map<string, Spend>();

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Thrown when a caller's allowance for the day is used up; the build goes on keyword-only. */
export class EmbedBudgetExceededError extends Error {
  constructor(limit: number) {
    super(
      `The daily allowance for search by meaning on this server (about ${limit.toLocaleString('en-US')} tokens) is used up. ` +
        'What was indexed so far stays searchable, keyword search is unaffected, and running the index update again tomorrow embeds the rest.',
    );
    this.name = 'EmbedBudgetExceededError';
  }
}

/** Estimated tokens `caller` has spent today. For tests and for an operator's own checks. */
export function embedTokensSpent(caller: string, now: Date = new Date()): number {
  const s = ledger.get(caller);
  return s && s.day === today(now) ? s.tokens : 0;
}

/** Forget every caller's spend. For tests. */
export function resetEmbedBudgets(): void {
  ledger.clear();
}

/**
 * Wrap `inner` so that passage embeddings for `caller` stop once `dailyTokens` is spent.
 *
 * Queries are counted but never refused: one is a sentence, and refusing it would turn "the
 * index has stopped growing today" into "search is down", which is a different and worse
 * failure. Everything else about the provider (its name, model, pooling: the identity an
 * index is stamped with) is the inner provider's own, read straight through.
 */
export function withEmbedBudget(
  inner: EmbeddingProvider,
  caller: string,
  dailyTokens: number,
  clock: () => Date = () => new Date(),
): EmbeddingProvider {
  const embed: EmbeddingProvider['embed'] = async (texts, kind) => {
    const now = clock();
    const day = today(now);
    let spend = ledger.get(caller);
    if (!spend || spend.day !== day) {
      spend = { day, tokens: 0 };
      ledger.set(caller, spend);
    }
    const cost = Math.ceil(texts.reduce((n, t) => n + t.length, 0) / CHARS_PER_TOKEN);
    if (kind !== 'query' && spend.tokens + cost > dailyTokens) throw new EmbedBudgetExceededError(dailyTokens);
    // Charged before the request: a request that fails after being sent has still been
    // billed by the provider more often than not, and under-counting is the unsafe side.
    spend.tokens += cost;
    return inner.embed(texts, kind);
  };
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'embed') return embed;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
