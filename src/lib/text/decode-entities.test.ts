import { describe, it, expect } from 'vitest';
import { decodeHtmlEntities } from './decode-entities';

describe('decodeHtmlEntities', () => {
  it('decodes the brief example: "Bitcoin in &#39;Wait&#39; &amp; see" becomes "Bitcoin in \'Wait\' & see"', () => {
    expect(decodeHtmlEntities("Bitcoin in &#39;Wait&#39; &amp; see")).toBe(
      "Bitcoin in 'Wait' & see"
    );
  });

  it('decodes all required named entities', () => {
    expect(decodeHtmlEntities('&amp;')).toBe('&');
    expect(decodeHtmlEntities('&lt;')).toBe('<');
    expect(decodeHtmlEntities('&gt;')).toBe('>');
    expect(decodeHtmlEntities('&quot;')).toBe('"');
    expect(decodeHtmlEntities('&apos;')).toBe("'");
    expect(decodeHtmlEntities('&nbsp;')).toBe('\u00A0');
  });

  it('decodes decimal numeric character references', () => {
    expect(decodeHtmlEntities('&#39;')).toBe("'");
    expect(decodeHtmlEntities('&#34;')).toBe('"');
    expect(decodeHtmlEntities('&#60;')).toBe('<');
    expect(decodeHtmlEntities('&#62;')).toBe('>');
    expect(decodeHtmlEntities('&#160;')).toBe('\u00A0');
  });

  it('decodes hexadecimal numeric character references', () => {
    expect(decodeHtmlEntities('&#x27;')).toBe("'");
    expect(decodeHtmlEntities('&#x22;')).toBe('"');
    expect(decodeHtmlEntities('&#x3c;')).toBe('<');
    expect(decodeHtmlEntities('&#x3E;')).toBe('>');
    expect(decodeHtmlEntities('&#xa0;')).toBe('\u00A0');
  });

  it('handles mixed strings with markup-like characters without evaluating them as HTML', () => {
    const raw = '&lt;script&gt;alert(&quot;test&quot;)&lt;/script&gt;';
    expect(decodeHtmlEntities(raw)).toBe('<script>alert("test")</script>');
  });

  it('leaves unrecognized entities and bare ampersands intact', () => {
    expect(decodeHtmlEntities('A & B')).toBe('A & B');
    expect(decodeHtmlEntities('&foo;')).toBe('&foo;');
  });

  it('returns empty string for empty input', () => {
    expect(decodeHtmlEntities('')).toBe('');
  });
});
