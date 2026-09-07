/**
 * The Amazon → Goodreads button is only as good as the ISBN it reads. A match
 * on a carousel ASIN, or a miss on the labelled product-details fields, is the
 * bug a user would notice: the wrong book, or no button.
 */

import { describe, expect, it } from 'vitest';
import { extractIsbn, goodreadsUrlForIsbn, isAmazonProductPath } from '../src/lib/amazon-book';

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

describe('goodreadsUrlForIsbn', () => {
  it('lands on Goodreads isbn lookup, which redirects to the book page', () => {
    expect(goodreadsUrlForIsbn('9780593135204')).toBe(
      'https://www.goodreads.com/book/isbn/9780593135204',
    );
  });
});
