import { describe, expect, it } from 'vitest'
import { sanitizeThemeCss } from './theme-tokens'

describe('theme stylesheet sanitizer', () => {
  it('keeps only allowed design tokens with plain values', () => {
    const { tokens, ignored } = sanitizeThemeCss(`
      /* a comment with --accent: red */
      :root {
        --canvas: #101014;
        --accent: rgb(224 164 88 / 90%);
        --shadow-md: 0 8px 24px rgb(0 0 0 / 32%);
        --text: white !important;
      }
      :root[data-theme='light'] { --canvas: #fafafa; }
      .sidebar { background: red; --not-a-token: 1px; }
    `)
    expect(tokens).toEqual({
      '--canvas': '#fafafa',
      '--accent': 'rgb(224 164 88 / 90%)',
      '--shadow-md': '0 8px 24px rgb(0 0 0 / 32%)',
      '--text': 'white'
    })
    expect(ignored).toBe(1)
  })

  it('drops values that could load or reference anything', () => {
    const { tokens, ignored } = sanitizeThemeCss(`
      :root {
        --canvas: url(https://example.com/a.png);
        --raised: var(--canvas);
        --line: image-set("a.png" 1x);
        --muted: expression(alert(1));
        --chip: #fff</style><script>;
        --text: "quoted";
      }
    `)
    expect(tokens).toEqual({})
    expect(ignored).toBe(6)
  })
})
