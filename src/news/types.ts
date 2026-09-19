// A news item as the pipeline sees it, regardless of where it came from.

export type NewsItem = {
  /** Stable per source (guid, entry id, link, or headline), prefixed with the source name. */
  id: string;
  /** Short machine name of the source ("fed", "alpaca:benzinga", "x:SECGov"); reports group by it. */
  source: string;
  /** How the source is described to the model ("Federal Reserve press releases (official)"). */
  sourceLabel?: string;
  headline: string;
  /** Plain text, tags stripped, truncated. */
  summary?: string;
  url?: string;
  /**
   * Publication time claimed by the source (epoch ms). Resolution and meaning vary by feed
   * (second or minute precision; sometimes the article time, not the feed update time).
   */
  publishedTs?: number;
  /** Local receive time: the pipeline clock, same as market events. */
  recvTs: number;
  /** Instruments the item is about ('BTC-USD' or a US ticker), when the source knows. */
  symbols?: string[];
};

export type SourceStats = { polls: number; notModified: number; items: number; errors: number };

export type NewsSource = { readonly name: string; readonly stats: SourceStats; close(): void };
