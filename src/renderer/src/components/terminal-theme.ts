import type { ITheme } from '@xterm/xterm'

export const TERMINAL_THEMES: Record<'dark' | 'light', ITheme> = {
  dark: {
    background: '#121212',
    foreground: '#d7d7db',
    cursor: '#6685ee',
    selectionBackground: '#354675'
  },
  light: {
    background: '#f3f3f2',
    foreground: '#242629',
    cursor: '#365bc5',
    cursorAccent: '#fafaf9',
    selectionBackground: '#c8d5f4',
    black: '#242629',
    red: '#b42335',
    green: '#246b38',
    yellow: '#875600',
    blue: '#305bc4',
    magenta: '#853da1',
    cyan: '#096d7a',
    white: '#646970',
    brightBlack: '#646970',
    brightRed: '#b42335',
    brightGreen: '#246b38',
    brightYellow: '#875600',
    brightBlue: '#305bc4',
    brightMagenta: '#853da1',
    brightCyan: '#096d7a',
    brightWhite: '#383b40'
  }
}
