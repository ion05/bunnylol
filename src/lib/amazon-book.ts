/**
 * Turn an Amazon product page into a Goodreads destination.
 *
 * Pure: HTML in, a URL or null out. The content script is the only runtime
 * caller; the tests are the other. Matching the labelled ISBN fields (and
 * JSON-LD `isbn`) is the whole signal. Scanning for any 13-digit run would
 * follow a carousel ASIN onto the wrong book.
 */

const ISBN_13_RE = /97[89](?:\D*\d){10}/;
const ISBN_10_RE = /\b\d(?:\D*\d){8}[\dXx]\b/;

/** Amazon inserts these between "ISBN-13" and the number. */
const LABEL_WINDOW = 400;

export function goodreadsUrlForIsbn(isbn: string): string {
  return `https://www.goodreads.com/book/isbn/${isbn}`;
}

/** `/dp/ASIN` and the older product paths. Search pages are not books. */
export function isAmazonProductPath(pathname: string): boolean {
  return /\/(?:dp|gp\/product|gp\/aw\/d)\//i.test(pathname);
}

/**
 * ISBN-13 wins when both are on the page, because that is the one Goodreads
 * indexes most reliably. Null when the page never names a book.
 */
export function extractIsbn(html: string): string | null {
  return isbnFromJsonLd(html) ?? isbnAfterLabel(html, 'ISBN-13') ?? isbnAfterLabel(html, 'ISBN-10');
}

function isbnAfterLabel(html: string, label: 'ISBN-13' | 'ISBN-10'): string | null {
  const haystack = html.toUpperCase();
  const at = haystack.indexOf(label);
  if (at < 0) return null;
  const snippet = stripMarkup(html.slice(at + label.length, at + label.length + LABEL_WINDOW));
  return label === 'ISBN-13' ? findIsbn13(snippet) : findIsbn10(snippet);
}

function isbnFromJsonLd(html: string): string | null {
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    const body = match[1];
    if (!body) continue;
    try {
      const found = isbnFromUnknown(JSON.parse(body) as unknown);
      if (found) return found;
    } catch {
      // Amazon's JSON-LD is occasionally not JSON. The labelled fields still
      // sit in the product details, so a parse miss is not a miss of the book.
    }
  }
  return null;
}

function isbnFromUnknown(value: unknown): string | null {
  if (typeof value === 'string') return findIsbn13(value) ?? findIsbn10(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = isbnFromUnknown(entry);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, 'isbn')) {
    const found = isbnFromUnknown(record.isbn);
    if (found) return found;
  }
  if (Object.hasOwn(record, '@graph')) return isbnFromUnknown(record['@graph']);
  return null;
}

function findIsbn13(text: string): string | null {
  const match = text.match(ISBN_13_RE);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, '');
  return digits.length === 13 ? digits : null;
}

function findIsbn10(text: string): string | null {
  const match = text.match(ISBN_10_RE);
  if (!match) return null;
  const compact = match[0].toUpperCase().replace(/[^0-9X]/g, '');
  return compact.length === 10 ? compact : null;
}

function stripMarkup(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;|&zwnj;|&#8203;/gi, ' ');
}
