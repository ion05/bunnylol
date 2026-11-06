/**
 * The Amazon → Goodreads button is only as good as the ISBN it reads. A match
 * on a carousel ASIN, or a miss on the labelled product-details fields, is the
 * bug a user would notice: the wrong book, or no button.
 */

import { describe, expect, it } from 'vitest';
import {
  asinFromPath,
  extractIsbn,
  goodreadsUrlForIsbn,
  goodreadsUrlForPage,
  isAmazonProductPath,
} from '../src/lib/amazon-book';

const DETAILS = `
<div id="detailBullets_feature_div">
  <li><span class="a-text-bold">ISBN-10<!-- -->: </span><span>0593135202</span></li>
  <li><span class="a-text-bold">ISBN-13<!-- -->: </span><span>978-0593135204</span></li>
</div>`;

describe('extractIsbn', () => {
  it('reads ISBN-13 out of Amazon product-details markup', () => {
    expect(extractIsbn(DETAILS)).toBe('9780593135204');
  });

  it('prefers ISBN-13 when both labelled fields are present', () => {
    expect(extractIsbn(DETAILS)).not.toBe('0593135202');
  });

  it('survives the RTL marks Amazon inserts between the label and the number', () => {
    const html = '<span>ISBN-13 \u200F : \u200E 978-0593135204</span>';
    expect(extractIsbn(html)).toBe('9780593135204');
  });

  it('falls back to ISBN-10 when there is no ISBN-13', () => {
    const html = '<span class="a-text-bold">ISBN-10:</span><span>0593135202</span>';
    expect(extractIsbn(html)).toBe('0593135202');
  });

  it('reads isbn off JSON-LD', () => {
    const html = `<script type="application/ld+json">{"@type":"Book","isbn":"9780593135204"}</script>`;
    expect(extractIsbn(html)).toBe('9780593135204');
  });

  it('keeps looking past a first ISBN-13 label with no number near it', () => {
    // The attribute carousel names the label before the product details do,
    // and on a live page its value is not always within reach of the label.
    const html = `<span>ISBN-13</span>${'<i></i>'.repeat(100)}${DETAILS}`;
    expect(extractIsbn(html)).toBe('9780593135204');
  });

  it('rejects a number that fails the ISBN check digit', () => {
    expect(extractIsbn('<span>ISBN-13: 978-0593135205</span>')).toBeNull();
  });

  it('does not treat a neighbouring 13-digit run as an ISBN', () => {
    const html = '<div>ASIN 0593135202 · 1234567890123 units sold</div>';
    expect(extractIsbn(html)).toBeNull();
  });
});

describe('isAmazonProductPath', () => {
  it('accepts /dp/ and the older product paths', () => {
    expect(isAmazonProductPath('/Project-Hail-Mary-Andy-Weir/dp/0593135202')).toBe(true);
    expect(isAmazonProductPath('/gp/product/0593135202')).toBe(true);
    expect(isAmazonProductPath('/s?k=usb+c+hub')).toBe(false);
  });
});

describe('goodreadsUrlForPage', () => {
  const AUDIBLE = '<div id="bookDescription_feature_div"></div><span>ASIN: B0G3B3ZKY8</span>';

  it('uses the ISBN on the page when there is one', () => {
    expect(goodreadsUrlForPage('/Book/dp/B08FHBV4ZX', DETAILS)).toBe(
      'https://www.goodreads.com/book/isbn/9780593135204',
    );
  });

  it('falls back to the ASIN on a book page with no ISBN (Audible, many Kindle editions)', () => {
    expect(goodreadsUrlForPage('/Book-Elon/dp/B0G3B3ZKY8/ref=sr_1_1', AUDIBLE)).toBe(
      'https://www.goodreads.com/book/isbn/B0G3B3ZKY8',
    );
  });

  it('treats an ASIN that is a valid ISBN-10 as a book', () => {
    expect(goodreadsUrlForPage('/dp/0593135202', '<div></div>')).toBe(
      'https://www.goodreads.com/book/isbn/0593135202',
    );
  });

  it('leaves a product that is not a book alone', () => {
    expect(
      goodreadsUrlForPage('/USB-C-Hub/dp/B0BQLLB61B', '<div id="feature-bullets"></div>'),
    ).toBeNull();
    expect(goodreadsUrlForPage('/s', AUDIBLE)).toBeNull();
  });
});

describe('asinFromPath', () => {
  it('reads the ASIN out of every product path shape, locale prefix included', () => {
    expect(asinFromPath('/-/es/Book-Elon/dp/154455074X')).toBe('154455074X');
    expect(asinFromPath('/gp/product/b08fhbv4zx?psc=1')).toBe('B08FHBV4ZX');
    expect(asinFromPath('/gp/aw/d/0593135202')).toBe('0593135202');
    expect(asinFromPath('/s?k=books')).toBeNull();
  });
});

describe('goodreadsUrlForIsbn', () => {
  it('lands on Goodreads isbn lookup, which redirects to the book page', () => {
    expect(goodreadsUrlForIsbn('9780593135204')).toBe(
      'https://www.goodreads.com/book/isbn/9780593135204',
    );
  });
});
