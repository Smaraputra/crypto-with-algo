export function marketProblemText(code: string | undefined): string {
  switch (code) {
    case 'venue_unreachable':
      return 'the exchange could not be reached';
    case 'venue_rate_limited':
      return 'the exchange is rate limiting requests';
    case 'unknown_symbol':
      return 'this perpetual is not trading';
    case 'rate_limited':
      return 'too many checks in a minute, try again shortly';
    default:
      return 'the request failed';
  }
}
