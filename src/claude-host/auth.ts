/** Extract the official browser authorization URL printed by the bundled Claude executable. */
export function officialAuthUrl(output: string): string | undefined {
  return output.match(
    /https:\/\/(?:claude\.com|claude\.ai|console\.anthropic\.com|platform\.claude\.com)\/[^\s\x1b]+/
  )?.[0]
}
