import { load } from "cheerio";

const maxScoredCandidates = 200;

const removableSelectors = [
  "script",
  "style",
  "noscript",
  "template",
  "nav",
  "footer",
  "aside",
  "form",
  "dialog",
  "menu",
  "iframe",
  "canvas",
  "svg",
  "[aria-hidden='true']",
  "[hidden]",
  ".advertisement",
  ".ads",
  ".cookie-banner",
  ".newsletter",
  ".related-posts",
  ".share-buttons",
  ".sidebar",
].join(",");

const candidateSelectors = [
  "article",
  "main",
  "[role='main']",
  "[itemprop='articleBody']",
  ".article",
  ".article-body",
  ".content",
  ".entry-content",
  ".main-content",
  ".post",
  ".post-content",
  "#article",
  "#content",
  "#main",
].join(",");

const positiveName = /(?:^|[-_\s])(article|body|content|entry|main|page|post|story)(?:$|[-_\s])/iu;
const negativeName = /(?:^|[-_\s])(ad|banner|comment|footer|header|menu|nav|promo|related|share|sidebar|social|subscribe)(?:$|[-_\s])/iu;

function cleanMetadata(value: string | undefined, maxLength: number): string | undefined {
  const cleaned = value?.replace(/\s+/gu, " ").trim();
  if (!cleaned) return undefined;
  return Array.from(cleaned).slice(0, maxLength).join("");
}

function absoluteHttpUrl(value: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export interface ReadableDocument {
  title?: string;
  description?: string;
  author?: string;
  publishedAt?: string;
  html: string;
  text: string;
}

export function extractReadableDocument(
  source: string,
  baseUrl: string,
): ReadableDocument {
  const $ = load(source);
  const title = cleanMetadata(
    $('meta[property="og:title"]').first().attr("content") ??
      $("title").first().text(),
    500,
  );
  const description = cleanMetadata(
    $('meta[name="description"]').first().attr("content") ??
      $('meta[property="og:description"]').first().attr("content"),
    1_000,
  );
  const author = cleanMetadata(
    $('meta[name="author"]').first().attr("content") ??
      $('meta[property="article:author"]').first().attr("content") ??
      $("[rel='author']").first().text(),
    200,
  );
  const publishedAt = cleanMetadata(
    $('meta[property="article:published_time"]').first().attr("content") ??
      $("time[datetime]").first().attr("datetime"),
    200,
  );

  $(removableSelectors).remove();

  const candidates = $(candidateSelectors)
    .toArray()
    .slice(0, maxScoredCandidates)
    .map((node, order) => {
      const element = $(node);
      const text = element.text().replace(/\s+/gu, " ").trim();
      const linkTextLength = element
        .find("a")
        .toArray()
        .reduce((total, link) => total + $(link).text().replace(/\s+/gu, " ").trim().length, 0);
      const name = `${element.attr("id") ?? ""} ${element.attr("class") ?? ""}`;
      const semanticBonus = element.is("article")
        ? 500
        : element.is("main,[role='main'],[itemprop='articleBody']")
          ? 300
          : 0;
      const nameBonus = positiveName.test(name) ? 200 : 0;
      const namePenalty = negativeName.test(name) ? 1_000 : 0;
      const structureBonus = element.find("p").length * 80 + element.find("h1,h2,h3").length * 30;
      const linkPenalty = text.length === 0 ? 0 : Math.round((linkTextLength / text.length) * 500);
      return {
        element,
        order,
        textLength: text.length,
        score: text.length + structureBonus + semanticBonus + nameBonus - namePenalty - linkPenalty,
      };
    })
    .filter((candidate) => candidate.textLength > 0)
    .sort((left, right) => right.score - left.score || left.order - right.order);

  const selected = candidates[0]?.element ?? $("body").first();
  selected.find(removableSelectors).remove();
  selected.find("a[href]").each((_index, element) => {
    const link = $(element);
    const href = link.attr("href");
    if (href === undefined) return;
    const absolute = absoluteHttpUrl(href, baseUrl);
    if (absolute === undefined) link.removeAttr("href");
    else link.attr("href", absolute);
  });
  selected.find("img[src],source[src]").each((_index, element) => {
    const media = $(element);
    const src = media.attr("src");
    if (src === undefined) return;
    const absolute = absoluteHttpUrl(src, baseUrl);
    if (absolute === undefined) media.removeAttr("src");
    else media.attr("src", absolute);
  });

  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(author === undefined ? {} : { author }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    html: selected.html() ?? "",
    text: selected.text(),
  };
}
