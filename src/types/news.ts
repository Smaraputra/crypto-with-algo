export interface CryptoNewsItem {
  id: string;
  title: string;
  url: string;
  source: string;
  body: string;
  categories: string;
  publishedOn: number;
  imageUrl: string | null;
}

export interface CryptoNewsResponse {
  articles: CryptoNewsItem[];
}
