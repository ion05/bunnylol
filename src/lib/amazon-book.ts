/**
 * Turn an Amazon product page into a Goodreads destination.
 *
 * Pure: HTML in, a URL or null out. The content script is the only runtime
 * caller; the tests are the other. Matching the labelled ISBN fields (and
 * JSON-LD `isbn`) is the main signal. Scanning for any 13-digit run would
 * follow a carousel ASIN onto the wrong book, so every candidate also has to
 * pass the ISBN check digit.
 *
 * A book page with no ISBN at all (every Audible edition, and many Kindle
 * ones) still has its ASIN in the URL, and Goodreads' `/book/isbn/` lookup
 * resolves an ASIN to the same edition. That fallback only runs on a page
 * that carries Amazon's book markup, so a USB hub never grows a button.
 */

const ISBN_13_RE = /97[89](?:\D*\d){10}/g;
const ISBN_10_RE = /\b\d(?:\D*\d){8}[\dXx]\b/g;

/** Amazon inserts these between "ISBN-13" and the number. */
const LABEL_WINDOW = 400;

/** `/dp/ASIN` and the older product paths. Search pages are not books. */
const PRODUCT_PATH_RE = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Za-z0-9]{10})(?=[/?#]|$)/i;

/**
 * Ids Amazon only renders on book product pages: the description block, and
 * the "book_details" / "audiobook_details" attribute carousel and bullets.
 */
const BOOK_PAGE_RE =
  /\bid=["']bookDescription_feature_div["']|\b(?:id|data-cel-widget)=["'](?:rpi-attribute-|detail_bullets-)(?:audio)?book_details-/;

export function goodreadsUrlForIsbn(isbn: string): string {
  return `https://www.goodreads.com/book/isbn/${isbn}`;
}

export function isAmazonProductPath(pathname: string): boolean {
  return PRODUCT_PATH_RE.test(pathname);
}

/** The ASIN in a product path, upper-cased. Null off a product page. */
export function asinFromPath(pathname: string): string | null {
  const match = pathname.match(PRODUCT_PATH_RE);
  return match?.[1] ? match[1].toUpperCase() : null;
}

/** True when the page carries Amazon's book-only markup. */
export function isAmazonBookPage(html: string): boolean {
  return BOOK_PAGE_RE.test(html);
}

/**
 * The Goodreads page for the book on this Amazon page, or null when the page
 * is not a book. An ISBN on the page wins; the ASIN is the fallback.
 */
export function goodreadsUrlForPage(pathname: string, html: string): string | null {
  const asin = asinFromPath(pathname);
  if (!asin) return null;
  const isbn = extractIsbn(html);
  if (isbn) return goodreadsUrlForIsbn(isbn);
  // A print book's ASIN is its ISBN-10, so that is a book whatever the markup.
  if (isValidIsbn10(asin) || isAmazonBookPage(html)) return goodreadsUrlForIsbn(asin);
  return null;
}

/**
 * ISBN-13 wins when both are on the page, because that is the one Goodreads
 * indexes most reliably. Null when the page never names a book.
 */
export function extractIsbn(html: string): string | null {
  return isbnFromJsonLd(html) ?? isbnAfterLabel(html, 'ISBN-13') ?? isbnAfterLabel(html, 'ISBN-10');
}

/**
 * Every occurrence of the label is tried, not only the first. Amazon names
 * "ISBN-13" in more than one place (the attribute carousel, then the product
 * details), and a first hit with no number near it is not a miss of the book.
 */
function isbnAfterLabel(html: string, label: 'ISBN-13' | 'ISBN-10'): string | null {
  const haystack = html.toUpperCase();
  for (let at = haystack.indexOf(label); at >= 0; at = haystack.indexOf(label, at + 1)) {
    const start = at + label.length;
    const snippet = stripMarkup(html.slice(start, start + LABEL_WINDOW));
    const found = label === 'ISBN-13' ? findIsbn13(snippet) : findIsbn10(snippet);
    if (found) return found;
  }
  return null;
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
  for (const match of text.matchAll(ISBN_13_RE)) {
    const digits = match[0].replace(/\D/g, '');
    if (isValidIsbn13(digits)) return digits;
  }
  return null;
}

function findIsbn10(text: string): string | null {
  for (const match of text.matchAll(ISBN_10_RE)) {
    const compact = match[0].toUpperCase().replace(/[^0-9X]/g, '');
    if (isValidIsbn10(compact)) return compact;
  }
  return null;
}

export function isValidIsbn13(digits: string): boolean {
  if (!/^97[89]\d{10}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

export function isValidIsbn10(value: string): boolean {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = value[i];
    sum += (ch === 'X' ? 10 : Number(ch)) * (10 - i);
  }
  return sum % 11 === 0;
}

function stripMarkup(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;|&zwnj;|&#8203;/gi, ' ');
}
