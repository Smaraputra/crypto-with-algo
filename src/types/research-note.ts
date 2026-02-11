import { z } from 'zod';

export const RESEARCH_NOTE_CATEGORIES = [
  'strategy',
  'concept',
  'rule',
  'checklist',
  'observation',
] as const;

export type ResearchNoteCategory = (typeof RESEARCH_NOTE_CATEGORIES)[number];

export interface ResearchNote {
  _id: string;
  userId: string;
  title: string;
  content: string;
  category: ResearchNoteCategory;
  tags: string[];
  relatedSymbols: string[];
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export const createResearchNoteSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(50000).optional(),
  category: z.enum(RESEARCH_NOTE_CATEGORIES),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  relatedSymbols: z.array(z.string().min(1).max(20)).max(10).optional(),
  isPinned: z.boolean().optional(),
});

export const updateResearchNoteSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(50000).optional(),
  category: z.enum(RESEARCH_NOTE_CATEGORIES).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  relatedSymbols: z.array(z.string().min(1).max(20)).max(10).optional(),
  isPinned: z.boolean().optional(),
});

export type CreateResearchNoteInput = z.infer<typeof createResearchNoteSchema>;
export type UpdateResearchNoteInput = z.infer<typeof updateResearchNoteSchema>;

export interface ResearchNoteListResponse {
  notes: ResearchNote[];
  total: number;
  page: number;
  totalPages: number;
}
